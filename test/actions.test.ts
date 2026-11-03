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

const { confirmSignal, findPriorSignals } = await import('../src/surfaces/actions');

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
