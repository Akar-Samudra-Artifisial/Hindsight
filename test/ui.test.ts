import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: { payload: Record<string, unknown>; context: Record<string, unknown> }) => Promise<unknown>;
const defs = vi.hoisted(() => new Map<string, Handler>());
vi.mock('@forge/resolver', () => ({
  default: class {
    define(name: string, fn: Handler) {
      defs.set(name, fn);
    }
    getDefinitions() {
      return defs;
    }
  },
}));
const queue = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@forge/events', () => ({
  Queue: class {
    constructor(readonly opts: { key: string }) {}
    push(payload: unknown) {
      return queue.push(this.opts.key, payload);
    }
  },
}));
vi.mock('../src/adapters/sql', () => ({ ensureSchema: vi.fn(async () => undefined) }));
const repoMock = vi.hoisted(() => ({
  listServiceMappings: vi.fn(),
  upsertServiceMapping: vi.fn(),
  deleteServiceMapping: vi.fn(),
  listDemoArtifacts: vi.fn(),
  getLatestCollectedJobForIncident: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  acquireAppLock: vi.fn(),
  releaseAppLock: vi.fn(),
  getLatestJobForIncident: vi.fn(),
  getIncident: vi.fn(),
  listSignalsForIncident: vi.fn(),
  getEventsByIds: vi.fn(),
  candidateStatusCounts: vi.fn(),
  scoreErrorCounts: vi.fn(),
  getSignal: vi.fn(),
  updateSignalStatus: vi.fn(),
  insertDecision: vi.fn(),
  listReachPaths: vi.fn(async () => []),
  listRoutes: vi.fn(async () => []),
  listActiveRoutes: vi.fn(),
  upsertDemoArtifact: vi.fn(),
  getRoute: vi.fn(),
  listAlertsForIncident: vi.fn(),
  getAlert: vi.fn(),
  setAlertFeedback: vi.fn(),
}));
vi.mock('../src/adapters/repo', () => ({ repo: repoMock }));
const jiraMock = vi.hoisted(() => ({ isAdminAsUser: vi.fn(), getIncidentAsUser: vi.fn(), visibleIssueIds: vi.fn(), getProject: vi.fn() }));
vi.mock('../src/adapters/jira', () => ({ jira: jiraMock }));
const confluenceMock = vi.hoisted(() => ({ visiblePageIds: vi.fn(), findSpace: vi.fn(), createFooterCommentAsUser: vi.fn() }));
vi.mock('../src/adapters/confluence', () => ({ confluence: confluenceMock }));

const lookupMock = vi.hoisted(() => ({ teamsOf: vi.fn(), contributorsOf: vi.fn() }));
vi.mock('../src/adapters/teamworkGraph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/teamworkGraph')>()),
  createTeamLookup: () => lookupMock,
}));

await import('../src/surfaces/ui');

const setup = { moduleKey: 'hindsight-setup', accountId: 'acc-1' };
const call = (name: string, payload: Record<string, unknown> = {}, context: Record<string, unknown> = setup) => defs.get(name)!({ payload, context });
const mapping = { serviceKey: 'checkout', displayName: 'Checkout', jiraProjectKeys: ['PAY'], confluenceSpaceKeys: [], jiraComponentNames: [], aliases: [] };

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  jiraMock.isAdminAsUser.mockReset().mockResolvedValue(true);
  jiraMock.getProject.mockReset().mockImplementation(async (key: string) => ({ id: '1', key, name: key, projectTypeKey: 'software' }));
  confluenceMock.findSpace.mockReset().mockImplementation(async (key: string) => ({ id: 's1', key }));
  repoMock.listServiceMappings.mockReset().mockResolvedValue([]);
  repoMock.upsertServiceMapping.mockReset().mockResolvedValue('id');
  repoMock.deleteServiceMapping.mockReset().mockResolvedValue(1);
  repoMock.listDemoArtifacts.mockReset().mockResolvedValue([{ slot: 'incident', artifactKey: 'INC-1' }]);
  repoMock.getLatestCollectedJobForIncident.mockReset().mockResolvedValue({ id: 'job-1' });
  repoMock.getSetting.mockReset().mockResolvedValue(undefined);
  repoMock.setSetting.mockReset().mockResolvedValue(undefined);
  repoMock.acquireAppLock.mockReset().mockResolvedValue(true);
  repoMock.releaseAppLock.mockReset().mockResolvedValue(undefined);
  queue.push.mockReset().mockResolvedValue({ jobId: 'q' });
});

