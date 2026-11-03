import { randomUUID } from 'node:crypto';
import type { RawContent, SearchPage } from '../adapters/confluence';
import type { RawComment, RawIssue } from '../adapters/jira';
import { siteBaseFromSelf } from '../adapters/jira';
import type { AnalysisJob, CandidateInput, EventInput, EventRef, EventSource, JobPatch } from '../adapters/repo';
import { eventRefKey } from '../adapters/repo';
import { filterEvent, rankCandidates, MAX_CANDIDATES, type CollectedEvent, type IncidentContext } from './filter';
import { analyzeLock, ANALYZE_LOCK_SECONDS } from './jobs';
import { eventServiceKey, parseScope, type Scope } from './scope';
import { adfToText, hashText, normaliseText, storageToText } from './text';
import { parseIncidentKey, PROJECT_KEY, SPACE_KEY } from './validate';

/**
 * Collect step (resumable): pages through Jira/JSM issues (+ comments) and Confluence pages/comments of the job's
 * scope, stores event references (no text), and keeps deterministic candidates. The cursor lives in
 * `analysis_jobs.cursor_json` and is saved after every page, so a redelivery or a 429 never loses a page.
 */

export const COLLECT_PAGES_PER_RUN = 10;
export const COLLECT_BUDGET_MS = 8 * 60 * 1000;
export const MAX_ISSUES_PER_JOB = 500;
export const MAX_COMMENTS_PER_ISSUE = 100;
/** Search pages per source per job: 10 × 50 issues = `MAX_ISSUES_PER_JOB`; Confluence 10 × 50 results. */
export const MAX_JIRA_PAGES_PER_JOB = 10;
export const MAX_CONFLUENCE_PAGES_PER_JOB = 10;
const DAY = (iso: string) => iso.slice(0, 10);

export type CollectPhase = 'jira' | 'confluence' | 'done';

/** Issue whose comments did not all come with the search result; fetched with the comment endpoint. */
export interface PendingIssue {
  meta: IssueMeta;
}

/** Why a source stopped before its last page. */
export type SourceStop = 'issue_cap' | 'page_cap' | 'empty_page';

export interface CollectCursor {
  phase: CollectPhase;
  jiraNextPageToken?: string;
  confluenceCursor?: string;
  pendingComments: PendingIssue[];
  issuesSeen: number;
  /** Units of work done (search pages + comment fetches). */
  pages: number;
  jiraPages: number;
  confluencePages: number;
  truncated: { jira?: SourceStop; confluence?: SourceStop };
}

export interface CollectDeps {
  repo: {
    getJob(id: string): Promise<AnalysisJob | undefined>;
    updateJob(id: string, patch: JobPatch): Promise<number>;
    findEventsByRefs(refs: readonly EventRef[]): Promise<Map<string, { id: string; scenarioAt: string | null }>>;
    upsertEvents(events: readonly EventInput[]): Promise<number>;
    insertCandidates(candidates: readonly CandidateInput[]): Promise<number>;
    listCandidateRanks(jobId: string): Promise<{ id: string; eventId: string; filterScore: number; daysBefore: number }[]>;
    markCandidatesTruncated(jobId: string, ids: readonly string[]): Promise<number>;
    /** Pushes the lock's expiry to now + seconds (no-op when the lock row does not exist). */
    extendAppLock(name: string, nowIso: string, seconds: number): Promise<void>;
  };
  jira: {
    searchPage(jql: string, nextPageToken: string | undefined): Promise<{ issues: RawIssue[]; nextPageToken?: string }>;
    listComments(issueId: string, startAt: number, maxResults: number): Promise<{ comments: RawComment[]; total: number }>;
    /** Browser base URL of the site, or null when unknown. */
    siteUrl(): Promise<string | null>;
  };
  confluence: { searchContent(cql: string, cursor: string | undefined): Promise<SearchPage> };
  isRateLimited(err: unknown): boolean;
  now(): number;
  newId?: () => string;
}

export interface CollectCounts {
  scanned: number;
  stored: number;
  candidates: number;
  truncated: number;
}

export type CollectStepResult =
  | { status: 'more'; counts: CollectCounts; phase: CollectPhase }
  | { status: 'finalized'; counts: CollectCounts }
  | { status: 'rate_limited'; counts: CollectCounts; phase: CollectPhase }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string };

// --- Mapping source items to events ---------------------------------------------------------------

