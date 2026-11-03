import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReachPathInput, RouteInput } from '../src/adapters/repo';
import { activateRoute, readReach, responderOf, runPropose, runTrace, type ReachFlowDeps } from '../src/core/reachFlow';

const PAYMENTS = '855b1079-8375-4d0d-a163-ddc96cdb696f';
const PLATFORM = 'fa2a7a5c-d603-47c9-aadd-89f6017e48f3';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const ROUTE = '44444444-4444-4444-8444-444444444444';
const APP = 'app-account';
const BAYU = '557058:bayu-full-account-id';

const signal = (id: string, status: string, eventId: string, daysBefore: number, confidence = 0.9) => ({ id, status, eventId, candidateId: `c-${id}`, daysBefore, confidence, incidentKey: 'INC-60' });
const event = (id: string, source: string, artifactId: string, keys: { projectKey?: string; spaceKey?: string }) => ({
  id,
  source,
  artifactId,
  projectKey: keys.projectKey ?? null,
  spaceKey: keys.spaceKey ?? null,
  componentNames: [],
  labels: [],
});

function makeDeps() {
  const stored: { paths: ReachPathInput[]; routes: RouteInput[] } = { paths: [], routes: [] };
  const repo = {
    getIncident: vi.fn(async () => ({ issueKey: 'INC-60', serviceKey: 'checkout', responderTeamId: null, responderTeamName: null, startedAt: '2026-11-03T09:00:00.000Z', scenarioStartedAt: '2026-11-03T09:12:00.000Z' })),
    listServiceMappings: vi.fn(async () => [{ serviceKey: 'checkout', displayName: 'Checkout (Arkana Commerce)', aliases: ['payment gateway'], ownerTeamId: `ari:cloud:identity::team/${PAYMENTS}`, ownerTeamName: 'Arkana Payments' }]),
    listSignalsForIncident: vi.fn(async () => [signal(S1, 'confirmed', 'e1', 12, 0.92), signal(S2, 'confirmed', 'e2', 6, 0.8), signal(S3, 'proposed', 'e3', 3)]),
    getEventsByIds: vi.fn(async () => [event('e1', 'confluence', '5079131', { spaceKey: 'PLAT' }), event('e2', 'jsm', '10046', { projectKey: 'INC' }), event('e3', 'jira', '10052', { projectKey: 'PAY' })]),
    listEventTouches: vi.fn(async () => [
      { source: 'confluence', artifactId: '5079131', kind: 'comment', authorAccountId: APP, at: '2026-10-22T09:00:00.000Z' },
      { source: 'jsm', artifactId: '10046', kind: 'issue', authorAccountId: APP, at: '2026-10-28T09:00:00.000Z' },
    ]),
    getCandidatesByIds: vi.fn(async () => [{ id: `c-${S1}`, matchedKeywords: ['tls'] }]),
    upsertReachPaths: vi.fn(async (p: ReachPathInput[]) => {
      stored.paths = p;
      return p.length;
    }),
    listReachPaths: vi.fn(async () => stored.paths.map((p, i) => ({ ...p, id: `r${i}`, computedAt: '2026-11-03T10:00:00.000Z' }))),
    upsertRoutes: vi.fn(async (r: RouteInput[]) => {
      stored.routes = r;
      return r.length;
    }),
    listRoutes: vi.fn(async () => stored.routes.map((r, i) => ({ ...r, id: `ro${i}`, status: 'proposed', activatedAt: null, createdAt: '', updatedAt: '' }))),
    deleteProposedRoutes: vi.fn(async () => 0),
    getRoute: vi.fn(),
    getSetting: vi.fn(async (): Promise<unknown> => [APP]),
    decideRoute: vi.fn(async () => 1),
  };
  const lookup = {
    teamsOf: vi.fn(async (id: string) => (id === BAYU ? { ok: true as const, status: 200, teams: [{ id: PLATFORM, name: 'Arkana Platform' }] } : { ok: true as const, status: 200, teams: [] })),
    contributorsOf: vi.fn(async () => ({ ok: true as const, status: 200, accountIds: [BAYU], truncated: false })),
  };
  const deps = {
    repo,
    getIncidentAsUser: vi.fn(async (): Promise<unknown> => ({ id: '1' })),
    visibleIssueIds: vi.fn(async (ids: readonly string[]) => new Set(ids)),
    visiblePageIds: vi.fn(async (ids: readonly string[]) => new Set(ids)),
    cloudId: vi.fn(async () => 'cloud-1'),
    watchersOf: vi.fn(async (): Promise<{ accountId: string; accountType: string | null }[]> => [
      { accountId: APP, accountType: 'app' },
      { accountId: BAYU, accountType: 'atlassian' },
    ]),
    pageVersionAuthors: vi.fn(async (): Promise<{ accountId: string; at: string | null }[]> => [{ accountId: APP, at: '2026-10-20T09:00:00.000Z' }]),
    isRateLimited: vi.fn((_err: unknown): boolean => false),
    teamLookup: vi.fn(() => lookup),
    refreshDossier: vi.fn(async () => undefined),
    now: () => 1_000,
  };
  return { deps: deps as unknown as ReachFlowDeps & typeof deps, repo, lookup, stored };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('responderOf', () => {
  it('uses the stored responder, else the mapping owner team (normalised to a uuid), else null', () => {
    const mapping = [{ serviceKey: 'checkout', ownerTeamId: `ari:cloud:identity::team/${PAYMENTS}`, ownerTeamName: 'Arkana Payments' }] as never;
    expect(responderOf({ serviceKey: 'checkout', responderTeamId: null } as never, mapping)).toEqual({ teamId: PAYMENTS, teamName: 'Arkana Payments' });
    expect(responderOf({ serviceKey: 'other', responderTeamId: null } as never, mapping)).toBeNull();
    expect(responderOf({ serviceKey: 'checkout', responderTeamId: 'T1', responderTeamName: 'Ops' } as never, mapping)).toEqual({ teamId: 't1', teamName: 'Ops' });
  });
});

describe('runTrace', () => {
  it('traces confirmed signals only, drops the app account, stores paths and routes and refreshes the dossier', async () => {
    const { deps, repo, lookup, stored } = makeDeps();
    const r = await runTrace('INC-60', { via: 'resolver' }, deps);
    expect(stored.paths.map((p) => p.signalId)).toEqual([S1, S2]);
    expect(stored.paths.every((p) => p.reached === false && p.graphState === 'ok')).toBe(true);
    // One lookup per signal touch (the real TeamLookup caches per request); never the app account.
    expect(lookup.teamsOf.mock.calls.map((c) => c[0])).toEqual([BAYU, BAYU]);
    expect(lookup.contributorsOf).toHaveBeenCalledWith('5079131');
    expect(r.metrics).toMatchObject({ reached: 0, considered: 2, firstSignalDays: 12, awarenessGapDays: 12, stopPoint: { teamName: 'Arkana Platform' } });
    expect(r.routes.map((x) => [x.sourceKey, x.estimatedDaysSaved])).toEqual([
      ['PLAT', 11],
      ['INC', 4.8],
    ]);
    expect(repo.deleteProposedRoutes).not.toHaveBeenCalled();
    expect(deps.refreshDossier).toHaveBeenCalledWith('INC-60');
    expect(r).toMatchObject({ graphAvailable: true, simulated: true, responderTeamName: 'Arkana Payments', partial: false });
    expect(JSON.stringify([r, stored])).not.toContain(BAYU);
  });

  it('falls back to authors and contributors when watchers cannot be read', async () => {
    const { deps, stored } = makeDeps();
    deps.watchersOf.mockRejectedValue(new Error('Jira 403'));
    const r = await runTrace('INC-60', { via: 'action' }, deps);
    expect(r.watchersAvailable).toBe(false);
    expect(stored.paths.find((p) => p.signalId === S2)).toMatchObject({ graphState: 'ok', steps: [], stopPoint: { teamName: null } });
  });

  it('without a responder team nothing is traced ("Graph context not available")', async () => {
    const { deps, repo } = makeDeps();
    repo.listServiceMappings.mockResolvedValue([]);
    const r = await runTrace('INC-60', { via: 'resolver' }, deps);
    expect(r).toMatchObject({ graphAvailable: false, reason: 'no_responder_team', metrics: null });
    expect(repo.upsertReachPaths).not.toHaveBeenCalled();
  });

  it('validates the incident and the signal', async () => {
    const { deps } = makeDeps();
    await expect(runTrace('INC-60', { via: 'resolver', signalId: S3 }, deps)).rejects.toThrow('Only confirmed signals can be traced');
    await expect(runTrace('INC-60', { via: 'resolver', signalId: ROUTE }, deps)).rejects.toThrow('was not found on INC-60');
    deps.getIncidentAsUser.mockResolvedValue(undefined);
    await expect(runTrace('INC-60', { via: 'resolver' }, deps)).rejects.toThrow('do not have permission');
  });

  it('a 429 from Teamwork Graph stores the rest as pending (partial)', async () => {
    const { deps, lookup, stored } = makeDeps();
    lookup.contributorsOf.mockResolvedValue({ ok: false, status: 429, error: 'HTTP 429' } as never);
    const r = await runTrace('INC-60', { via: 'resolver' }, deps);
    expect(r).toMatchObject({ partial: true, rateLimited: true });
    expect(stored.paths.map((p) => p.graphState)).toEqual(['pending', 'pending']);
  });
});

describe('runPropose', () => {
  it('traces first when a confirmed signal has no usable path', async () => {
    const { deps, repo } = makeDeps();
    await runPropose('INC-60', { via: 'action' }, deps);
    expect(repo.upsertReachPaths).toHaveBeenCalledTimes(1);
    repo.upsertReachPaths.mockClear();
    const r = await runPropose('INC-60', { via: 'action' }, deps);
    expect(repo.upsertReachPaths).not.toHaveBeenCalled();
    expect(r.routes).toHaveLength(2);
  });
});

describe('activateRoute', () => {
  const route = { id: ROUTE, originIncidentKey: 'INC-60', status: 'proposed', sourceType: 'confluence_space', sourceKey: 'PLAT', spec: { keywords: [], target: { teamId: PAYMENTS, action: 'mention' } }, signalIds: [], rankNo: 1 };

  it('proposed → active with the decider, then refreshes the dossier', async () => {
    const { deps, repo } = makeDeps();
    repo.getRoute.mockResolvedValueOnce(route).mockResolvedValueOnce({ ...route, status: 'active' });
    expect(await activateRoute(ROUTE, 'acc-1', deps)).toMatchObject({ changed: true, route: { status: 'active', routeId: ROUTE } });
    expect(repo.decideRoute).toHaveBeenCalledWith(ROUTE, 'proposed', 'active', 'acc-1');
    expect(deps.refreshDossier).toHaveBeenCalledWith('INC-60');
  });

  it('an active route stays active; other incidents, invisible incidents and conflicts are refused', async () => {
    const { deps, repo } = makeDeps();
    repo.getRoute.mockResolvedValue({ ...route, status: 'active' });
    expect(await activateRoute(ROUTE, 'acc-1', deps)).toMatchObject({ changed: false });
    expect(repo.decideRoute).not.toHaveBeenCalled();
    await expect(activateRoute(ROUTE, 'acc-1', deps, 'INC-61')).rejects.toThrow('was not found on INC-61');
    repo.getRoute.mockResolvedValue(route);
    repo.decideRoute.mockResolvedValue(0);
    await expect(activateRoute(ROUTE, 'acc-1', deps)).rejects.toThrow('changed by someone else');
    deps.getIncidentAsUser.mockResolvedValue(undefined);
    await expect(activateRoute(ROUTE, 'acc-1', deps)).rejects.toThrow('was not found');
  });
});

describe('reach fixes (round 1)', () => {
  it('B: the stamp edit (page version by a person) counts even when Teamwork Graph has no contributors yet; app touches are dropped', async () => {
    const { deps, lookup, stored } = makeDeps();
    lookup.contributorsOf.mockResolvedValue({ ok: true, status: 200, accountIds: [], truncated: false });
    deps.pageVersionAuthors.mockResolvedValue([
      { accountId: APP, at: '2026-10-20T09:00:00.000Z' },
      { accountId: BAYU, at: '2026-11-03T07:33:00.000Z' },
    ]);
    await runTrace('INC-60', { via: 'resolver' }, deps);
    const page = stored.paths.find((p) => p.signalId === S1)!;
    expect(page).toMatchObject({ graphState: 'ok', reached: false, stopPoint: { teamName: 'Arkana Platform' } });
    expect(page.steps.some((s) => s.teamId === null)).toBe(false);
    expect(lookup.teamsOf.mock.calls.map((c) => c[0])).not.toContain(APP);
  });

  it('A: app accounts are recognised from watcher accountType when settings know none', async () => {
    const { deps, repo, lookup } = makeDeps();
    repo.getSetting.mockResolvedValue(undefined);
    deps.pageVersionAuthors.mockResolvedValue([]);
    await runTrace('INC-60', { via: 'resolver' }, deps);
    // The jsm signal's watcher of type app is never looked up; the page's event author (app, older data) still is.
    expect(lookup.teamsOf.mock.calls.filter((c) => c[0] === APP)).toHaveLength(1);
    expect(deps.watchersOf).toHaveBeenCalledWith('10046');
  });

  it('page versions failing falls back to Teamwork Graph contributors; a 429 there is partial', async () => {
    const { deps, stored } = makeDeps();
    deps.pageVersionAuthors.mockRejectedValueOnce(new Error('Confluence 500'));
    await runTrace('INC-60', { via: 'resolver' }, deps);
    expect(stored.paths.find((p) => p.signalId === S1)).toMatchObject({ graphState: 'ok', stopPoint: { teamName: 'Arkana Platform' } });
    const rate = Object.assign(new Error('429'), { status: 429 });
    const second = makeDeps();
    second.deps.pageVersionAuthors.mockRejectedValue(rate);
    second.deps.isRateLimited.mockImplementation((err: unknown) => err === rate);
    expect(await runTrace('INC-60', { via: 'resolver' }, second.deps)).toMatchObject({ partial: true, rateLimited: true });
  });

  it('a known ok path is not overwritten when this run leaves it pending', async () => {
    const { deps, repo, lookup, stored } = makeDeps();
    await runTrace('INC-60', { via: 'resolver' }, deps);
    lookup.contributorsOf.mockResolvedValue({ ok: false, status: 429, error: 'HTTP 429' } as never);
    deps.watchersOf.mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));
    deps.isRateLimited.mockReturnValue(true);
    repo.upsertReachPaths.mockClear();
    const r = await runTrace('INC-60', { via: 'resolver' }, deps);
    expect(repo.upsertReachPaths).toHaveBeenCalledWith([]);
    expect(stored.paths.every((p) => p.graphState === 'ok')).toBe(true);
    expect(r.partial).toBe(false);
  });

  it('metrics and routes only cover signals the caller can see; stale routes of hidden signals are kept', async () => {
    const { deps, repo, stored } = makeDeps();
    await runTrace('INC-60', { via: 'resolver' }, deps);
    // Now the caller cannot see the Confluence page (S1).
    deps.visiblePageIds.mockResolvedValue(new Set());
    stored.routes = [...stored.routes];
    const r = await runTrace('INC-60', { via: 'resolver' }, deps);
    expect(r.metrics).toMatchObject({ confirmed: 1, considered: 1, firstSignalDays: 6 });
    expect(r.routes.map((x) => x.sourceKey)).toEqual(['INC']);
    expect(r.routes[0]!.rank).toBe(1);
    // PLAT came from S1 only (hidden): not deleted by this caller.
    expect(repo.deleteProposedRoutes).not.toHaveBeenCalled();
  });
});