describe('setup resolvers', () => {
  const mutations: [string, Record<string, unknown>][] = [
    ['saveServiceMapping', { mapping }],
    ['deleteServiceMapping', { serviceKey: 'checkout' }],
    ['startDemoJob', { kind: 'load' }],
    ['writeTestDossier', {}],
    ['teamSpike', {}],
    ['stampDemo', {}],
    ['postProviderNotice', {}],
    ['saveSentinelSettings', { weeklyCap: 10 }],
  ];

  it.each(mutations)('%s refuses calls from another module', async (name, payload) => {
    expect(await call(name, payload, { moduleKey: 'hindsight-incident', accountId: 'acc-1' })).toEqual({ error: `${name} is only available on Hindsight setup.` });
    expect(jiraMock.isAdminAsUser).not.toHaveBeenCalled();
  });

  it.each(mutations)('%s refuses non-admins', async (name, payload) => {
    jiraMock.isAdminAsUser.mockResolvedValue(false);
    expect(await call(name, payload)).toEqual({ error: 'Only Jira administrators can change Hindsight setup.' });
    expect(repoMock.upsertServiceMapping).not.toHaveBeenCalled();
    expect(queue.push).not.toHaveBeenCalled();
  });

  it('saveServiceMapping validates input and enforces the mapping limit', async () => {
    expect(await call('saveServiceMapping', { mapping: { ...mapping, jiraProjectKeys: ['bad key'] } })).toEqual({ error: '"BAD KEY" is not a Jira project key.' });
    repoMock.listServiceMappings.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ serviceKey: `s${i}` })));
    expect(await call('saveServiceMapping', { mapping })).toEqual({ error: 'Hindsight supports at most 50 service mappings.' });
    repoMock.listServiceMappings.mockResolvedValue([]);
    expect(await call('saveServiceMapping', { mapping })).toMatchObject({ ready: true });
    expect(repoMock.upsertServiceMapping).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: 'checkout' }));
  });

  it('startDemoJob queues the job on demo-seed', async () => {
    expect(await call('startDemoJob', { kind: 'load' })).toMatchObject({ ready: true, started: true, job: { kind: 'load', status: 'queued' } });
    expect(queue.push).toHaveBeenCalledWith('demo-seed', { body: { jobId: expect.any(String), attempt: 1 } });
    expect(await call('startDemoJob', { kind: 'nope' })).toEqual({ error: 'kind must be load, reset or remove.' });
  });

  it('writeTestDossier only queues score for the demo incident (the consumer writes)', async () => {
    expect(await call('writeTestDossier')).toEqual({ ready: true, queued: true, incidentKey: 'INC-1' });
    expect(queue.push).toHaveBeenCalledWith('score', { body: { jobId: 'job-1' } });
    expect(repoMock.getLatestCollectedJobForIncident).toHaveBeenCalledWith('INC-1');
    repoMock.getLatestCollectedJobForIncident.mockResolvedValue(undefined);
    expect(await call('writeTestDossier')).toEqual({ error: 'No finished analysis of INC-1 yet. Open INC-1, click Analyze and wait until the candidates appear.' });
  });

  it('logs every refused, setting-up or failed reply with the resolver name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    repoMock.listDemoArtifacts.mockResolvedValue([]);
    await call('writeTestDossier');
    expect(warn).toHaveBeenCalledWith('resolver refused', { resolver: 'writeTestDossier', error: 'There is no demo incident yet. Click Load demo data first.' });
    jiraMock.getIncidentAsUser.mockReset().mockResolvedValue(undefined);
    await call('startAnalysis', { incidentKey: 'INC-1' }, { accountId: 'acc-1' });
    expect(warn).toHaveBeenCalledWith('resolver refused', { resolver: 'startAnalysis', error: 'Incident INC-1 was not found, or you do not have permission to view it.' });
    jiraMock.getIncidentAsUser.mockRejectedValue(new Error('Jira 500'));
    await expect(call('startAnalysis', { incidentKey: 'INC-1' }, { accountId: 'acc-1' })).rejects.toThrow('Jira 500');
    expect(error).toHaveBeenCalledWith('resolver failed', { resolver: 'startAnalysis', error: 'Error: Jira 500' });
  });
});