/** Event + text for one item; the text only lives in memory during the step. */
export interface CollectedItem {
  event: Omit<EventInput, 'id'> & { source: EventSource; commentId: string };
  text: string;
  isLastComment: boolean;
}

export interface IssueMeta {
  id: string;
  key: string;
  title: string;
  source: 'jira' | 'jsm';
  projectKey: string | null;
  componentNames: string[];
  labels: string[];
  statusCategory: string | null;
  resolutionName: string | null;
  base: string | null;
}

/** `siteUrl`: browser base URL of the site; the issue's `self` is only a fallback (asApp it points at the API gateway). */
export function issueMeta(issue: RawIssue, siteUrl: string | null = null): IssueMeta {
  const f = issue.fields ?? {};
  return {
    id: String(issue.id),
    key: issue.key,
    title: f.summary ?? '',
    source: f.project?.projectTypeKey === 'service_desk' ? 'jsm' : 'jira',
    projectKey: f.project?.key ?? null,
    componentNames: (f.components ?? []).flatMap((c) => (c.name ? [c.name] : [])),
    labels: f.labels ?? [],
    statusCategory: f.status?.statusCategory?.key ?? null,
    resolutionName: f.resolution?.name ?? null,
    base: siteUrl ?? siteBaseFromSelf(issue.self),
  };
}

export function issueItem(issue: RawIssue, meta: IssueMeta): CollectedItem | undefined {
  const f = issue.fields ?? {};
  if (!f.created) return undefined;
  const text = normaliseText(adfToText(f.description));
  return {
    event: {
      source: meta.source,
      kind: 'issue',
      artifactId: meta.id,
      commentId: '',
      artifactKey: meta.key,
      title: meta.title,
      url: meta.base ? `${meta.base}/browse/${meta.key}` : null,
      projectKey: meta.projectKey,
      componentNames: meta.componentNames,
      labels: meta.labels,
      authorAccountId: f.reporter?.accountId ?? null,
      occurredAt: new Date(f.created).toISOString(),
      sourceUpdatedAt: f.updated ? new Date(f.updated).toISOString() : null,
      textHash: hashText(`${meta.title}\n${text}`),
      textLength: text.length,
      replyCount: f.comment?.total ?? null,
      statusCategory: meta.statusCategory,
      resolutionName: meta.resolutionName,
    },
    text,
    isLastComment: false,
  };
}

/**
 * Comment restricted to a role/group, or internal on a service desk (`jsdPublic: false`). Collect runs as the app
 * while permissions are only checked per issue, so these are never stored or scored.
 */
export function isRestrictedComment(c: RawComment): boolean {
  return (c.visibility !== undefined && c.visibility !== null) || c.jsdPublic === false;
}

/**
 * Events for the unrestricted comments, oldest first, plus the number of restricted ones skipped.
 * `isLastComment`: nobody else commented afterwards; only decided when every comment of the issue is present
 * (`comments.length >= total`), otherwise a later comment may exist beyond the fetched page.
 */
export function commentItems(meta: IssueMeta, comments: readonly RawComment[], total = comments.length): { items: CollectedItem[]; restricted: number } {
  const ordered = [...comments].filter((c) => c.id && c.created).sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const complete = comments.length >= total;
  const items = ordered.flatMap((c, i): CollectedItem[] => {
    if (isRestrictedComment(c)) return [];
    const author = c.author?.accountId ?? null;
    // Restricted replies still count as an answer: they are only excluded from storage, not from the thread.
    const answered = ordered.slice(i + 1).some((later) => (later.author?.accountId ?? null) !== author);
    const text = normaliseText(adfToText(c.body));
    return [{
      event: {
        source: meta.source,
        kind: 'comment',
        artifactId: meta.id,
        commentId: String(c.id),
        artifactKey: meta.key,
        title: meta.title,
        url: meta.base ? `${meta.base}/browse/${meta.key}?focusedCommentId=${encodeURIComponent(String(c.id))}` : null,
        projectKey: meta.projectKey,
        componentNames: meta.componentNames,
        labels: meta.labels,
        authorAccountId: author,
        occurredAt: new Date(String(c.created)).toISOString(),
        sourceUpdatedAt: c.updated ? new Date(c.updated).toISOString() : null,
        textHash: hashText(text),
        textLength: text.length,
        replyCount: null,
        statusCategory: meta.statusCategory,
        resolutionName: meta.resolutionName,
      },
      text,
      isLastComment: !answered && complete,
    }];
  });
  return { items, restricted: comments.filter(isRestrictedComment).length };
}