describe('readReach / stale routes', () => {
  const route = (id: string, sourceKey: string, signalIds: string[], status: string, rankNo: number, estimatedDaysSaved: number) => ({
    id, originIncidentKey: 'INC-60', sourceType: 'jira_project', sourceKey, spec: { keywords: [], target: { teamId: PAYMENTS, action: 'mention' } }, reason: 'r',
    estimatedDaysSaved, maxDaysBefore: 12, signalIds, score: estimatedDaysSaved, status, rankNo, activatedAt: null, createdAt: '', updatedAt: '',
  });

  it('hides routes built only from invisible signals and re-ranks duplicates for display', async () => {
    const { repo } = makeDeps();
    repo.listRoutes.mockResolvedValue([route('a', 'PAY', [S2], 'active', 1, 2.6), route('b', 'INC', [S2], 'proposed', 1, 4.8), route('c', 'SEC', ['hidden'], 'proposed', 2, 9)] as never);
    const view = await readReach('INC-60', new Set([S1, S2]), { repo } as never);
    expect(view.routes.map((r) => [r.routeId, r.rank])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
    expect(view.responderTeamId).toBe(PAYMENTS);
  });

  it('routesNote explains an empty list', async () => {
    const { repo } = makeDeps();
    repo.listRoutes.mockResolvedValue([]);
    repo.listReachPaths.mockResolvedValue([]);
    expect((await readReach('INC-60', new Set([S1, S2]), { repo } as never)).routesNote).toBe('no_graph');
  });

  it('deletes stale proposed routes built only from visible signals', async () => {
    const { deps, repo } = makeDeps();
    // First listRoutes call = the routes stored before this run.
    repo.listRoutes.mockResolvedValueOnce([route('old', 'OLD', [S2], 'proposed', 3, 1), route('act', 'ACT', [S2], 'active', 4, 1), route('hid', 'HID', ['hidden', S2], 'proposed', 5, 1)] as never);
    await runTrace('INC-60', { via: 'resolver' }, deps);
    expect(repo.deleteProposedRoutes).toHaveBeenCalledWith('INC-60', ['old']);
  });
});