describe('getDemoJob', () => {
  it('returns reuse warnings for existing containers', async () => {
    repoMock.listDemoArtifacts.mockResolvedValue([
      { slot: 'incident', artifactKey: 'INC-1', createdByApp: true },
      { slot: 'container:project-PAY', artifactKey: 'PAY', createdByApp: false },
    ]);
    expect(await call('getDemoJob')).toMatchObject({
      incidentKey: 'INC-1',
      warnings: ['Using existing project PAY; demo issues will be added to it and removed by Remove demo data.'],
      notes: [],
    });
  });

  it('notes containers the app created on an earlier Load, also when the job is done', async () => {
    repoMock.getSetting.mockResolvedValue({ id: 'j', kind: 'load', status: 'done', step: 10, total: 10, message: 'Done', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), accountId: 'acc-1' });
    repoMock.listDemoArtifacts.mockResolvedValue([{ slot: 'container:space-PLAT', artifactKey: 'PLAT', artifactId: 's1', createdByApp: true }]);
    expect(await call('getDemoJob')).toMatchObject({
      job: { status: 'done' },
      warnings: [],
      notes: ['Space PLAT was created by Hindsight for the demo; Remove demo data keeps it.'],
    });
  });

  it('a recorded project deleted from Jira is reported as missing, not as created by Hindsight', async () => {
    jiraMock.getProject.mockResolvedValue(undefined);
    repoMock.listDemoArtifacts.mockResolvedValue([
      { slot: 'incident', artifactKey: 'INC-15', createdByApp: true },
      { slot: 'container:project-PAY', artifactKey: 'PAY', createdByApp: true },
      { slot: 'container:project-INC', artifactKey: 'INC', createdByApp: true, source: 'jsm' },
    ]);
    expect(await call('getDemoJob')).toMatchObject({
      incidentKey: null,
      warnings: [],
      notes: ['Project PAY no longer exists; Load demo data will create it again.', 'Project INC no longer exists; Load demo data will create it again.'],
    });
  });
});