export function confluenceItem(c: RawContent, base: string | null): CollectedItem | undefined {
  const isComment = c.type === 'comment';
  const createdAt = c.history?.createdDate ?? c.version?.when;
  if (!createdAt) return undefined;
  const containerId = c.container?.id !== undefined ? String(c.container.id) : '';
  if (isComment && containerId === '') return undefined;
  const text = normaliseText(storageToText(c.body?.storage?.value ?? ''));
  const title = (isComment ? c.container?.title : c.title) ?? c.title ?? '';
  return {
    event: {
      source: 'confluence',
      kind: isComment ? 'comment' : 'page',
      artifactId: isComment ? containerId : c.id,
      commentId: isComment ? c.id : '',
      artifactKey: null,
      title,
      url: base && c._links?.webui ? `${base}${c._links.webui}` : null,
      spaceKey: c.space?.key ?? null,
      authorAccountId: c.history?.createdBy?.accountId ?? null,
      occurredAt: new Date(createdAt).toISOString(),
      sourceUpdatedAt: c.version?.when ? new Date(c.version.when).toISOString() : null,
      textHash: hashText(isComment ? text : `${title}\n${text}`),
      textLength: text.length,
    },
    text,
    isLastComment: false,
  };
}

// --- Queries --------------------------------------------------------------------------------------

/**
 * Keys only reach JQL/CQL after a whitelist regex (no quotes, backslashes or spaces possible) and are then quoted.
 * The incident key is re-validated because the scope is read back from SQL.
 */
export function buildJql(scope: Scope): string | undefined {
  const projects = scope.jiraProjectKeys.filter((k) => PROJECT_KEY.test(k));
  if (projects.length === 0) return undefined;
  const incidentKey = parseIncidentKey(scope.incidentKey);
  return (
    `project in (${projects.map((k) => `"${k}"`).join(', ')}) AND updated >= "${DAY(scope.queryFrom)}" ` +
    `AND created <= "${DAY(scope.queryTo)}" AND key != "${incidentKey}" ORDER BY updated ASC`
  );
}

/** [VERIFY] CQL over `/wiki/rest/api/search` with `type in (page, comment)` is untested on the dev site. */
export function buildCql(scope: Scope): string | undefined {
  const spaces = scope.confluenceSpaceKeys.filter((k) => SPACE_KEY.test(k));
  if (spaces.length === 0) return undefined;
  return (
    `space in (${spaces.map((k) => `"${k}"`).join(', ')}) AND type in (page, comment) ` +
    `AND lastmodified >= "${DAY(scope.queryFrom)}" AND lastmodified <= "${DAY(scope.queryTo)}" ORDER BY lastmodified ASC`
  );
}

// --- Cursor ---------------------------------------------------------------------------------------

export function initialCursor(scope: Scope): CollectCursor {
  const phase: CollectPhase = buildJql(scope) ? 'jira' : buildCql(scope) ? 'confluence' : 'done';
  return { phase, pendingComments: [], issuesSeen: 0, pages: 0, jiraPages: 0, confluencePages: 0, truncated: {} };
}

export function parseCursor(raw: unknown, scope: Scope): CollectCursor {
  if (!raw || typeof raw !== 'object') return initialCursor(scope);
  const c = raw as Partial<CollectCursor>;
  const phase: CollectPhase = c.phase === 'jira' || c.phase === 'confluence' || c.phase === 'done' ? c.phase : 'jira';
  return {
    phase,
    ...(typeof c.jiraNextPageToken === 'string' ? { jiraNextPageToken: c.jiraNextPageToken } : {}),
    ...(typeof c.confluenceCursor === 'string' ? { confluenceCursor: c.confluenceCursor } : {}),
    pendingComments: Array.isArray(c.pendingComments) ? c.pendingComments.filter((p) => p && typeof p.meta?.id === 'string') : [],
    issuesSeen: typeof c.issuesSeen === 'number' ? c.issuesSeen : 0,
    pages: typeof c.pages === 'number' ? c.pages : 0,
    jiraPages: typeof c.jiraPages === 'number' ? c.jiraPages : 0,
    confluencePages: typeof c.confluencePages === 'number' ? c.confluencePages : 0,
    truncated: c.truncated && typeof c.truncated === 'object' ? { ...c.truncated } : {},
  };
}

