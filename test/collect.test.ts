import { describe, expect, it, vi } from 'vitest';
import type { RawContent } from '../src/adapters/confluence';
import type { RawIssue } from '../src/adapters/jira';
import type { AnalysisJob, CandidateInput, EventInput, EventRef, JobPatch } from '../src/adapters/repo';
import { eventRefKey } from '../src/adapters/repo';
import {
  buildCql,
  buildJql,
  commentItems,
  issueMeta,
  MAX_CONFLUENCE_PAGES_PER_JOB,
  MAX_JIRA_PAGES_PER_JOB,
  runCollectStep,
  type CollectDeps,
} from '../src/core/collect';
import { buildScope, type Scope } from '../src/core/scope';

const START = '2026-11-20T10:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.parse(START) - d * DAY).toISOString();

const scope: Scope = buildScope(
  {
    issueKey: 'INC-7',
    projectKey: 'INC',
    summary: 'Checkout payments failing',
    description: 'HTTP 402 from the payment gateway',
    componentNames: [],
    startedAt: START,
    scenarioStartedAt: null,
    propertyServiceKey: 'payments',
    manualServiceKey: null,
  },
  [{ serviceKey: 'payments', jiraProjectKeys: ['PAY'], jiraComponentNames: ['Checkout'], confluenceSpaceKeys: ['PLAT'], aliases: [] }],
  { excludedProjectKeys: [], excludedSpaceKeys: [] },
  30,
);

const adf = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const issue = (n: number, over: Partial<NonNullable<RawIssue['fields']>> = {}): RawIssue => ({
  id: String(1000 + n),
  key: `PAY-${n}`,
  self: `https://one.atlassian.net/rest/api/3/issue/${1000 + n}`,
  fields: {
    summary: n % 2 === 0 ? `Payment gateway returns 402 (${n})` : `Unrelated chore ${n}`,
    description: adf('details'),
    created: daysAgo(10),
    updated: daysAgo(9),
    project: { key: 'PAY', projectTypeKey: 'software' },
    comment: { comments: [], total: 0 },
    ...over,
  },
});

const page = (id: string, title: string, created: string): RawContent => ({
  id,
  type: 'page',
  title,
  space: { key: 'PLAT' },
  history: { createdDate: created, createdBy: { accountId: 'u9' } },
  version: { when: created, number: 1 },
  body: { storage: { value: '<p>The vendor deprecates TLS 1.1 for the payment gateway.</p>' } },
  _links: { webui: `/spaces/PLAT/pages/${id}` },
});