describe('incident panel: getAnalysis and decideSignal', () => {
  const SIG = '7d1c2f6e-4b7a-4c51-9a55-8f1d3c2a1e00';
  const panel = { moduleKey: 'hindsight-incident', accountId: 'acc-9', extension: { issue: { key: 'INC-1' } } };
  const row = (id: string, status: string, eventId: string, daysBefore: number) => ({ id, status, eventId, daysBefore, incidentKey: 'INC-1', signalType: 'technical_warning', quote: 'q', reason: 'r', confidence: 0.9 });

  beforeEach(() => {
    jiraMock.getIncidentAsUser.mockReset().mockResolvedValue({ id: '1', fields: {} });
    jiraMock.visibleIssueIds.mockReset().mockResolvedValue(new Set(['100']));
    confluenceMock.visiblePageIds.mockReset().mockResolvedValue(new Set());
    repoMock.getLatestJobForIncident.mockReset().mockResolvedValue({ id: 'job-1', status: 'done', scope: {}, scannedCount: 9, storedCount: 8, candidateCount: 5, truncatedCount: 0, progress: { score: { done: 5, total: 5 } } });
    repoMock.getIncident.mockReset().mockResolvedValue(undefined);
    repoMock.listSignalsForIncident.mockReset().mockResolvedValue([row('s1', 'proposed', 'e1', 3), row('s2', 'confirmed', 'e1', 1), row('s3', 'proposed', 'e2', 9)]);
    repoMock.getEventsByIds.mockReset().mockResolvedValue([
      { id: 'e1', source: 'jira', artifactId: '100', title: 'PAY-1', kind: 'comment', artifactKey: 'PAY-1', url: 'https://x/browse/PAY-1' },
      { id: 'e2', source: 'jira', artifactId: '200', title: 'secret', kind: 'issue', artifactKey: 'SEC-1', url: null },
    ]);
    repoMock.candidateStatusCounts.mockReset().mockResolvedValue({ scored: 4, score_failed: 1 });
    repoMock.scoreErrorCounts.mockReset().mockResolvedValue({ llm_invalid_output: 1 });
    repoMock.getSignal.mockReset().mockResolvedValue({ ...row(SIG, 'proposed', 'e1', 3) });
    repoMock.updateSignalStatus.mockReset().mockResolvedValue(1);
    repoMock.insertDecision.mockReset().mockResolvedValue(undefined);
  });

  it('getAnalysis returns visible signals (confirmed first), hidden and score-failed counts, and no decider', async () => {
    const reply = (await call('getAnalysis', {}, panel)) as { signals: { id: string }[]; hiddenCount: number; scoreFailedCount: number; job: { status: string } };
    expect(reply.signals.map((x) => x.id)).toEqual(['s2', 's1']);
    expect(reply).toMatchObject({ hiddenCount: 1, scoreFailedCount: 1, scoreFailed: { quoteNotFound: 0, invalidOutput: 1 }, job: { status: 'done' } });
    expect(JSON.stringify(reply)).not.toMatch(/acc-9|decided/);
  });

  it('getAnalysis refuses an incident the user cannot see', async () => {
    jiraMock.getIncidentAsUser.mockResolvedValue(undefined);
    expect(await call('getAnalysis', {}, panel)).toEqual({ error: 'Incident INC-1 was not found, or you do not have permission to view it.' });
  });

  it('decideSignal confirms as the current user and validates input', async () => {
    expect(await call('decideSignal', { signalId: SIG, decision: 'confirm' }, panel)).toEqual({ ready: true, id: SIG, status: 'confirmed', previousStatus: 'proposed' });
    expect(repoMock.insertDecision).toHaveBeenCalledWith({ signalId: SIG, incidentKey: 'INC-1', decision: 'confirm', decidedBy: 'acc-9' });
    expect(await call('decideSignal', { signalId: 'x', decision: 'confirm' }, panel)).toEqual({ error: 'signalId must be a signal id returned by Find prior signals.' });
    expect(await call('decideSignal', { signalId: SIG, decision: 'maybe' }, panel)).toEqual({ error: 'decision must be confirm, reject or undo.' });
    repoMock.getSignal.mockResolvedValue({ ...row(SIG, 'confirmed', 'e1', 3) });
    expect(await call('decideSignal', { signalId: SIG, decision: 'reject' }, panel)).toEqual({ error: 'This signal is already confirmed. Undo it first.' });
  });
});