const afterJira = (scope: Scope): CollectPhase => (buildCql(scope) ? 'confluence' : 'done');

// --- Step -----------------------------------------------------------------------------------------

function incidentContext(scope: Scope): IncidentContext {
  return {
    serviceKey: scope.serviceKey,
    componentNames: scope.componentNames,
    keywords: scope.keywords,
    windowFrom: scope.windowFrom,
    windowTo: scope.windowTo,
    effectiveStart: scope.windowTo,
  };
}

interface Totals {
  scanned: number;
  stored: number;
  candidates: number;
}

/** Stores the in-window items of one page and keeps the ones that pass the filter. */
async function processItems(job: AnalysisJob, scope: Scope, items: readonly CollectedItem[], deps: CollectDeps): Promise<Totals> {
  if (items.length === 0) return { scanned: 0, stored: 0, candidates: 0 };
  const existing = await deps.repo.findEventsByRefs(items.map((i) => i.event));
  const from = new Date(scope.windowFrom).getTime();
  const to = new Date(scope.windowTo).getTime();
  const ctx = incidentContext(scope);
  const events: EventInput[] = [];
  const candidates: CandidateInput[] = [];
  for (const item of items) {
    const known = existing.get(eventRefKey(item.event));
    const effectiveAt = known?.scenarioAt ?? item.event.occurredAt;
    const at = new Date(effectiveAt).getTime();
    if (!(at >= from && at < to)) continue;
    const id = known?.id ?? (deps.newId ?? randomUUID)();
    const serviceKey = eventServiceKey(scope.services, item.event);
    events.push({ ...item.event, id, serviceKey });
    const collected: CollectedEvent = {
      eventId: id,
      source: item.event.source,
      kind: item.event.kind,
      title: item.event.title,
      text: item.text,
      projectKey: item.event.projectKey ?? null,
      spaceKey: item.event.spaceKey ?? null,
      componentNames: item.event.componentNames ?? [],
      labels: item.event.labels ?? [],
      serviceKey,
      effectiveAt,
      replyCount: item.event.replyCount ?? null,
      statusCategory: item.event.statusCategory ?? null,
      resolutionName: item.event.resolutionName ?? null,
      authorId: item.event.authorAccountId ?? null,
      isLastComment: item.isLastComment,
    };
    const draft = filterEvent(collected, ctx);
    if (draft) {
      candidates.push({
        jobId: job.id,
        incidentKey: job.incidentKey,
        eventId: id,
        filterScore: draft.filterScore,
        reasons: draft.reasons,
        matchedKeywords: draft.matchedKeywords,
        hintType: draft.hintType,
        excerpt: draft.excerpt,
        textHash: item.event.textHash ?? null,
        daysBefore: draft.daysBefore,
      });
    }
  }
  if (events.length > 0) await deps.repo.upsertEvents(events);
  if (candidates.length > 0) await deps.repo.insertCandidates(candidates);
  return { scanned: items.length, stored: events.length, candidates: candidates.length };
}

const NO_TOTALS: Totals = { scanned: 0, stored: 0, candidates: 0 };
const withRestricted = (t: Totals, restricted: number): Totals => ({ ...t, scanned: t.scanned + restricted });

