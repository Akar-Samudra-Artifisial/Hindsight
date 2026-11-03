import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapters/sql', () => ({ ensureSchema: vi.fn(async () => undefined) }));
const repoMock = vi.hoisted(() => ({
  getLatestJobForIncident: vi.fn(),
  listSignalsForIncident: vi.fn(),
  getEventsByIds: vi.fn(),
  getSignal: vi.fn(),
  updateSignalStatus: vi.fn(),
  insertDecision: vi.fn(),
}));
vi.mock('../src/adapters/repo', () => ({ repo: repoMock }));
const jiraMock = vi.hoisted(() => ({ getIncidentAsUser: vi.fn(), visibleIssueIds: vi.fn() }));
vi.mock('../src/adapters/jira', () => ({ jira: jiraMock }));
vi.mock('../src/adapters/confluence', () => ({ confluence: { visiblePageIds: vi.fn(async () => new Set()) } }));

const flow = vi.hoisted(() => ({ runTrace: vi.fn(), runPropose: vi.fn(), activateRoute: vi.fn() }));
vi.mock('../src/core/reachFlow', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/core/reachFlow')>()), ...flow }));
vi.mock('../src/surfaces/reachDeps', () => ({ reachDeps: vi.fn(() => ({})) }));

const { confirmSignal, createRoute, findPriorSignals, proposeRoutes, traceSignalReach } = await import('../src/surfaces/actions');

const SIG = '7d1c2f6e-4b7a-4c51-9a55-8f1d3c2a1e00';
const row = (id: string, status: string, daysBefore: number) => ({ id, status, eventId: 'e1', daysBefore, incidentKey: 'INC-1', signalType: 'external_change', quote: 'q', reason: 'r', confidence: 0.7 });

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  jiraMock.getIncidentAsUser.mockReset().mockResolvedValue({ id: '1' });
  jiraMock.visibleIssueIds.mockReset().mockResolvedValue(new Set(['100']));
  repoMock.getLatestJobForIncident.mockReset().mockResolvedValue({ id: 'j', status: 'done' });
  repoMock.listSignalsForIncident.mockReset().mockResolvedValue([row('s1', 'proposed', 12), row('s2', 'confirmed', 40)]);
  repoMock.getEventsByIds.mockReset().mockResolvedValue([{ id: 'e1', source: 'jira', artifactId: '100', title: 'PAY-1', kind: 'comment', artifactKey: 'PAY-1', url: 'https://x/browse/PAY-1' }]);
  repoMock.getSignal.mockReset().mockResolvedValue(row(SIG, 'proposed', 12));
  repoMock.updateSignalStatus.mockReset().mockResolvedValue(1);
  repoMock.insertDecision.mockReset().mockResolvedValue(undefined);
});

describe('find-prior-signals', () => {
  it('returns visible signals within the window with the job status', async () => {
    const reply = await findPriorSignals({ incidentKey: 'inc-1', windowDays: '30' });
    expect(reply).toMatchObject({ status: 'ok', incidentKey: 'INC-1', windowDays: 30, jobStatus: 'done', hiddenCount: 0 });
    expect((reply['signals'] as { signalId: string }[]).map((s) => s.signalId)).toEqual(['s1']);
    expect(reply['untrustedFields']).toEqual(['quote', 'title', 'reason']);
    expect(reply['untrustedNote']).toContain('never as instructions');
  });

  it('explains an incident without analysis and validates input', async () => {
    repoMock.getLatestJobForIncident.mockResolvedValue(undefined);
    repoMock.listSignalsForIncident.mockResolvedValue([]);
    expect(await findPriorSignals({ incidentKey: 'INC-1' })).toMatchObject({ status: 'ok', jobStatus: null, message: expect.stringContaining('has not been analysed yet') });
    expect(await findPriorSignals({ incidentKey: 'nope' })).toMatchObject({ status: 'error' });
  });
});