describe('teamSpike', () => {
  const CLOUD = '0f3a1b2c-1111-2222-3333-444455556666';
  const ctx = { ...setup, accountId: '557058:aaaaaaaa-bbbb-cccc-dddd-eeee11112222', cloudId: CLOUD };

  beforeEach(() => {
    lookupMock.teamsOf.mockReset().mockImplementation(async (id: string) =>
      id.endsWith('2222') ? { ok: true, status: 200, teams: [{ id: 't1', name: 'Arkana Platform' }] } : { ok: false, status: 200, error: 'Not permitted' },
    );
    lookupMock.contributorsOf.mockReset().mockResolvedValue({ ok: true, status: 200, accountIds: ['557058:aaaaaaaa-bbbb-cccc-dddd-eeee11112222'], truncated: false });
  });

  it('looks up the current user and the given ids, with shortened account ids only', async () => {
    const reply = (await call('teamSpike', { accountIds: ['712020:ffff0000-1111-2222-3333-444455559999', ctx.accountId], pageId: '5079131' }, ctx)) as {
      results: { accountId: string; source: string; ok: boolean; teams: unknown[]; error: string | null }[];
      contributors: { count: number; results: { source: string }[] };
    };
    expect(reply.results).toEqual([
      { accountId: '…11112222', source: 'self', ok: true, status: 200, teams: [{ id: 't1', name: 'Arkana Platform' }], error: null },
      { accountId: '…55559999', source: 'input', ok: false, status: 200, teams: [], error: 'Not permitted' },
    ]);
    expect(reply.contributors).toMatchObject({ pageId: '5079131', ok: true, count: 1, results: [{ source: 'contributor', accountId: '…11112222' }] });
    expect(lookupMock.contributorsOf).toHaveBeenCalledWith('5079131');
    const logged = JSON.stringify((console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).not.toContain('557058:');
    expect(logged).not.toContain('712020:');
  });

  it('rejects malformed input', async () => {
    expect(await call('teamSpike', { accountIds: 'abc' }, ctx)).toEqual({ error: 'accountIds must be a list of account ids.' });
    expect(await call('teamSpike', { accountIds: ['bad id!'] }, ctx)).toEqual({ error: '"…bad id!" is not an account id.' });
    expect(await call('teamSpike', { pageId: 'x1' }, ctx)).toEqual({ error: 'pageId must be a numeric Confluence page id.' });
    expect(lookupMock.teamsOf).not.toHaveBeenCalled();
  });
});

describe('reach resolvers', () => {
  it('traceReach and decideRoute validate their input', async () => {
    const panel = { moduleKey: 'hindsight-incident', accountId: 'acc-1', extension: { issue: { key: 'INC-1' } } };
    expect(await call('traceReach', { signalId: 'x' }, panel)).toEqual({ error: 'signalId must be a signal id returned by Find prior signals.' });
    expect(await call('decideRoute', { routeId: 'x' }, panel)).toEqual({ error: 'routeId must be a route id returned by Propose routes.' });
    expect(await call('decideRoute', { routeId: '44444444-4444-4444-8444-444444444444', status: 'retired' }, panel)).toEqual({ error: 'status must be active or paused.' });
  });
});

describe('Sentinel resolvers', () => {
  const ROUTE = '44444444-4444-4444-8444-444444444444';
  const ALERT = '55555555-5555-4555-8555-555555555555';
  const panel = { moduleKey: 'hindsight-incident', accountId: 'acc-9', extension: { issue: { key: 'INC-1' } } };
  const plat = { id: ROUTE, originIncidentKey: 'INC-1', status: 'active', sourceType: 'confluence_space', sourceKey: 'PLAT', spec: { keywords: ['tls', 'certificate'], target: { teamId: 't1', action: 'mention' } } };
  const alert = (id: string, status: string, artifactId: string) => ({
    id,
    routeId: ROUTE,
    incidentKey: 'INC-1',
    status,
    reason: null,
    source: 'confluence',
    artifactKind: 'comment',
    artifactId,
    artifactTitle: `Page ${artifactId}`,
    artifactUrl: `https://x/wiki/${artifactId}`,
    matchedKeywords: ['tls'],
    targetTeamName: 'Arkana Payments',
    feedback: null,
    createdAt: '2026-11-03T10:00:00.000Z',
  });

  beforeEach(() => {
    jiraMock.getIncidentAsUser.mockReset().mockResolvedValue({ id: '1', fields: {} });
    jiraMock.visibleIssueIds.mockReset().mockResolvedValue(new Set());
    confluenceMock.visiblePageIds.mockReset().mockResolvedValue(new Set(['900']));
    confluenceMock.createFooterCommentAsUser.mockReset().mockResolvedValue({ id: '777' });
    repoMock.listActiveRoutes.mockReset().mockResolvedValue([plat]);
    repoMock.upsertDemoArtifact.mockReset().mockResolvedValue(undefined);
    repoMock.listAlertsForIncident.mockReset().mockResolvedValue([alert(ALERT, 'posted', '900'), alert('a2', 'skipped', '901'), alert('a3', 'posted', '900')]);
    repoMock.getAlert.mockReset().mockResolvedValue(alert(ALERT, 'posted', '900'));
    repoMock.setAlertFeedback.mockReset().mockResolvedValue(1);
  });

  it('postProviderNotice comments as the admin on the demo page, records notice:<n> and queues a delayed fallback', async () => {
    repoMock.listDemoArtifacts.mockResolvedValue([
      { slot: 'distractor:plat-01', artifactId: '5079131', url: 'https://x/wiki/p' },
      { slot: 'notice:1', artifactId: '5079131' },
    ]);
    expect(await call('postProviderNotice')).toEqual({ ready: true, n: 2, incidentKey: 'INC-1', pageUrl: 'https://x/wiki/p' });
    expect(confluenceMock.createFooterCommentAsUser).toHaveBeenCalledWith('5079131', expect.stringContaining('tls'));
    expect(repoMock.upsertDemoArtifact).toHaveBeenCalledWith(expect.objectContaining({ slot: 'notice:2', commentId: '777', createdByApp: false }));
    expect(queue.push).toHaveBeenCalledWith('sentinel', {
      body: expect.objectContaining({ source: 'confluence', kind: 'comment', commentId: '777', attempt: 1 }),
      delayInSeconds: 20,
    });
  });

  it('postProviderNotice needs an active PLAT route and the demo page', async () => {
    repoMock.listActiveRoutes.mockResolvedValue([{ ...plat, sourceKey: 'OTHER' }]);
    expect(await call('postProviderNotice')).toEqual({ error: 'There is no active route on Confluence space PLAT. Approve it on the Routes tab of the demo incident first.' });
    repoMock.listActiveRoutes.mockResolvedValue([plat]);
    repoMock.listDemoArtifacts.mockResolvedValue([]);
    expect(await call('postProviderNotice')).toEqual({ error: 'The demo page is missing. Click Load demo data first.' });
    expect(confluenceMock.createFooterCommentAsUser).not.toHaveBeenCalled();
    expect(queue.push).not.toHaveBeenCalled();
  });

  it('getSentinelAlerts groups per route (latest + posted count) and hides artifacts the user cannot see', async () => {
    confluenceMock.visiblePageIds.mockResolvedValue(new Set(['900']));
    repoMock.listAlertsForIncident.mockResolvedValue([alert('a2', 'skipped', '901'), alert(ALERT, 'posted', '900'), alert('a3', 'posted', '900')]);
    const reply = (await call('getSentinelAlerts', {}, panel)) as { byRoute: Record<string, { postedCount: number; last: { alertId: string; title: string | null; url: string | null } }> };
    expect(reply.byRoute[ROUTE]).toMatchObject({ postedCount: 2, last: { alertId: 'a2', title: null, url: null } });
    jiraMock.getIncidentAsUser.mockResolvedValue(undefined);
    expect(await call('getSentinelAlerts', {}, panel)).toEqual({ error: 'Incident INC-1 was not found, or you do not have permission to view it.' });
  });

  it('alertFeedback stores feedback on a posted alert the user can see', async () => {
    expect(await call('alertFeedback', { alertId: ALERT, feedback: 'useful' }, panel)).toMatchObject({ ready: true, alert: { alertId: ALERT, feedback: 'useful', title: 'Page 900' } });
    expect(repoMock.setAlertFeedback).toHaveBeenCalledWith(ALERT, 'useful');
    expect(await call('alertFeedback', { alertId: ALERT, feedback: 'meh' }, panel)).toEqual({ error: 'feedback must be useful or not_useful.' });
    repoMock.getAlert.mockResolvedValue(alert(ALERT, 'skipped', '900'));
    expect(await call('alertFeedback', { alertId: ALERT, feedback: 'useful' }, panel)).toEqual({ error: 'Feedback can only be given on an alert that was posted.' });
    jiraMock.getIncidentAsUser.mockResolvedValue(undefined);
    expect(await call('alertFeedback', { alertId: ALERT, feedback: 'useful' }, panel)).toEqual({ error: 'This alert was not found.' });
  });

  it('Sentinel settings read the default cap and validate the new one', async () => {
    expect(await call('getSentinelSettings')).toEqual({ ready: true, weeklyCap: 50, max: 1000 });
    expect(await call('saveSentinelSettings', { weeklyCap: '0' })).toEqual({ error: 'The weekly cap must be between 1 and 1000.' });
    expect(await call('saveSentinelSettings', { weeklyCap: 10 })).toEqual({ ready: true, weeklyCap: 10, max: 1000 });
    expect(repoMock.setSetting).toHaveBeenCalledWith('sentinel_weekly_cap', 10);
  });
});