/** Fetches and processes one unit of work (pending comments, a Jira page or a Confluence page); returns the new cursor. */
async function collectUnit(job: AnalysisJob, scope: Scope, cursor: CollectCursor, deps: CollectDeps): Promise<{ cursor: CollectCursor; totals: Totals }> {
  const [pending, ...rest] = cursor.pendingComments;
  if (pending) {
    const page = await deps.jira.listComments(pending.meta.id, 0, MAX_COMMENTS_PER_ISSUE);
    // A cursor saved before the site URL fix may still carry the API gateway base.
    const siteUrl = await deps.jira.siteUrl();
    const meta = siteUrl ? { ...pending.meta, base: siteUrl } : pending.meta;
    const { items, restricted } = commentItems(meta, page.comments, page.total);
    const totals = withRestricted(await processItems(job, scope, items, deps), restricted);
    return { cursor: { ...cursor, pendingComments: rest, pages: cursor.pages + 1 }, totals };
  }
  if (cursor.phase === 'jira') {
    const jql = buildJql(scope);
    const { jiraNextPageToken: _token, ...base } = cursor;
    if (!jql) return { cursor: { ...base, phase: afterJira(scope) }, totals: NO_TOTALS };
    const page = await deps.jira.searchPage(jql, cursor.jiraNextPageToken);
    const siteUrl = await deps.jira.siteUrl();
    const room = MAX_ISSUES_PER_JOB - cursor.issuesSeen;
    const issues = page.issues.slice(0, Math.max(0, room));
    const items: CollectedItem[] = [];
    const pendingNext: PendingIssue[] = [];
    let restricted = 0;
    for (const issue of issues) {
      const meta = issueMeta(issue, siteUrl);
      const item = issueItem(issue, meta);
      if (item) items.push(item);
      const comment = issue.fields?.comment;
      const inline = comment?.comments ?? [];
      // [VERIFY] the search `comment` field carries `total`; when it holds fewer than total, fetch them all later.
      const total = comment?.total ?? inline.length;
      if (total > inline.length) pendingNext.push({ meta });
      else {
        const c = commentItems(meta, inline, total);
        items.push(...c.items);
        restricted += c.restricted;
      }
    }
    const totals = withRestricted(await processItems(job, scope, items, deps), restricted);
    const issuesSeen = cursor.issuesSeen + issues.length;
    const jiraPages = cursor.jiraPages + 1;
    const hasMore = page.nextPageToken !== undefined;
    const stop: SourceStop | undefined =
      issuesSeen >= MAX_ISSUES_PER_JOB && (hasMore || page.issues.length > issues.length)
        ? 'issue_cap'
        : hasMore && page.issues.length === 0
          ? 'empty_page'
          : hasMore && jiraPages >= MAX_JIRA_PAGES_PER_JOB
            ? 'page_cap'
            : undefined;
    const goOn = hasMore && stop === undefined;
    const next: CollectCursor = {
      ...base,
      phase: goOn ? 'jira' : afterJira(scope),
      pendingComments: pendingNext,
      issuesSeen,
      jiraPages,
      pages: cursor.pages + 1,
      ...(goOn && page.nextPageToken ? { jiraNextPageToken: page.nextPageToken } : {}),
      truncated: stop ? { ...cursor.truncated, jira: stop } : cursor.truncated,
    };
    return { cursor: next, totals };
  }
  if (cursor.phase === 'confluence') {
    const cql = buildCql(scope);
    const { confluenceCursor: _cursor, ...base } = cursor;
    if (!cql) return { cursor: { ...base, phase: 'done' }, totals: NO_TOTALS };
    const page = await deps.confluence.searchContent(cql, cursor.confluenceCursor);
    const items = page.results.flatMap((c) => {
      const item = confluenceItem(c, page.base);
      return item ? [item] : [];
    });
    const totals = await processItems(job, scope, items, deps);
    const confluencePages = cursor.confluencePages + 1;
    const hasMore = page.nextCursor !== undefined;
    const stop: SourceStop | undefined =
      hasMore && page.results.length === 0 ? 'empty_page' : hasMore && confluencePages >= MAX_CONFLUENCE_PAGES_PER_JOB ? 'page_cap' : undefined;
    const goOn = hasMore && stop === undefined;
    const next: CollectCursor = {
      ...base,
      phase: goOn ? 'confluence' : 'done',
      confluencePages,
      pages: cursor.pages + 1,
      ...(goOn && page.nextCursor ? { confluenceCursor: page.nextCursor } : {}),
      truncated: stop ? { ...cursor.truncated, confluence: stop } : cursor.truncated,
    };
    return { cursor: next, totals };
  }
  return { cursor, totals: NO_TOTALS };
}

const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 1024);

const progressOf = (cursor: CollectCursor, counts: Totals) => ({
  collect: {
    phase: cursor.phase,
    pages: cursor.pages,
    processed: counts.scanned,
    stored: counts.stored,
    issues: cursor.issuesSeen,
    ...(Object.keys(cursor.truncated).length > 0 ? { truncated: cursor.truncated } : {}),
  },
});

