import api, { route, type APIResponse, type Route } from '@forge/api';

/** Jira replied with a non-2xx status. Messages carry Jira's error text only, never artifact content. */
export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type As = 'app' | 'user';

function messageOf(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string>; message?: string };
    const parts = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${v}`), body.message].filter(Boolean);
    if (parts.length) return `Jira ${status}: ${parts.join('; ')}`.slice(0, 500);
  } catch {
    // not JSON
  }
  return `Jira ${status}: ${text.slice(0, 200) || 'no body'}`;
}

async function request<T>(as: As, method: Method, path: Route, body?: unknown): Promise<T> {
  const client = as === 'user' ? api.asUser() : api.asApp();
  const res: APIResponse = await client.requestJira(path, {
    method,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new JiraError(res.status, messageOf(res.status, text));
  return (text ? JSON.parse(text) : undefined) as T;
}

export function isJiraRateLimited(err: unknown): boolean {
  return err instanceof JiraError && err.status === 429;
}

export interface RawComment {
  id: string;
  author?: { accountId?: string };
  body?: unknown;
  created?: string;
  updated?: string;
  /** Set when the comment is restricted to a project role or group (same shape in search and `/comment`). */
  visibility?: { type?: string; value?: string; identifier?: string } | null;
  /** JSM: false for internal comments (not shared with the customer). */
  jsdPublic?: boolean;
}

export interface RawIssue {
  id: string;
  key: string;
  self?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    created?: string;
    updated?: string;
    project?: { key?: string; projectTypeKey?: string };
    issuetype?: { name?: string };
    components?: { name?: string }[];
    labels?: string[];
    status?: { statusCategory?: { key?: string } };
    resolution?: { name?: string } | null;
    reporter?: { accountId?: string } | null;
    priority?: { name?: string } | null;
    resolutiondate?: string | null;
    comment?: { comments?: RawComment[]; total?: number; maxResults?: number; startAt?: number };
  };
}

export const COLLECT_FIELDS = [
  'summary',
  'description',
  'created',
  'updated',
  'project',
  'issuetype',
  'components',
  'labels',
  'status',
  'resolution',
  'reporter',
  'comment',
] as const;

const INCIDENT_FIELDS = 'summary,description,created,project,components,priority,resolutiondate,status';

/** Atlassian Document Format document (issue description or comment body). */
export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: unknown[];
}

export interface IssueTypeMeta {
  id: string;
  name: string;
  subtask?: boolean;
}

export interface ProjectInfo {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
}

export interface NewIssue {
  summary: string;
  description: AdfDoc;
  labels: string[];
}

export interface CreatedIssue {
  id: string;
  key: string;
}

const issueFields = (projectKey: string, typeId: string, n: NewIssue) => ({
  project: { key: projectKey },
  issuetype: { id: typeId },
  summary: n.summary,
  description: n.description,
  labels: n.labels,
});

/** Numeric Jira ids only: they are inlined into JQL `id in (...)`. */
const numericIds = (ids: readonly string[]): string[] => [...new Set(ids.filter((id) => /^[0-9]{1,18}$/.test(id)))];

export interface RawTransition {
  id: string;
  name?: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

export const MAX_TRANSITION_HOPS = 2;

export type TransitionResult =
  | { closed: true; status: string; resolution: string | null; path: string[] }
  | { closed: false; path: string[]; available: string[] };
const PREFER_TRANSITION = /resolv|done|close|complet/i;
const AVOID_TRANSITION = /cancel|reject|declin|won'?t/i;
const transitionLabel = (t: RawTransition): string => `${t.name ?? ''} → ${t.to?.name ?? ''}`;

/**
 * A transition into the Done category. With `preferResolved`: a resolve/done/close/complete one first, never a
 * cancel/reject/decline/won't one when another Done transition exists. Otherwise the first Done transition.
 */
export function pickDoneTransition(transitions: readonly RawTransition[], preferResolved: boolean): RawTransition | undefined {
  const done = transitions.filter((t) => t.to?.statusCategory?.key === 'done');
  if (!preferResolved) return done[0];
  const acceptable = done.filter((t) => !AVOID_TRANSITION.test(transitionLabel(t)));
  return acceptable.find((t) => PREFER_TRANSITION.test(transitionLabel(t))) ?? acceptable[0] ?? done[0];
}

export const jira = {
  /**
   * Browser base URL of the site (`https://<site>.atlassian.net`) from `serverInfo.baseUrl`; null when it fails.
   * `self` links of asApp responses point at `api.atlassian.com`, so they cannot be used for links. Not cached at
   * module level (a warm runtime could serve another installation); callers memoise per invocation.
   */
  async siteUrl(): Promise<string | null> {
    try {
      const info = await request<{ baseUrl?: string }>('app', 'GET', route`/rest/api/3/serverInfo`);
      return siteBaseFromSelf(info.baseUrl);
    } catch (err) {
      if (isJiraRateLimited(err)) throw err;
      console.warn('jira serverInfo failed, Jira links omitted', { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      return null;
    }
  },

  /** One page of the enhanced JQL search as the app (paginated by `nextPageToken`). */
  async searchPage(
    jql: string,
    nextPageToken: string | undefined,
    fields: readonly string[] = COLLECT_FIELDS,
    maxResults = 50,
  ): Promise<{ issues: RawIssue[]; nextPageToken?: string }> {
    const body = await request<{ issues?: RawIssue[]; nextPageToken?: string }>('app', 'POST', route`/rest/api/3/search/jql`, {
      jql,
      fields,
      maxResults,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    return { issues: body.issues ?? [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) };
  },

  /** Comments of an issue as the app, oldest first. */
  async listComments(issueId: string, startAt = 0, maxResults = 100): Promise<{ comments: RawComment[]; total: number }> {
    const body = await request<{ comments?: RawComment[]; total?: number }>(
      'app',
      'GET',
      route`/rest/api/3/issue/${issueId}/comment?startAt=${String(startAt)}&maxResults=${String(maxResults)}&orderBy=created`,
    );
    const comments = body.comments ?? [];
    return { comments, total: body.total ?? comments.length };
  },

  /** The incident as the current user sees it; undefined when it does not exist or they cannot view it. */
  async getIncidentAsUser(key: string): Promise<RawIssue | undefined> {
    try {
      return await request<RawIssue>('user', 'GET', route`/rest/api/3/issue/${key}?fields=${INCIDENT_FIELDS}`);
    } catch (err) {
      if (err instanceof JiraError && (err.status === 404 || err.status === 403 || err.status === 401)) return undefined;
      throw err;
    }
  },

  /** Issue property value as the app; undefined when the property is not set. */
  async getIssueProperty(key: string, property: string): Promise<unknown> {
    try {
      const body = await request<{ value?: unknown }>('app', 'GET', route`/rest/api/3/issue/${key}/properties/${property}`);
      return body.value;
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return undefined;
      throw err;
    }
  },

  /** Ids of `ids` the current user can see (JQL `id in (...)`, 100 per call). Resolvers and actions only. */
  async visibleIssueIds(ids: readonly string[]): Promise<Set<string>> {
    const visible = new Set<string>();
    const all = numericIds(ids);
    for (let i = 0; i < all.length; i += 100) {
      const batch = all.slice(i, i + 100);
      const body = await request<{ issues?: { id: string }[] }>('user', 'POST', route`/rest/api/3/search/jql`, {
        jql: `id in (${batch.join(',')})`,
        fields: ['key'],
        maxResults: 100,
      });
      for (const issue of body.issues ?? []) visible.add(String(issue.id));
    }
    return visible;
  },

  // --- Demo seed and admin checks -------------------------------------------------------------

  /** True when the current user holds the global Jira ADMINISTER permission (checks only themselves). */
  async isAdminAsUser(): Promise<boolean> {
    const body = await request<{ permissions?: Record<string, { havePermission?: boolean }> }>(
      'user',
      'GET',
      route`/rest/api/3/mypermissions?permissions=ADMINISTER`,
    );
    return body.permissions?.['ADMINISTER']?.havePermission === true;
  },

  /** Undefined when the project does not exist (or the app cannot see it). */
  async getProject(key: string): Promise<ProjectInfo | undefined> {
    try {
      const p = await request<{ id: string | number; key: string; name: string; projectTypeKey?: string }>('app', 'GET', route`/rest/api/3/project/${key}`);
      return { id: String(p.id), key: p.key, name: p.name, projectTypeKey: p.projectTypeKey ?? 'software' };
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return undefined;
      throw err;
    }
  },

  /** Creates a company-managed project from a template, led by `leadAccountId` (demo seed only). */
  async createProject(input: {
    key: string;
    name: string;
    description: string;
    projectTypeKey: 'software' | 'service_desk';
    projectTemplateKey: string;
    leadAccountId: string;
  }): Promise<{ id: string; key: string }> {
    const created = await request<{ id: number | string; key: string }>('app', 'POST', route`/rest/api/3/project`, {
      key: input.key,
      name: input.name,
      description: input.description,
      projectTypeKey: input.projectTypeKey,
      projectTemplateKey: input.projectTemplateKey,
      leadAccountId: input.leadAccountId,
      assigneeType: 'UNASSIGNED',
    });
    return { id: String(created.id), key: created.key };
  },

  /** Issue types that can be created in the project (subtasks excluded). */
  async issueTypes(projectKey: string): Promise<IssueTypeMeta[]> {
    const body = await request<{ issueTypes?: IssueTypeMeta[]; values?: IssueTypeMeta[] }>(
      'app',
      'GET',
      route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`,
    );
    return (body.issueTypes ?? body.values ?? []).filter((t) => !t.subtask).map((t) => ({ id: String(t.id), name: t.name }));
  },

  /**
   * Creates issues in bulk (50 per request). Returns one entry per input, in order: the created issue, or undefined
   * when Jira rejected that element. Only throws when the whole request fails.
   */
  async bulkCreateIssues(projectKey: string, typeId: string, items: readonly NewIssue[]): Promise<(CreatedIssue | undefined)[]> {
    const out: (CreatedIssue | undefined)[] = [];
    for (let i = 0; i < items.length; i += 50) {
      const batch = items.slice(i, i + 50);
      const res = await request<{ issues?: { id: string | number; key: string }[]; errors?: { failedElementNumber?: number; elementErrors?: unknown }[] }>(
        'app',
        'POST',
        route`/rest/api/3/issue/bulk`,
        { issueUpdates: batch.map((n) => ({ fields: issueFields(projectKey, typeId, n) })) },
      );
      const failed = new Set((res.errors ?? []).map((e) => e.failedElementNumber).filter((n): n is number => typeof n === 'number'));
      const created = [...(res.issues ?? [])];
      for (let j = 0; j < batch.length; j += 1) {
        const issue = failed.has(j) ? undefined : created.shift();
        out.push(issue ? { id: String(issue.id), key: issue.key } : undefined);
      }
      if (res.errors?.length) console.warn('jira bulk create: elements rejected', { projectKey, rejected: res.errors.length, first: JSON.stringify(res.errors[0]).slice(0, 300) });
    }
    return out;
  },

  async createIssue(projectKey: string, typeId: string, item: NewIssue): Promise<CreatedIssue> {
    const created = await request<{ id: string | number; key: string }>('app', 'POST', route`/rest/api/3/issue`, {
      fields: issueFields(projectKey, typeId, item),
    });
    return { id: String(created.id), key: created.key };
  },

  /** Adds a comment (ADF body) as the app; returns the comment id. */
  async addComment(key: string, body: AdfDoc): Promise<{ id: string }> {
    const created = await request<{ id: string | number }>('app', 'POST', route`/rest/api/3/issue/${key}/comment`, { body });
    return { id: String(created.id) };
  },

  /**
   * Moves the issue to a Done-category status, setting `resolutionName` when given; when Jira rejects the resolution
   * (400, e.g. not on the transition screen) it retries without it. `preferResolved` picks a Done transition named
   * like resolve/done/close/complete and avoids cancel/reject/decline/won't. When no Done transition is offered from
   * the current status it takes up to `MAX_TRANSITION_HOPS` intermediate (non-Done) transitions first. Returns the
   * status reached, the resolution actually set and the statuses passed; when no Done status is reachable,
   * `closed: false` with the transitions that were offered (for the log).
   */
  async transitionToDone(
    key: string,
    resolutionName?: string,
    opts: { preferResolved?: boolean } = {},
  ): Promise<TransitionResult> {
    const path: string[] = [];
    const visited = new Set<string>();
    for (let hop = 0; hop <= MAX_TRANSITION_HOPS; hop += 1) {
      const body = await request<{ transitions?: RawTransition[] }>('app', 'GET', route`/rest/api/3/issue/${key}/transitions`);
      const transitions = body.transitions ?? [];
      const done = pickDoneTransition(transitions, opts.preferResolved === true);
      if (done) {
        const status = done.to?.name ?? 'Done';
        if (resolutionName) {
          try {
            await request('app', 'POST', route`/rest/api/3/issue/${key}/transitions`, { transition: { id: done.id }, fields: { resolution: { name: resolutionName } } });
            return { closed: true, status, resolution: resolutionName, path };
          } catch (err) {
            if (!(err instanceof JiraError && err.status === 400)) throw err;
            console.warn('jira transition: resolution rejected, retrying without it', { key, resolutionName, error: err.message.slice(0, 200) });
          }
        }
        await request('app', 'POST', route`/rest/api/3/issue/${key}/transitions`, { transition: { id: done.id } });
        return { closed: true, status, resolution: null, path };
      }
      const step = hop < MAX_TRANSITION_HOPS ? transitions.find((t) => t.to?.name && !visited.has(t.to.name) && !AVOID_TRANSITION.test(transitionLabel(t))) : undefined;
      if (!step) return { closed: false, path, available: transitions.map(transitionLabel).slice(0, 10) };
      visited.add(step.to?.name ?? '');
      await request('app', 'POST', route`/rest/api/3/issue/${key}/transitions`, { transition: { id: step.id } });
      path.push(step.to?.name ?? step.id);
    }
    return { closed: false, path, available: [] };
  },

  async setIssueProperty(key: string, property: string, value: unknown): Promise<void> {
    await request('app', 'PUT', route`/rest/api/3/issue/${key}/properties/${property}`, value);
  },

  /** Deletes the issue (and its subtasks); a missing issue counts as deleted. */
  async deleteIssue(key: string): Promise<void> {
    try {
      await request('app', 'DELETE', route`/rest/api/3/issue/${key}?deleteSubtasks=true`);
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return;
      throw err;
    }
  },

  /** Number of issues matching `jql` (approximate count; may lag right after creation). */
  async countIssues(jql: string): Promise<number> {
    const body = await request<{ count?: number }>('app', 'POST', route`/rest/api/3/search/approximate-count`, { jql });
    return body.count ?? 0;
  },

  /** Issue id, key and site base URL as the app; undefined when the issue does not exist. */
  async getIssueSelf(key: string): Promise<{ id: string; key: string; siteUrl: string | null } | undefined> {
    try {
      const issue = await request<RawIssue>('app', 'GET', route`/rest/api/3/issue/${key}?fields=summary`);
      return { id: String(issue.id), key: issue.key, siteUrl: (await jira.siteUrl()) ?? siteBaseFromSelf(issue.self) };
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return undefined;
      throw err;
    }
  },
};

export type JiraClient = typeof jira;

/**
 * `https://site.atlassian.net/rest/api/3/issue/1` → `https://site.atlassian.net`. The API gateway host
 * (`api.atlassian.com`, used in asApp `self` links) is not a browser URL and gives null.
 */
export function siteBaseFromSelf(self: string | undefined): string | null {
  if (!self) return null;
  try {
    const url = new URL(self);
    if (url.hostname === 'api.atlassian.com') return null;
    return url.origin;
  } catch {
    return null;
  }
}