function fakeRepo(initial: Partial<AnalysisJob> = {}) {
  const job: AnalysisJob = {
    id: 'job-1',
    incidentKey: 'INC-7',
    status: 'queued',
    windowDays: 30,
    windowFrom: scope.windowFrom,
    windowTo: scope.windowTo,
    scope: JSON.parse(JSON.stringify(scope)),
    cursor: null,
    progress: {},
    scannedCount: 0,
    storedCount: 0,
    candidateCount: 0,
    truncatedCount: 0,
    attempt: 0,
    lastError: null,
    requestedBy: null,
    startedAt: null,
    finishedAt: null,
    createdAt: START,
    updatedAt: START,
    ...initial,
  };
  const events = new Map<string, EventInput & { scenarioAt?: string | null }>();
  const candidates: (CandidateInput & { id: string; status: string })[] = [];
  const cursors: unknown[] = [];
  const locks: [string, string, number][] = [];
  const repo: CollectDeps['repo'] = {
    extendAppLock: async (name: string, nowIso: string, seconds: number) => {
      locks.push([name, nowIso, seconds]);
    },
    getJob: async () => JSON.parse(JSON.stringify(job)) as AnalysisJob,
    updateJob: async (_id: string, patch: JobPatch) => {
      if ('cursor' in patch) cursors.push(JSON.parse(JSON.stringify(patch.cursor)));
      Object.assign(job, {
        ...(patch.status ? { status: patch.status } : {}),
        ...('cursor' in patch ? { cursor: patch.cursor } : {}),
        ...(patch.scannedCount !== undefined ? { scannedCount: patch.scannedCount } : {}),
        ...(patch.storedCount !== undefined ? { storedCount: patch.storedCount } : {}),
        ...(patch.candidateCount !== undefined ? { candidateCount: patch.candidateCount } : {}),
        ...(patch.truncatedCount !== undefined ? { truncatedCount: patch.truncatedCount } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      });
      return 1;
    },
    findEventsByRefs: async (refs: readonly EventRef[]) => {
      const out = new Map<string, { id: string; scenarioAt: string | null }>();
      for (const r of refs) {
        const e = events.get(eventRefKey(r));
        if (e?.id) out.set(eventRefKey(r), { id: e.id, scenarioAt: e.scenarioAt ?? null });
      }
      return out;
    },
    upsertEvents: async (list: readonly EventInput[]) => {
      for (const e of list) {
        const key = eventRefKey({ source: e.source, artifactId: e.artifactId, commentId: e.commentId ?? '' });
        events.set(key, { ...events.get(key), ...e, id: events.get(key)?.id ?? e.id });
      }
      return list.length;
    },
    insertCandidates: async (list: readonly CandidateInput[]) => {
      for (const c of list) if (!candidates.some((x) => x.eventId === c.eventId)) candidates.push({ ...c, id: `cand-${c.eventId}`, status: 'kept' });
      return list.length;
    },
    listCandidateRanks: async () => candidates.map((c) => ({ id: c.id, eventId: c.eventId, filterScore: c.filterScore, daysBefore: c.daysBefore })),
    markCandidatesTruncated: async (_jobId: string, ids: readonly string[]) => {
      for (const c of candidates) if (ids.includes(c.id)) c.status = 'truncated';
      return ids.length;
    },
  };
  return { job, events, candidates, cursors, locks, repo };
}

class RateLimited extends Error {}

function makeDeps(repo: CollectDeps['repo'], jiraPages: RawIssue[][], confPages: RawContent[][]) {
  const searchPage = vi.fn(async (_jql: string, token: string | undefined) => {
    const i = token ? Number(token) : 0;
    const next = i + 1 < jiraPages.length ? { nextPageToken: String(i + 1) } : {};
    return { issues: jiraPages[i] ?? [], ...next };
  });
  const searchContent = vi.fn(async (_cql: string, cursor: string | undefined) => {
    const i = cursor ? Number(cursor) : 0;
    const next = i + 1 < confPages.length ? { nextCursor: String(i + 1) } : {};
    return { results: confPages[i] ?? [], base: 'https://one.atlassian.net/wiki', ...next };
  });
  const listComments = vi.fn(async () => ({ comments: [], total: 0 }));
  let id = 0;
  const deps: CollectDeps = {
    repo,
    jira: { searchPage, listComments },
    confluence: { searchContent },
    isRateLimited: (err) => err instanceof RateLimited,
    now: () => Date.parse('2026-11-25T00:00:00Z'),
    newId: () => `ev-${String(++id).padStart(3, '0')}`,
  };
  return { deps, searchPage, searchContent, listComments };
}

const budget = (maxPages: number) => ({ maxPages, deadline: Number.MAX_SAFE_INTEGER });

describe('queries', () => {
  it('builds JQL and CQL from the scope with real-time day bounds', () => {
    expect(buildJql(scope)).toBe(
      'project in ("INC", "PAY") AND updated >= "2026-10-20" AND created <= "2026-11-21" AND key != "INC-7" ORDER BY updated ASC',
    );
    expect(buildCql(scope)).toBe(
      'space in ("PLAT") AND type in (page, comment) AND lastmodified >= "2026-10-20" AND lastmodified <= "2026-11-21" ORDER BY lastmodified ASC',
    );
    expect(buildCql({ ...scope, confluenceSpaceKeys: ['bad key"'] })).toBeUndefined();
  });
});

describe('runCollectStep', () => {
  it('3 Jira pages + 2 Confluence pages finish in 2 invocations, saving the cursor after every page', async () => {
    const f = fakeRepo();
    const { deps, searchPage } = makeDeps(f.repo, [[issue(1), issue(2)], [issue(3), issue(4)], [issue(5)]], [[page('501', 'TLS note', daysAgo(12))], [page('502', 'Chore', daysAgo(40))]]);

    const first = await runCollectStep('job-1', deps, budget(3));
    expect(first).toMatchObject({ status: 'more', phase: 'confluence' });
    expect(searchPage.mock.calls.map((c) => c[1])).toEqual([undefined, '1', '2']);
    expect(f.cursors.length).toBe(4); // initial + one per page

    const second = await runCollectStep('job-1', deps, budget(3));
    expect(second.status).toBe('finalized');
    // 5 issues + 2 pages scanned; the page created 40 days ago is outside the window and is not stored.
    expect(second).toMatchObject({ counts: { scanned: 7, stored: 6, truncated: 0 } });
    expect(f.events.size).toBe(6);
    expect([...f.events.values()].some((e) => e.artifactId === '502')).toBe(false);
    expect(f.job.status).toBe('scoring');
    const stored = [...f.events.values()];
    expect(stored.every((e) => !('text' in e))).toBe(true);
    expect(stored.find((e) => e.artifactId === '501')?.url).toBe('https://one.atlassian.net/wiki/spaces/PLAT/pages/501');
    // Payment issues (even numbers) and the TLS page pass; the chores do not.
    expect(f.candidates.map((c) => c.eventId).length).toBe(3);
    expect(f.job.candidateCount).toBe(3);
  });

  it('a 429 on page 2 keeps page 1 and resumes from the saved cursor', async () => {
    const f = fakeRepo();
    const { deps, searchPage } = makeDeps(f.repo, [[issue(2)], [issue(4)]], []);
    searchPage.mockImplementationOnce(async () => ({ issues: [issue(2)], nextPageToken: '1' })).mockImplementationOnce(async () => {
      throw new RateLimited('429');
    });
    const first = await runCollectStep('job-1', deps, budget(10));
    expect(first).toMatchObject({ status: 'rate_limited', phase: 'jira' });
    expect(f.job.status).toBe('collecting');
    expect(f.job.scannedCount).toBe(1);
    expect((f.job.cursor as { jiraNextPageToken?: string }).jiraNextPageToken).toBe('1');

    const second = await runCollectStep('job-1', deps, budget(10));
    expect(second.status).toBe('finalized');
    expect(searchPage.mock.calls.at(-1)?.[1]).toBe('1');
    expect(f.job.scannedCount).toBe(2); // issue 2 + issue 4; issue 2 is not read again
    expect(f.candidates.length).toBe(2);
  });

  it('other errors fail the job with a short message', async () => {
    const f = fakeRepo();
    const { deps, searchPage } = makeDeps(f.repo, [[]], []);
    searchPage.mockRejectedValue(new Error('Jira 400: bad JQL'));
    expect(await runCollectStep('job-1', deps, budget(10))).toMatchObject({ status: 'failed', error: 'Error: Jira 400: bad JQL' });
    expect(f.job.status).toBe('failed');
    expect(f.job.lastError).toBe('Error: Jira 400: bad JQL');
  });

  it('skips jobs that are past collecting (duplicate delivery)', async () => {
    const f = fakeRepo({ status: 'scoring' });
    const { deps } = makeDeps(f.repo, [], []);
    expect(await runCollectStep('job-1', deps, budget(10))).toEqual({ status: 'skipped', reason: 'job is scoring' });
  });

  it('uses the demo scenario time of a pre-seeded event for the window and keeps its id', async () => {
    const f = fakeRepo();
    f.events.set(eventRefKey({ source: 'jira', artifactId: '1002', commentId: '' }), {
      id: 'seeded',
      source: 'jira',
      kind: 'issue',
      artifactId: '1002',
      commentId: '',
      title: '',
      occurredAt: daysAgo(0),
      scenarioAt: daysAgo(6),
    });
    const { deps } = makeDeps(f.repo, [[issue(2, { created: daysAgo(-0.1) })]], []);
    await runCollectStep('job-1', deps, budget(10));
    expect(f.candidates).toHaveLength(1);
    expect(f.candidates[0]).toMatchObject({ eventId: 'seeded', daysBefore: 6 });
  });

  it('fetches comments separately when the search returned only some of them', async () => {
    const f = fakeRepo();
    const { deps, listComments } = makeDeps(f.repo, [[issue(1, { comment: { comments: [], total: 2 } })]], []);
    listComments.mockResolvedValue({
      comments: [
        { id: 'c1', author: { accountId: 'u1' }, body: adf('Is the payment gateway returning 402 for anyone else?'), created: daysAgo(3) },
        { id: 'c2', author: { accountId: 'u1' }, body: adf('Still seeing it.'), created: daysAgo(2) },
      ],
      total: 2,
    } as never);
    const result = await runCollectStep('job-1', deps, budget(10));
    expect(result.status).toBe('finalized');
    expect(listComments).toHaveBeenCalledWith('1001', 0, 100);
    const c1 = f.candidates.find((c) => c.reasons.includes('unanswered_question'));
    expect(c1).toBeDefined();
  });

  it('truncates beyond 200 candidates at finalize', async () => {
    const f = fakeRepo();
    const issues = Array.from({ length: 250 }, (_, i) => issue(2 * i + 2));
    const pages = Array.from({ length: 5 }, (_, p) => issues.slice(p * 50, p * 50 + 50));
    const { deps } = makeDeps(f.repo, pages, []);
    const result = await runCollectStep('job-1', deps, budget(10));
    expect(result).toMatchObject({ status: 'finalized', counts: { candidates: 200, truncated: 50 } });
    expect(f.candidates.filter((c) => c.status === 'truncated')).toHaveLength(50);
  });
});

describe('commentItems', () => {
  it('marks a comment answered only when someone else commented later', () => {
    const meta = issueMeta(issue(1));
    const { items } = commentItems(meta, [
      { id: 'a', author: { accountId: 'u1' }, body: adf('q?'), created: daysAgo(3) },
      { id: 'b', author: { accountId: 'u1' }, body: adf('again?'), created: daysAgo(2) },
      { id: 'c', author: { accountId: 'u2' }, body: adf('answer'), created: daysAgo(1) },
      { id: 'd', author: { accountId: 'u2' }, body: adf('more'), created: daysAgo(0.5) },
    ]);
    expect(items.map((i) => i.isLastComment)).toEqual([false, false, true, true]);
    expect(items[0]?.event.url).toBe('https://one.atlassian.net/browse/PAY-1?focusedCommentId=a');
  });
});

describe('review fixes', () => {
  it('re-finalizes a job left in filtering (finalize died midway)', async () => {
    const f = fakeRepo({ status: 'filtering', cursor: { phase: 'done', pendingComments: [], issuesSeen: 1, pages: 1 }, scannedCount: 4, storedCount: 3 });
    const { deps, searchPage } = makeDeps(f.repo, [], []);
    const result = await runCollectStep('job-1', deps, budget(10));
    expect(result).toMatchObject({ status: 'finalized', counts: { scanned: 4, stored: 3, candidates: 0, truncated: 0 } });
    expect(searchPage).not.toHaveBeenCalled();
    expect(f.job.status).toBe('scoring');
  });

  it('never stores or scores restricted or internal comments, but counts them as scanned', async () => {
    const f = fakeRepo();
    const question = (id: string, extra: object) => ({ id, author: { accountId: `u-${id}` }, body: adf('Is the payment gateway returning 402 again?'), created: daysAgo(3), ...extra });
    const comments = [
      question('r1', { visibility: { type: 'role', value: 'Developers' } }),
      question('r2', { jsdPublic: false }),
      question('ok', { jsdPublic: true }),
    ];
    const { deps } = makeDeps(f.repo, [[issue(1, { comment: { comments, total: 3 } })]], []);
    const result = await runCollectStep('job-1', deps, budget(10));
    expect(result).toMatchObject({ status: 'finalized', counts: { scanned: 4 } });
    const commentIds = [...f.events.values()].filter((e) => e.kind === 'comment').map((e) => e.commentId);
    expect(commentIds).toEqual(['ok']);
    const ids = new Set([...f.events.values()].map((e) => e.id));
    expect(f.candidates.every((c) => ids.has(c.eventId))).toBe(true);
    expect(f.candidates).toHaveLength(1);
  });

  it('also drops restricted comments fetched with the comment endpoint', async () => {
    const f = fakeRepo();
    const { deps, listComments } = makeDeps(f.repo, [[issue(1, { comment: { comments: [], total: 1 } })]], []);
    listComments.mockResolvedValue({
      comments: [{ id: 'c1', author: { accountId: 'u1' }, body: adf('payment gateway 402?'), created: daysAgo(3), visibility: { type: 'group', value: 'admins' } }],
      total: 1,
    } as never);
    await runCollectStep('job-1', deps, budget(10));
    expect([...f.events.values()].some((e) => e.commentId === 'c1')).toBe(false);
  });

  it('caps Jira search pages per job and records the truncation', async () => {
    const f = fakeRepo();
    const pages = Array.from({ length: MAX_JIRA_PAGES_PER_JOB + 3 }, (_, p) => [issue(2 * p + 2)]);
    const { deps, searchPage } = makeDeps(f.repo, pages, []);
    const result = await runCollectStep('job-1', deps, budget(50));
    expect(result.status).toBe('finalized');
    expect(searchPage).toHaveBeenCalledTimes(MAX_JIRA_PAGES_PER_JOB);
    expect(f.job.cursor).toMatchObject({ jiraPages: MAX_JIRA_PAGES_PER_JOB, truncated: { jira: 'page_cap' } });
  });

  it('caps Confluence pages per job', async () => {
    const f = fakeRepo();
    const pages = Array.from({ length: MAX_CONFLUENCE_PAGES_PER_JOB + 2 }, (_, p) => [page(String(600 + p), 'Note', daysAgo(5))]);
    const { deps, searchContent } = makeDeps(f.repo, [[]], pages);
    await runCollectStep('job-1', deps, budget(50));
    expect(searchContent).toHaveBeenCalledTimes(MAX_CONFLUENCE_PAGES_PER_JOB);
    expect(f.job.cursor).toMatchObject({ truncated: { confluence: 'page_cap' } });
  });

  it('stops a source that returns an empty page with a next token (no endless loop)', async () => {
    const f = fakeRepo();
    const { deps, searchPage, searchContent } = makeDeps(f.repo, [], []);
    searchPage.mockResolvedValue({ issues: [], nextPageToken: 'again' });
    searchContent.mockResolvedValue({ results: [], base: null, nextCursor: 'again' } as never);
    const result = await runCollectStep('job-1', deps, budget(50));
    expect(result.status).toBe('finalized');
    expect(searchPage).toHaveBeenCalledTimes(1);
    expect(searchContent).toHaveBeenCalledTimes(1);
    expect(f.job.cursor).toMatchObject({ truncated: { jira: 'empty_page', confluence: 'empty_page' } });
  });

  it('extends the analyze lock at the start of every run', async () => {
    const f = fakeRepo();
    const { deps } = makeDeps(f.repo, [[issue(2)]], []);
    await runCollectStep('job-1', deps, budget(10));
    expect(f.locks).toEqual([['analyze:INC-7', '2026-11-25T00:00:00.000Z', 1200]]);
  });

  it('fails a job whose stored incident key is not an issue key (never reaches JQL)', async () => {
    const f = fakeRepo({ scope: { ...JSON.parse(JSON.stringify(scope)), incidentKey: 'INC-7" OR "1"="1' } });
    const { deps, searchPage } = makeDeps(f.repo, [[issue(2)]], []);
    expect(await runCollectStep('job-1', deps, budget(10))).toMatchObject({ status: 'failed' });
    expect(searchPage).not.toHaveBeenCalled();
    expect(() => buildJql({ ...scope, incidentKey: 'bad key' })).toThrow();
    expect(buildJql({ ...scope, jiraProjectKeys: ['PAY" OR project = "X', 'pay'] })).toBeUndefined();
  });

  it('does not mark the last fetched comment unanswered when Jira has more than were fetched', () => {
    const meta = issueMeta(issue(1));
    const list = [{ id: 'a', author: { accountId: 'u1' }, body: adf('anyone?'), created: daysAgo(3) }];
    expect(commentItems(meta, list, 150).items[0]?.isLastComment).toBe(false);
    expect(commentItems(meta, list, 1).items[0]?.isLastComment).toBe(true);
  });
});