/** Ranks the job's candidates, truncates beyond `MAX_CANDIDATES`, and moves the job to `scoring`. Idempotent. */
export async function finalizeCollect(job: AnalysisJob, cursor: CollectCursor, deps: CollectDeps, counts: Totals): Promise<CollectCounts> {
  await deps.repo.updateJob(job.id, { status: 'filtering', cursor: { ...cursor, phase: 'done' } });
  const ranked = rankCandidates(await deps.repo.listCandidateRanks(job.id), MAX_CANDIDATES);
  if (ranked.truncated.length > 0) await deps.repo.markCandidatesTruncated(job.id, ranked.truncated.map((c) => c.id));
  const final: CollectCounts = { scanned: counts.scanned, stored: counts.stored, candidates: ranked.kept.length, truncated: ranked.truncated.length };
  await deps.repo.updateJob(job.id, {
    status: 'scoring',
    cursor: { ...cursor, phase: 'done' },
    candidateCount: final.candidates,
    truncatedCount: final.truncated,
    progress: { ...progressOf({ ...cursor, phase: 'done' }, counts), filter: { candidates: final.candidates, truncated: final.truncated } },
  });
  return final;
}

const failStep = async (job: AnalysisJob, deps: CollectDeps, err: unknown): Promise<CollectStepResult> => {
  const error = errorText(err);
  await deps.repo.updateJob(job.id, { status: 'failed', lastError: error, finishedAt: new Date(deps.now()).toISOString() });
  return { status: 'failed', error };
};

/**
 * One consumer invocation: up to `maxPages` units or until `deadline`. Saves cursor + counters after every unit.
 * Never throws for source errors: 429 → `rate_limited` (cursor kept), anything else → job `failed`. A job left in
 * `filtering` (finalize died midway) is finalized again on redelivery.
 */
export async function runCollectStep(
  jobId: string,
  deps: CollectDeps,
  budget: { maxPages: number; deadline: number } = { maxPages: COLLECT_PAGES_PER_RUN, deadline: Date.now() + COLLECT_BUDGET_MS },
): Promise<CollectStepResult> {
  const job = await deps.repo.getJob(jobId);
  if (!job) return { status: 'skipped', reason: 'job not found' };
  if (job.status !== 'queued' && job.status !== 'collecting' && job.status !== 'filtering') return { status: 'skipped', reason: `job is ${job.status}` };

  let scope: Scope;
  try {
    scope = parseScope(job.scope);
    parseIncidentKey(scope.incidentKey);
  } catch (err) {
    return failStep(job, deps, err);
  }
  // Keep the incident's analyze lock alive while the job is still running.
  await deps.repo.extendAppLock(analyzeLock(job.incidentKey), new Date(deps.now()).toISOString(), ANALYZE_LOCK_SECONDS);

  // One serverInfo call per invocation for the Jira link base.
  let siteUrl: Promise<string | null> | undefined;
  const readSiteUrl = deps.jira.siteUrl.bind(deps.jira);
  deps = { ...deps, jira: { ...deps.jira, siteUrl: () => (siteUrl ??= readSiteUrl()) } };

  let cursor = job.status === 'queued' ? initialCursor(scope) : parseCursor(job.cursor, scope);
  const counts: Totals = { scanned: job.scannedCount, stored: job.storedCount, candidates: job.candidateCount };
  if (job.status === 'filtering') {
    return { status: 'finalized', counts: await finalizeCollect(job, { ...cursor, phase: 'done', pendingComments: [] }, deps, counts) };
  }
  if (job.status === 'queued') {
    await deps.repo.updateJob(job.id, { status: 'collecting', startedAt: new Date(deps.now()).toISOString(), cursor, progress: progressOf(cursor, counts) });
  }

  let units = 0;
  try {
    while ((cursor.phase !== 'done' || cursor.pendingComments.length > 0) && units < budget.maxPages && deps.now() < budget.deadline) {
      const step = await collectUnit(job, scope, cursor, deps);
      cursor = step.cursor;
      counts.scanned += step.totals.scanned;
      counts.stored += step.totals.stored;
      counts.candidates += step.totals.candidates;
      units += 1;
      await deps.repo.updateJob(job.id, {
        cursor,
        scannedCount: counts.scanned,
        storedCount: counts.stored,
        candidateCount: counts.candidates,
        progress: progressOf(cursor, counts),
      });
    }
  } catch (err) {
    if (deps.isRateLimited(err)) return { status: 'rate_limited', counts: { ...counts, truncated: 0 }, phase: cursor.phase };
    return failStep(job, deps, err);
  }

  if (cursor.phase !== 'done' || cursor.pendingComments.length > 0) return { status: 'more', counts: { ...counts, truncated: 0 }, phase: cursor.phase };
  return { status: 'finalized', counts: await finalizeCollect(job, cursor, deps, counts) };
}