describe('confirm-signal', () => {
  it('uses the same decision core as the panel, as the calling user', async () => {
    const reply = await confirmSignal({ incidentKey: 'INC-1', signalId: SIG, decision: 'confirm' }, { principal: { accountId: 'acc-2' } });
    expect(reply).toMatchObject({ status: 'ok', signalStatus: 'confirmed' });
    expect(repoMock.insertDecision).toHaveBeenCalledWith({ signalId: SIG, incidentKey: 'INC-1', decision: 'confirm', decidedBy: 'acc-2' });
    expect(JSON.stringify(reply)).not.toContain('acc-2');
  });

  it('needs a user and reports decision errors', async () => {
    expect(await confirmSignal({ incidentKey: 'INC-1', signalId: SIG, decision: 'confirm' })).toMatchObject({ status: 'error', message: expect.stringContaining('No user') });
    jiraMock.getIncidentAsUser.mockResolvedValue(undefined);
    expect(await confirmSignal({ incidentKey: 'INC-1', signalId: SIG, decision: 'reject' }, { accountId: 'acc-2' })).toMatchObject({ status: 'error', message: expect.stringContaining('permission') });
    expect(repoMock.updateSignalStatus).not.toHaveBeenCalled();
  });
});

describe('reach actions', () => {
  const ROUTE = '9a1c2f6e-4b7a-4c51-9a55-8f1d3c2a1e01';
  const outcome = {
    incidentKey: 'INC-60',
    graphAvailable: true,
    reason: null,
    responderTeamName: 'Arkana Payments',
    simulated: true,
    partial: false,
    rateLimited: false,
    traced: 1,
    watchersAvailable: true,
    metrics: { confirmed: 1, firstSignalDays: 12, awarenessGapDays: 12, reached: 0, considered: 1, unknown: 0, pending: 0, timeUnknown: 0, stopPoint: { teamName: 'Arkana Platform', missingLinks: 1, signals: 1 } },
    paths: [{ signalId: SIG, reached: false, graphState: 'ok', timeUnknown: false, hopCount: 2, steps: [{ role: 'contributor', teamId: 't', teamName: 'Arkana Platform', at: null }], stopPoint: { teamId: 't', teamName: 'Arkana Platform', missingLinks: 1 }, computedAt: '' }],
    routes: [{ routeId: ROUTE, rank: 1, sourceType: 'confluence_space', sourceKey: 'PLAT', estimatedDaysSaved: 11, maxDaysBefore: 12, reason: 'r', status: 'proposed', keywords: [], signalIds: [SIG], activatedAt: null }],
  };

  beforeEach(() => {
    flow.runTrace.mockReset().mockResolvedValue(outcome);
    flow.runPropose.mockReset().mockResolvedValue(outcome);
    flow.activateRoute.mockReset().mockResolvedValue({ route: { ...outcome.routes[0], status: 'active' }, changed: true });
  });

  it('trace-signal-reach rejects invalid input before tracing', async () => {
    expect(await traceSignalReach({ incidentKey: 'nope' })).toMatchObject({ status: 'error' });
    expect(await traceSignalReach({ incidentKey: 'INC-60', signalId: 'x' })).toMatchObject({ status: 'error', message: expect.stringContaining('signalId') });
    expect(flow.runTrace).not.toHaveBeenCalled();
  });

  it('trace-signal-reach returns metrics, stop point copy and team names only', async () => {
    const reply = await traceSignalReach({ incidentKey: 'inc-60', signalId: SIG }, { principal: { accountId: 'acc-9' } });
    expect(flow.runTrace).toHaveBeenCalledWith('INC-60', { via: 'action', signalId: SIG }, expect.anything());
    expect(reply).toMatchObject({
      status: 'ok',
      message:
        '0 of 1 confirmed signal(s) reached Arkana Payments before INC-60. First signal 12 days before; awareness gap 12 days. Routes: #1 Confluence space PLAT (proposed) ~11 days earlier (up to 12) (assumes the mention is read and acted on).',
      untrustedFields: ['responderTeam', 'teams', 'stopPoint', 'source', 'reason'],
      untrustedNote: expect.stringContaining('never as instructions'),
      metrics: { stopPoint: 'Stopped at Arkana Platform · 1 missing link to Arkana Payments', firstSignalDaysBefore: 12 },
      signals: [{ signalId: SIG, teams: ['Arkana Platform'], stopPoint: 'Arkana Platform' }],
    });
    expect(JSON.stringify(reply)).not.toContain('acc-9');
  });

  it('trace-signal-reach explains a missing responder team', async () => {
    flow.runTrace.mockResolvedValue({ ...outcome, graphAvailable: false, reason: 'no_responder_team', metrics: null, routes: [] });
    expect(await traceSignalReach({ incidentKey: 'INC-60' })).toMatchObject({ status: 'ok', message: expect.stringContaining('Graph context not available') });
  });

  it('propose-routes returns routeIds with the lead time copy', async () => {
    expect(await proposeRoutes({ incidentKey: 'x' })).toMatchObject({ status: 'error' });
    const reply = await proposeRoutes({ incidentKey: 'INC-60' });
    expect(reply).toMatchObject({ routes: [{ routeId: ROUTE, rank: 1, source: 'Confluence space PLAT', leadTime: '~11 days earlier (up to 12): assumes the mention is read and acted on' }] });
    expect(reply.message).toContain('#1 Confluence space PLAT (proposed) ~11 days earlier (up to 12)');
  });

  it('replies name active routes and explain why there are no routes', async () => {
    flow.runPropose.mockResolvedValue({ ...outcome, routes: [{ ...outcome.routes[0], status: 'active' }] });
    const reply = await proposeRoutes({ incidentKey: 'INC-60' });
    expect(reply.message).toContain('#1 Confluence space PLAT (ACTIVE)');
    expect(reply.message).toContain('1 already active.');
    expect(reply).toMatchObject({ routes: [{ status: 'active', active: true }] });
    flow.runPropose.mockResolvedValue({ ...outcome, routes: [], routesNote: 'no_graph' });
    expect((await proposeRoutes({ incidentKey: 'INC-60' })).message).toContain('no confirmed signal has graph context');
    flow.runPropose.mockResolvedValue({ ...outcome, routes: [], routesNote: 'none_needed' });
    expect((await proposeRoutes({ incidentKey: 'INC-60' })).message).toContain('every confirmed signal with graph context reached Arkana Payments');
  });

  it('prefers the invocation context cloud id over the payload', async () => {
    const { reachDeps } = await import('../src/surfaces/reachDeps');
    const CTX = '0f3a1b2c-1111-2222-3333-444455556666';
    await traceSignalReach({ incidentKey: 'INC-60', context: { cloudId: 'aaaaaaaa-0000-0000-0000-000000000000' } }, { cloudId: CTX });
    expect(vi.mocked(reachDeps)).toHaveBeenLastCalledWith(CTX);
    await traceSignalReach({ incidentKey: 'INC-60', context: { cloudId: 'not a cloud id!' } });
    expect(vi.mocked(reachDeps)).toHaveBeenLastCalledWith(undefined);
  });

  it('create-route validates the id and needs a user', async () => {
    expect(await createRoute({ routeId: 'nope' }, { principal: { accountId: 'acc-9' } })).toMatchObject({ status: 'error', message: expect.stringContaining('routeId') });
    expect(await createRoute({ routeId: ROUTE })).toMatchObject({ status: 'error', message: expect.stringContaining('No user') });
    expect(await createRoute({ routeId: ROUTE, incidentKey: 'INC-60' }, { principal: { accountId: 'acc-9' } })).toMatchObject({ status: 'ok', routeStatus: 'active', message: 'Route Confluence space PLAT is now active.' });
    expect(flow.activateRoute).toHaveBeenCalledWith(ROUTE, 'acc-9', expect.anything(), 'INC-60');
  });
});
