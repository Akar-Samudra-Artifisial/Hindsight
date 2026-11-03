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

type Method = 'GET' | 'POST';
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

/** Numeric Jira ids only: they are inlined into JQL `id in (...)`. */
const numericIds = (ids: readonly string[]): string[] => [...new Set(ids.filter((id) => /^[0-9]{1,18}$/.test(id)))];

export const jira = {
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
};

export type JiraClient = typeof jira;

/** `https://site.atlassian.net/rest/api/3/issue/1` → `https://site.atlassian.net`. */
export function siteBaseFromSelf(self: string | undefined): string | null {
  if (!self) return null;
  try {
    return new URL(self).origin;
  } catch {
    return null;
  }
}
