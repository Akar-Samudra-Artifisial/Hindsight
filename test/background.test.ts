import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaSettingUpError } from '../src/core/schema';

const sql = vi.hoisted(() => ({ ensureSchema: vi.fn(), requestMigration: vi.fn(), runMigrations: vi.fn() }));
const repoMock = vi.hoisted(() => ({
  saveGraphConnection: vi.fn(),
  acquireAppLock: vi.fn(),
  releaseAppLock: vi.fn(),
  getJob: vi.fn(),
  updateJob: vi.fn(),
  getActiveGraphConnection: vi.fn(),
  listKeptCandidates: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  listDemoArtifacts: vi.fn(),
  getIncident: vi.fn(),
  listSignalsForIncident: vi.fn(),
  candidateStatusCounts: vi.fn(),
  getEventsByIds: vi.fn(),
  upsertSignals: vi.fn(),
  markCandidates: vi.fn(),
  deleteStaleProposedSignals: vi.fn(),
  listReachPaths: vi.fn(async () => []),
  listRoutes: vi.fn(async () => []),
  getScoreCache: vi.fn(async (): Promise<Map<string, unknown>> => new Map()),
  putScoreCache: vi.fn(async (_rows: unknown[]) => 0),
  listActiveRoutes: vi.fn(),
  insertAlert: vi.fn(),
  updateAlert: vi.fn(),
  listAlertsForArtifact: vi.fn(),
  countAlertsSince: vi.fn(),
  listServiceMappings: vi.fn(),
}));
const llm = vi.hoisted(() => ({ pickModels: vi.fn(), chatTool: vi.fn() }));
vi.mock('@forge/llm', () => ({ chat: vi.fn(), list: vi.fn() }));
vi.mock('../src/llm', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/llm')>()), ...llm }));
const tw = vi.hoisted(() => ({ writeDossier: vi.fn() }));
const jiraMock = vi.hoisted(() => ({ getIssueSelf: vi.fn(), getIssueForSentinel: vi.fn(), getComment: vi.fn(), addComment: vi.fn(), siteUrl: vi.fn() }));
const confluenceMock = vi.hoisted(() => ({ getSentinelContent: vi.fn(), createFooterComment: vi.fn() }));
vi.mock('../src/adapters/teamworkGraph', () => tw);
vi.mock('../src/adapters/jira', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/jira')>();
  return { ...actual, jira: { ...actual.jira, ...jiraMock } };
});
vi.mock('../src/adapters/confluence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/confluence')>();
  return { ...actual, confluence: { ...actual.confluence, ...confluenceMock } };
});
const queue = vi.hoisted(() => ({ push: vi.fn() }));
const collect = vi.hoisted(() => ({ runCollectStep: vi.fn() }));
vi.mock('../src/adapters/sql', () => sql);
vi.mock('../src/adapters/repo', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/adapters/repo')>()), repo: repoMock }));
vi.mock('@forge/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forge/events')>();
  class Queue {
    readonly key: string;
    constructor(opts: { key: string }) {
      this.key = opts.key;
    }
    push(payload: unknown) {
      return queue.push(this.key, payload);
    }
  }
  return { ...actual, Queue };
});
vi.mock('../src/core/collect', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/core/collect')>()), ...collect }));

const { checkSentinel, collectEvents, demoJob, migrateSchema, onAppLifecycle, onConnectionChange, onWorkEvent, retryLater, SCHEMA_RETRY_SECONDS, scoreCandidates } =
  await import('../src/surfaces/background');
const { JiraError } = await import('../src/adapters/jira');
const { ConfluenceError } = await import('../src/adapters/confluence');

const created = {
  action: 'CREATED',
  connectionId: 'conn-1',
  name: 'Hindsight signals',
  configProperties: { connectorName: 'hindsight-connector', flowName: 'default' },
  context: {},
};

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  sql.ensureSchema.mockReset().mockResolvedValue(undefined);
  sql.requestMigration.mockReset().mockResolvedValue('job-1');
  sql.runMigrations.mockReset().mockResolvedValue({ status: 'done', applied: 8, total: 8 });
  repoMock.saveGraphConnection.mockReset().mockResolvedValue(undefined);
  repoMock.acquireAppLock.mockReset().mockResolvedValue(true);
  repoMock.releaseAppLock.mockReset().mockResolvedValue(undefined);
  repoMock.getJob.mockReset().mockResolvedValue({ id: JOB, incidentKey: 'INC-7' });
  repoMock.updateJob.mockReset().mockResolvedValue(1);
  queue.push.mockReset().mockResolvedValue({ jobId: 'q' });
  collect.runCollectStep.mockReset();
  repoMock.getActiveGraphConnection.mockReset().mockResolvedValue({ connectionId: 'conn-secret', name: 'Hindsight signals' });
  repoMock.listKeptCandidates.mockReset().mockResolvedValue([{ daysBefore: 12 }, { daysBefore: 3 }, { daysBefore: 6 }]);
  repoMock.setSetting.mockReset().mockResolvedValue(undefined);
  repoMock.getSetting.mockReset().mockResolvedValue(undefined);
  repoMock.listDemoArtifacts.mockReset().mockResolvedValue([{ slot: 'incident', artifactKey: 'INC-7' }]);
  tw.writeDossier.mockReset().mockResolvedValue({ success: true, accepted: 1, rejected: 0 });
  jiraMock.getIssueSelf.mockReset().mockResolvedValue({ id: '1', key: 'INC-7', siteUrl: 'https://one.atlassian.net' });
});

const JOB = '0b6c2f6e-4b7a-4c51-9a55-8f1d3c2a1e00';
const counts = { scanned: 7, stored: 6, candidates: 3, truncated: 0 };

describe('onConnectionChange', () => {
  it('saves the connection when the schema is ready', async () => {
    expect(await onConnectionChange(created)).toEqual({ success: true });
    expect(repoMock.saveGraphConnection).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      name: 'Hindsight signals',
      connectorName: 'hindsight-connector',
      flowName: 'default',
      lastAction: 'CREATED',
      status: 'active',
    });
    expect(sql.requestMigration).not.toHaveBeenCalled();
  });

  it('marks DELETED as deleted', async () => {
    expect(await onConnectionChange({ action: 'DELETED', connectionId: 'conn-1' })).toEqual({ success: true });
    expect(repoMock.saveGraphConnection).toHaveBeenCalledWith(expect.objectContaining({ lastAction: 'DELETED', status: 'deleted' }));
  });

  it('queues the change on schema-migrate while the schema is setting up', async () => {
    sql.ensureSchema.mockRejectedValue(new SchemaSettingUpError(3, 8));
    expect(await onConnectionChange(created)).toEqual({ success: true });
    expect(repoMock.saveGraphConnection).not.toHaveBeenCalled();
    expect(sql.requestMigration).toHaveBeenCalledWith('connection', {
      connection: {
        action: 'CREATED',
        connectionId: 'conn-1',
        name: 'Hindsight signals',
        configProperties: { connectorName: 'hindsight-connector', flowName: 'default' },
      },
    });
  });

  it('also queues when saving fails, and still reports success', async () => {
    repoMock.saveGraphConnection.mockRejectedValue(new Error('sql down'));
    expect(await onConnectionChange(created)).toEqual({ success: true });
    expect(sql.requestMigration).toHaveBeenCalledWith('connection', expect.anything());
  });

  it('rejects an unrecognised payload', async () => {
    expect(await onConnectionChange({ action: 'NOPE', connectionId: 'x' })).toMatchObject({ success: false });
    expect(repoMock.saveGraphConnection).not.toHaveBeenCalled();
  });

  it('never logs config values', async () => {
    await onConnectionChange(created);
    const logged = JSON.stringify((console.info as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).not.toContain('hindsight-connector');
    expect(logged).not.toContain('conn-1');
  });
});

describe('onAppLifecycle', () => {
  it('queues a migration run with the event type as reason', async () => {
    await onAppLifecycle({ eventType: 'avi:forge:upgraded:app' });
    expect(sql.requestMigration).toHaveBeenCalledWith('avi:forge:upgraded:app');
  });
});

describe('migrateSchema', () => {
  it('asks for a retry with retryData while migrations are pending, without saving a queued connection', async () => {
    sql.runMigrations.mockResolvedValue({ status: 'pending', applied: 5, total: 8 });
    const result = await migrateSchema({ body: { reason: 'connection', connection: created } });
    expect(result).toMatchObject({ _retry: true, retryOptions: { retryAfter: SCHEMA_RETRY_SECONDS, retryData: { reason: 'schema' } } });
    expect(repoMock.saveGraphConnection).not.toHaveBeenCalled();
  });

  it('saves a queued connection once migrations are done', async () => {
    expect(await migrateSchema({ body: { reason: 'connection', connection: created } })).toBeUndefined();
    expect(repoMock.saveGraphConnection).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'conn-1', status: 'active', lastAction: 'CREATED' }));
  });

  it('does nothing more for a plain migration run', async () => {
    expect(await migrateSchema({ body: { reason: 'avi:forge:upgraded:app' } })).toBeUndefined();
    expect(repoMock.saveGraphConnection).not.toHaveBeenCalled();
  });
});

describe('retryLater', () => {
  it('always carries retryData', () => {
    expect(retryLater(60)).toMatchObject({ retryOptions: { retryAfter: 60, retryData: { reason: 'rate_limited' } } });
    expect(retryLater(30, 'locked')).toMatchObject({ retryOptions: { retryData: { reason: 'locked' } } });
  });
});

describe('collectEvents', () => {
  it('re-queues while there is more work and always releases the job lock', async () => {
    collect.runCollectStep.mockResolvedValue({ status: 'more', counts, phase: 'jira' });
    expect(await collectEvents({ body: { jobId: JOB, attempt: 2 } })).toBeUndefined();
    expect(repoMock.acquireAppLock).toHaveBeenCalledWith(`job:${JOB}`, expect.any(String), 900);
    expect(queue.push).toHaveBeenCalledWith('collect', { body: { jobId: JOB, attempt: 1 } });
    expect(repoMock.releaseAppLock).toHaveBeenCalledWith(`job:${JOB}`);
  });

  it('queues score when collect is finalized', async () => {
    collect.runCollectStep.mockResolvedValue({ status: 'finalized', counts });
    await collectEvents({ body: { jobId: JOB, attempt: 1 } });
    expect(queue.push).toHaveBeenCalledWith('score', { body: { jobId: JOB } });
    expect(repoMock.releaseAppLock).toHaveBeenCalledWith('analyze:INC-7');
    expect(console.info).toHaveBeenCalledWith('collect finalized', { jobId: JOB, ...counts });
  });

  it('on 429 re-queues with attempt + 1 after 60 s, and fails the job after 3 attempts', async () => {
    collect.runCollectStep.mockResolvedValue({ status: 'rate_limited', counts, phase: 'confluence' });
    await collectEvents({ body: { jobId: JOB, attempt: 2 } });
    expect(queue.push).toHaveBeenCalledWith('collect', { body: { jobId: JOB, attempt: 3 }, delayInSeconds: 60 });
    queue.push.mockClear();
    await collectEvents({ body: { jobId: JOB, attempt: 3 } });
    expect(queue.push).not.toHaveBeenCalled();
    expect(repoMock.updateJob).toHaveBeenCalledWith(JOB, expect.objectContaining({ status: 'failed', lastError: 'rate limited' }));
    expect(repoMock.releaseAppLock).toHaveBeenCalledWith('analyze:INC-7');
  });

  it('asks for a retry with retryData while the schema or the job lock is busy', async () => {
    sql.ensureSchema.mockRejectedValueOnce(new SchemaSettingUpError(3, 8));
    expect(await collectEvents({ body: { jobId: JOB } })).toMatchObject({ retryOptions: { retryData: { reason: 'schema' } } });
    repoMock.acquireAppLock.mockResolvedValueOnce(false);
    expect(await collectEvents({ body: { jobId: JOB } })).toMatchObject({ retryOptions: { retryData: { reason: 'locked' } } });
    expect(collect.runCollectStep).not.toHaveBeenCalled();
  });

  it('fails the job on an unexpected error', async () => {
    collect.runCollectStep.mockRejectedValue(new Error('sql down'));
    await collectEvents({ body: { jobId: JOB } });
    expect(repoMock.updateJob).toHaveBeenCalledWith(JOB, expect.objectContaining({ status: 'failed', lastError: 'Error: sql down' }));
    expect(repoMock.releaseAppLock).toHaveBeenCalledWith(`job:${JOB}`);
  });

  it('rejects a body without a valid job id', async () => {
    await expect(collectEvents({ body: { jobId: 'nope' } })).rejects.toThrow('jobId');
  });
});

describe('scoreCandidates (dossier only, gate G3)', () => {
  beforeEach(() => {
    // A job past scoring (setup "Write test dossier"): only the dossier is written, from the kept candidates.
    repoMock.getJob.mockResolvedValue({ id: JOB, incidentKey: 'INC-7', windowDays: 30, candidateCount: 3, status: 'reaching' });
  });

  it('never writes the EVERYONE dossier for a non-demo incident without the opt-in', async () => {
    repoMock.listDemoArtifacts.mockResolvedValue([{ slot: 'incident', artifactKey: 'INC-1' }]);
    await scoreCandidates({ body: { jobId: JOB } });
    expect(tw.writeDossier).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('dossier skipped', { incidentKey: 'INC-7', reason: 'not demo incident' });
    expect(repoMock.setSetting).not.toHaveBeenCalled();
  });

  it('writes for any incident when settings.dossier_all_incidents is true', async () => {
    repoMock.listDemoArtifacts.mockResolvedValue([]);
    repoMock.getSetting.mockImplementation(async (k: string) => (k === 'dossier_all_incidents' ? true : undefined));
    await scoreCandidates({ body: { jobId: JOB } });
    expect(tw.writeDossier).toHaveBeenCalledTimes(1);
  });

  it.each(['collecting', 'failed'])('skips a job that is %s', async (status) => {
    repoMock.getJob.mockResolvedValue({ id: JOB, incidentKey: 'INC-7', windowDays: 30, candidateCount: 0, status });
    await scoreCandidates({ body: { jobId: JOB } });
    expect(tw.writeDossier).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('dossier skipped', { incidentKey: 'INC-7', reason: `job is ${status}` });
  });

  it('writes the dossier through the stored connection and records the outcome', async () => {
    expect(await scoreCandidates({ body: { jobId: JOB } })).toBeUndefined();
    expect(tw.writeDossier).toHaveBeenCalledTimes(1);
    const [connectionId, doc] = tw.writeDossier.mock.calls[0] as [string, { id: string; url: string; description: string }];
    expect(connectionId).toBe('conn-secret');
    expect(doc).toMatchObject({ id: 'dossier-inc-7', url: 'https://one.atlassian.net/browse/INC-7' });
    expect(doc.description).toContain('3 candidate early signals in the 30 days before the incident; the earliest 12 days before');
    expect(console.info).toHaveBeenCalledWith('dossier written', { incidentKey: 'INC-7', accepted: 1, rejected: 0, connectionId: '<redacted>' });
    expect(repoMock.setSetting).toHaveBeenCalledWith('dossier_last', expect.objectContaining({ incidentKey: 'INC-7', accepted: 1, rejected: 0 }));
    expect(JSON.stringify((console.info as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain('conn-secret');
  });

  it('tracks the demo dossier id (once) so Remove demo data can delete it', async () => {
    repoMock.getSetting.mockImplementation(async (k: string) => (k === 'dossier_ids' ? ['dossier-inc-3'] : undefined));
    await scoreCandidates({ body: { jobId: JOB } });
    expect(repoMock.setSetting).toHaveBeenCalledWith('dossier_ids', ['dossier-inc-3', 'dossier-inc-7']);
    repoMock.setSetting.mockClear();
    repoMock.getSetting.mockImplementation(async (k: string) => (k === 'dossier_ids' ? ['dossier-inc-7'] : undefined));
    await scoreCandidates({ body: { jobId: JOB } });
    expect(repoMock.setSetting).not.toHaveBeenCalledWith('dossier_ids', expect.anything());
  });

  it('does not track an opt-in dossier of a non-demo incident', async () => {
    repoMock.listDemoArtifacts.mockResolvedValue([]);
    repoMock.getSetting.mockImplementation(async (k: string) => (k === 'dossier_all_incidents' ? true : undefined));
    await scoreCandidates({ body: { jobId: JOB } });
    expect(tw.writeDossier).toHaveBeenCalledTimes(1);
    expect(repoMock.setSetting).not.toHaveBeenCalledWith('dossier_ids', expect.anything());
  });

  it('skips without a connection', async () => {
    repoMock.getActiveGraphConnection.mockResolvedValue(undefined);
    await scoreCandidates({ body: { jobId: JOB } });
    expect(tw.writeDossier).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('dossier skipped', { incidentKey: 'INC-7', reason: 'no connection' });
    expect(repoMock.setSetting).toHaveBeenCalledWith('dossier_last', expect.objectContaining({ skipped: 'no connection' }));
  });

  it('never throws when the write or a read fails', async () => {
    tw.writeDossier.mockResolvedValue({ success: false, accepted: 0, rejected: 1, error: 'bad object' });
    await expect(scoreCandidates({ body: { jobId: JOB } })).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith('dossier failed', expect.objectContaining({ incidentKey: 'INC-7', error: 'bad object' }));
    jiraMock.getIssueSelf.mockRejectedValue(new Error('Jira 500'));
    await expect(scoreCandidates({ body: { jobId: JOB } })).resolves.toBeUndefined();
    expect(repoMock.setSetting).toHaveBeenLastCalledWith('dossier_last', expect.objectContaining({ error: 'Jira 500' }));
  });

  it('asks for a retry while the schema is setting up, and ignores a body without a job id', async () => {
    sql.ensureSchema.mockRejectedValueOnce(new SchemaSettingUpError(8, 9));
    expect(await scoreCandidates({ body: { jobId: JOB } })).toMatchObject({ retryOptions: { retryData: { reason: 'schema' } } });
    expect(await scoreCandidates({ body: {} })).toBeUndefined();
    expect(tw.writeDossier).not.toHaveBeenCalled();
  });
});

describe('scoreCandidates (LLM scoring)', () => {
  const EXCERPT = 'Heads up: the payment retry loop has no backoff. If the provider slows down, this retry loop could flood it with requests.';
  const cand = (id: string, daysBefore: number) => ({ id, jobId: JOB, incidentKey: 'INC-7', eventId: `e-${id}`, daysBefore, excerpt: EXCERPT, textHash: 'h', status: 'kept' });
  const scoringJob = { id: JOB, incidentKey: 'INC-7', windowDays: 30, candidateCount: 3, status: 'scoring', modelFast: null, promptVersion: null, progress: {}, scope: {} };

  beforeEach(() => {
    repoMock.getJob.mockResolvedValue(scoringJob);
    repoMock.getIncident.mockResolvedValue({ summary: 'Checkout payments failing', keywords: ['payment', 'retry'] });
    repoMock.listSignalsForIncident.mockReset().mockResolvedValueOnce([]).mockResolvedValue([{ status: 'proposed', daysBefore: 12 }]);
    repoMock.candidateStatusCounts.mockReset().mockResolvedValue({ kept: 3 });
    repoMock.listKeptCandidates.mockReset().mockResolvedValueOnce([cand('c1', 12), cand('c2', 3), cand('c3', 6)]).mockResolvedValue([]);
    repoMock.getEventsByIds.mockReset().mockResolvedValue([{ id: 'e-c1', source: 'jira', title: 'PAY-12 retries' }]);
    repoMock.upsertSignals.mockReset().mockResolvedValue(1);
    repoMock.markCandidates.mockReset().mockResolvedValue(1);
    repoMock.deleteStaleProposedSignals.mockReset().mockResolvedValue(0);
    llm.pickModels.mockReset().mockResolvedValue({ fast: 'claude-haiku-4-5-20251001', strong: 'claude-sonnet-4-6' });
    llm.chatTool.mockReset().mockResolvedValue({
      results: [
        { candidateId: 'c1', relevant: true, signalType: 'technical_warning', quote: 'This retry loop could flood it with requests.', reason: 'Names the retry risk.', confidence: 0.9 },
        { candidateId: 'c2', relevant: false, signalType: 'technical_warning', quote: '', reason: '', confidence: 0 },
        { candidateId: 'c3', relevant: true, signalType: 'technical_warning', quote: 'The provider certificate expires next week.', reason: 'x', confidence: 0.5 },
      ],
    });
  });

  it('scores a batch, verifies quotes, finishes the job and refreshes the dossier with the signal count', async () => {
    expect(await scoreCandidates({ body: { jobId: JOB } })).toBeUndefined();
    expect(llm.pickModels).toHaveBeenCalledTimes(1);
    expect(repoMock.updateJob).toHaveBeenCalledWith(JOB, { modelFast: 'claude-haiku-4-5-20251001', modelStrong: 'claude-sonnet-4-6', promptVersion: 'score-v2' });
    expect(llm.chatTool).toHaveBeenCalledWith('claude-haiku-4-5-20251001', expect.any(Array), expect.objectContaining({ name: 'score_candidates' }));
    expect(repoMock.upsertSignals).toHaveBeenCalledWith([expect.objectContaining({ candidateId: 'c1', signalType: 'technical_warning', daysBefore: 12, model: 'claude-haiku-4-5-20251001' })]);
    expect(repoMock.markCandidates).toHaveBeenCalledWith(JOB, ['c1', 'c2'], 'scored', null);
    expect(repoMock.markCandidates).toHaveBeenCalledWith(JOB, ['c3'], 'score_failed', 'quote_not_found');
    expect(repoMock.updateJob).toHaveBeenCalledWith(JOB, expect.objectContaining({ status: 'done' }));
    expect(repoMock.deleteStaleProposedSignals).toHaveBeenCalledWith('INC-7', expect.objectContaining({ id: JOB }));
    // The cleanup runs before `done`, so a redelivery after a crash still repeats it.
    const doneCall = repoMock.updateJob.mock.calls.findIndex(([, patch]) => (patch as { status?: string }).status === 'done');
    expect(repoMock.deleteStaleProposedSignals.mock.invocationCallOrder[0]!).toBeLessThan(repoMock.updateJob.mock.invocationCallOrder[doneCall]!);
    expect(console.info).toHaveBeenCalledWith('llm models', { jobId: JOB, fast: 'claude-haiku-4-5-20251001', strong: 'claude-sonnet-4-6' });
    expect(console.info).toHaveBeenCalledWith('score batch', { jobId: JOB, size: 3, signals: 1, failed: 1, done: 3, total: 3 });
    expect(console.info).toHaveBeenCalledWith('score done', expect.objectContaining({ jobId: JOB, signals: 1, failed: 1 }));
    const [, doc] = tw.writeDossier.mock.calls[0] as [string, { description: string }];
    expect(doc.description).toContain('1 early signal found among 3 candidates in the 30 days before the incident; the earliest 12 days before');
    expect(doc.description).not.toContain('retry loop');
    expect(console.info).toHaveBeenCalledWith('dossier written', expect.objectContaining({ incidentKey: 'INC-7' }));
    // Logs never carry artifact text or quotes.
    const logged = JSON.stringify([(console.info as unknown as { mock: { calls: unknown[] } }).mock.calls, (console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls]);
    expect(logged).not.toContain('flood');
    expect(repoMock.releaseAppLock).toHaveBeenCalledWith(`job:${JOB}`);
  });

  it('demo incident: first run asks the model and caches every verdict, relevant or not', async () => {
    repoMock.putScoreCache.mockClear();
    repoMock.getScoreCache.mockClear();
    await scoreCandidates({ body: { jobId: JOB } });
    expect(repoMock.getScoreCache).toHaveBeenCalledWith('INC-7', 'score-v2', ['e-c1', 'e-c2', 'e-c3']);
    const rows = repoMock.putScoreCache.mock.calls[0]![0] as { eventId: string; relevant: boolean; textHash: string; promptVersion: string; model: string }[];
    expect(rows.map((r) => [r.eventId, r.relevant])).toEqual([
      ['e-c1', true],
      ['e-c2', false],
      ['e-c3', true],
    ]);
    expect(rows[0]).toMatchObject({ textHash: 'h', promptVersion: 'score-v2', model: 'claude-haiku-4-5-20251001' });
    expect(console.info).toHaveBeenCalledWith('score cache', { jobId: JOB, incidentKey: 'INC-7', hits: 0, misses: 3 });
  });

  it('demo incident: Analyze again replays cached verdicts without calling the model', async () => {
    const verdict = (relevant: boolean, quote = '', confidence = 0) => ({ relevant, signalType: relevant ? 'technical_warning' : null, quote, reason: relevant ? 'Names the retry risk.' : '', confidence, model: 'claude-haiku-4-5-20251001' });
    repoMock.getScoreCache.mockResolvedValueOnce(
      new Map([
        ['e-c1|h', verdict(true, 'This retry loop could flood it with requests.', 0.9)],
        ['e-c2|h', verdict(false)],
        ['e-c3|h', verdict(false)],
      ]),
    );
    repoMock.putScoreCache.mockClear();
    await scoreCandidates({ body: { jobId: JOB } });
    expect(llm.chatTool).not.toHaveBeenCalled();
    expect(repoMock.putScoreCache).not.toHaveBeenCalled();
    expect(repoMock.upsertSignals).toHaveBeenCalledWith([expect.objectContaining({ candidateId: 'c1', confidence: 0.9, model: 'claude-haiku-4-5-20251001' })]);
    expect(repoMock.markCandidates).toHaveBeenCalledWith(JOB, ['c1', 'c2', 'c3'], 'scored', null);
    expect(console.info).toHaveBeenCalledWith('score cache', { jobId: JOB, incidentKey: 'INC-7', hits: 3, misses: 0 });
  });

  it('non-demo incident never uses the cache', async () => {
    repoMock.listDemoArtifacts.mockResolvedValue([]);
    repoMock.getScoreCache.mockClear();
    repoMock.putScoreCache.mockClear();
    await scoreCandidates({ body: { jobId: JOB } });
    expect(llm.chatTool).toHaveBeenCalled();
    expect(repoMock.getScoreCache).not.toHaveBeenCalled();
    expect(repoMock.putScoreCache).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalledWith('score cache', expect.anything());
  });

  it('stores the verbatim span of the excerpt as the quote, not the model rendering', async () => {
    await scoreCandidates({ body: { jobId: JOB } });
    expect(repoMock.upsertSignals).toHaveBeenCalledWith([expect.objectContaining({ quote: 'this retry loop could flood it with requests.' })]);
  });

  it('does not mark the job done when the stale cleanup fails, so a redelivery can repeat it', async () => {
    repoMock.deleteStaleProposedSignals.mockRejectedValue(new Error('sql down'));
    await expect(scoreCandidates({ body: { jobId: JOB } })).rejects.toThrow('sql down');
    expect(repoMock.updateJob).not.toHaveBeenCalledWith(JOB, expect.objectContaining({ status: 'done' }));
    expect(repoMock.releaseAppLock).toHaveBeenCalledWith(`job:${JOB}`);
  });

  it('resumes with the stored model and progress, without picking models again', async () => {
    repoMock.getJob.mockResolvedValue({ ...scoringJob, modelFast: 'claude-haiku-x', promptVersion: 'score-v1', progress: { score: { signals: 2 } } });
    repoMock.candidateStatusCounts.mockResolvedValue({ kept: 3, scored: 10, score_failed: 1 });
    await scoreCandidates({ body: { jobId: JOB, attempt: 1 } });
    expect(llm.pickModels).not.toHaveBeenCalled();
    expect(llm.chatTool).toHaveBeenCalledWith('claude-haiku-x', expect.any(Array), expect.anything());
    expect(console.info).toHaveBeenCalledWith('score batch', { jobId: JOB, size: 3, signals: 1, failed: 1, done: 14, total: 14 });
    expect(console.info).toHaveBeenCalledWith('score done', expect.objectContaining({ signals: 3, failed: 2, total: 14 }));
  });

  it('on a 429 re-queues with attempt + 1 after 60 s, and fails the job after 3 attempts', async () => {
    llm.chatTool.mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 }));
    await scoreCandidates({ body: { jobId: JOB, attempt: 2 } });
    expect(queue.push).toHaveBeenCalledWith('score', { body: { jobId: JOB, attempt: 3 }, delayInSeconds: 60 });
    expect(repoMock.markCandidates).not.toHaveBeenCalled();
    queue.push.mockClear();
    repoMock.listKeptCandidates.mockResolvedValue([cand('c1', 12)]);
    await scoreCandidates({ body: { jobId: JOB, attempt: 3 } });
    expect(queue.push).not.toHaveBeenCalled();
    expect(repoMock.updateJob).toHaveBeenCalledWith(JOB, expect.objectContaining({ status: 'failed', lastError: expect.stringContaining('LLM rate limited') }));
  });

  it('retries invalid output once, then marks the batch llm_invalid_output', async () => {
    const { LlmOutputError } = await import('../src/llm');
    llm.chatTool.mockRejectedValue(new LlmOutputError('no tool call'));
    await scoreCandidates({ body: { jobId: JOB } });
    expect(llm.chatTool).toHaveBeenCalledTimes(2);
    expect(repoMock.markCandidates).toHaveBeenCalledWith(JOB, ['c1', 'c2', 'c3'], 'score_failed', 'llm_invalid_output');
    expect(repoMock.updateJob).toHaveBeenCalledWith(JOB, expect.objectContaining({ status: 'done' }));
  });

  it('fails the job with a clear message when no Forge LLM model is available', async () => {
    const { LlmUnavailableError } = await import('../src/llm');
    llm.pickModels.mockRejectedValue(new LlmUnavailableError());
    await scoreCandidates({ body: { jobId: JOB } });
    expect(repoMock.updateJob).toHaveBeenCalledWith(JOB, expect.objectContaining({ status: 'failed', lastError: 'No Forge LLM model available' }));
    expect(llm.chatTool).not.toHaveBeenCalled();
    expect(repoMock.releaseAppLock).toHaveBeenCalledWith(`job:${JOB}`);
  });

  it('asks for a retry while another run holds the job lock', async () => {
    repoMock.acquireAppLock.mockResolvedValueOnce(false);
    expect(await scoreCandidates({ body: { jobId: JOB } })).toMatchObject({ retryOptions: { retryData: { reason: 'locked' } } });
    expect(llm.chatTool).not.toHaveBeenCalled();
  });
});

describe('demoJob consumer', () => {
  it('asks for a retry with retryData while the schema is setting up', async () => {
    sql.ensureSchema.mockRejectedValueOnce(new SchemaSettingUpError(8, 9));
    expect(await demoJob({ body: { jobId: JOB, attempt: 1 } })).toMatchObject({ retryOptions: { retryData: { reason: 'schema' } } });
  });

  it('ignores an event for a job that is not the current one', async () => {
    repoMock.getSetting.mockResolvedValue(undefined);
    expect(await demoJob({ body: { jobId: JOB, attempt: 1 } })).toBeUndefined();
    expect(console.info).toHaveBeenCalledWith('demo job: event ignored', expect.objectContaining({ jobId: JOB }));
  });

  it('rejects a body without a valid job id', async () => {
    await expect(demoJob({ body: { jobId: 'x' } })).rejects.toThrow('jobId');
  });
});

describe('Sentinel', () => {
  const ROUTE = {
    id: 'ro1',
    originIncidentKey: 'INC-60',
    sourceType: 'confluence_space',
    sourceKey: 'PLAT',
    spec: { keywords: ['gateway'], target: { teamId: 't-pay', action: 'mention' } },
    status: 'active',
  };
  const commentEvent = { eventType: 'avi:confluence:created:comment', atlassianId: 'acc-human', content: { id: '901', space: { key: 'PLAT' } } };
  const commentBody = { v: 1, source: 'confluence', kind: 'comment', artifactId: '', commentId: '901', eventType: 'avi:confluence:created:comment', attempt: 1 };
  // `SentinelContent` (the adapter's v2 / search mapping is tested in confluence.test.ts).
  const content = (over: Record<string, unknown> = {}) => ({
    type: 'comment',
    id: '901',
    pageId: '900',
    pageTitle: 'Build pipeline conventions',
    spaceKey: 'PLAT',
    storage: '<p>Provider notice #1: gateway change</p>',
    createdBy: { accountId: 'acc-human', accountType: 'atlassian' },
    versionBy: { accountId: 'acc-human', accountType: 'atlassian' },
    links: { base: 'https://one.atlassian.net/wiki', webui: '/spaces/PLAT/pages/900?focusedCommentId=901' },
    ...over,
  });

  beforeEach(() => {
    repoMock.listActiveRoutes.mockReset().mockResolvedValue([ROUTE]);
    repoMock.insertAlert.mockReset().mockResolvedValue('alert-1');
    repoMock.updateAlert.mockReset().mockResolvedValue(1);
    repoMock.listAlertsForArtifact.mockReset().mockResolvedValue([]);
    // Counted after the run's own row is inserted, so 1 = only this alert.
    repoMock.countAlertsSince.mockReset().mockResolvedValue(1);
    repoMock.listServiceMappings.mockReset().mockResolvedValue([{ serviceKey: 'checkout', ownerTeamId: 't-pay', ownerTeamName: 'Arkana Payments', aliases: [] }]);
    repoMock.getIncident.mockReset().mockResolvedValue(undefined);
    jiraMock.siteUrl.mockReset().mockResolvedValue('https://one.atlassian.net');
    jiraMock.getIssueForSentinel.mockReset();
    jiraMock.getComment.mockReset();
    jiraMock.addComment.mockReset().mockResolvedValue({ id: '555' });
    confluenceMock.getSentinelContent.mockReset().mockResolvedValue(content());
    confluenceMock.createFooterComment.mockReset().mockResolvedValue({ id: '777', via: 'v2' });
  });

  describe('onWorkEvent', () => {
    it('queues an event an active route could cover, without text or account ids', async () => {
      await onWorkEvent(commentEvent);
      expect(console.info).toHaveBeenCalledWith('on-work-event received', { eventType: 'avi:confluence:created:comment' });
      expect(queue.push).toHaveBeenCalledWith('sentinel', { body: commentBody });
      expect(console.info).toHaveBeenCalledWith('sentinel queued', expect.objectContaining({ source: 'confluence', kind: 'comment' }));
      expect(JSON.stringify(queue.push.mock.calls)).not.toContain('acc-human');
    });

    it('skips self-generated events and events by a known app account', async () => {
      await onWorkEvent({ ...commentEvent, selfGenerated: true });
      repoMock.getSetting.mockResolvedValue(['acc-human']);
      await onWorkEvent(commentEvent);
      expect(queue.push).not.toHaveBeenCalled();
      expect(vi.mocked(console.info).mock.calls.filter((c) => c[0] === 'sentinel skipped' && (c[1] as { reason: string }).reason === 'self')).toHaveLength(2);
    });

    it('skips without an active route, or when no route covers the space', async () => {
      repoMock.listActiveRoutes.mockResolvedValueOnce([]);
      await onWorkEvent(commentEvent);
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'no_active_route' }));
      await onWorkEvent({ ...commentEvent, content: { id: '901', space: { key: 'OPS' } } });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'source_mismatch' }));
      expect(queue.push).not.toHaveBeenCalled();
    });

    it('never throws: unsupported events and schema errors are skipped', async () => {
      await onWorkEvent({ eventType: 'avi:jira:deleted:issue' });
      sql.ensureSchema.mockRejectedValueOnce(new SchemaSettingUpError(15, 16));
      await onWorkEvent(commentEvent);
      expect(queue.push).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'schema_not_ready' }));
    });
  });

  describe('checkSentinel', () => {
    it('matches, records the alert and posts one footer comment on the page, under a lock', async () => {
      expect(await checkSentinel({ body: commentBody })).toBeUndefined();
      expect(repoMock.acquireAppLock).toHaveBeenCalledWith('sentinel:confluence.0.901', expect.any(String), 300);
      expect(console.info).toHaveBeenCalledWith('sentinel matched', { routeId: 'ro1', artifact: 'confluence:comment:900/901' });
      expect(repoMock.insertAlert).toHaveBeenCalledWith(
        expect.objectContaining({ routeId: 'ro1', incidentKey: 'INC-60', artifactId: '900', commentId: '901', matchedKeywords: ['gateway'], targetTeamName: 'Arkana Payments', status: 'failed', reason: 'posting' }),
      );
      const [pageId, storage] = confluenceMock.createFooterComment.mock.calls[0]!;
      expect(pageId).toBe('900');
      expect(storage).toContain('[Hindsight Sentinel]');
      expect(storage).toContain('<strong>Arkana Payments</strong>');
      expect(storage).toContain('https://one.atlassian.net/browse/INC-60');
      // Neutral comment: the matched keyword and the route source are not repeated.
      expect(storage).not.toMatch(/gateway|PLAT|keyword/i);
      expect(repoMock.updateAlert).toHaveBeenCalledWith('alert-1', { status: 'posted', reason: null, postedCommentId: '777', error: null });
      expect(console.info).toHaveBeenCalledWith('alert posted', { alertId: 'alert-1', commentId: '777' });
      expect(repoMock.releaseAppLock).toHaveBeenCalledWith('sentinel:confluence.0.901');
    });

    it('skips an app-written artifact (and learns the app account) or a marked one whose account type is unknown (v2)', async () => {
      confluenceMock.getSentinelContent.mockResolvedValueOnce(content({ createdBy: { accountId: 'app-9', accountType: 'app' } }));
      await checkSentinel({ body: commentBody });
      expect(repoMock.setSetting).toHaveBeenCalledWith('app_account_ids', ['app-9']);
      confluenceMock.getSentinelContent.mockResolvedValueOnce(content({ createdBy: { accountId: 'app-x' }, storage: '<p><strong>[Hindsight Sentinel]</strong> gateway</p>' }));
      await checkSentinel({ body: commentBody });
      expect(confluenceMock.createFooterComment).not.toHaveBeenCalled();
      expect(vi.mocked(console.info).mock.calls.filter((c) => c[0] === 'sentinel skipped' && (c[1] as { reason: string }).reason === 'self')).toHaveLength(2);
    });

    it('a person typing the Sentinel marker is still alerted (marker spoof does not suppress)', async () => {
      confluenceMock.getSentinelContent.mockResolvedValueOnce(content({ storage: '<p>[Hindsight Sentinel] gateway change</p>' }));
      await checkSentinel({ body: commentBody });
      expect(confluenceMock.createFooterComment).toHaveBeenCalledTimes(1);
    });

    it('skips when no active route is left, or nothing matches', async () => {
      repoMock.listActiveRoutes.mockResolvedValueOnce([]);
      await checkSentinel({ body: commentBody });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'no_active_route' }));
      confluenceMock.getSentinelContent.mockResolvedValueOnce(content({ storage: '<p>Lunch menu</p>' }));
      await checkSentinel({ body: commentBody });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'no_match' }));
      expect(repoMock.insertAlert).not.toHaveBeenCalled();
    });

    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

    it('dedup: a posted alert for the same route and artifact, however old → no new alert and no new row', async () => {
      repoMock.listAlertsForArtifact.mockResolvedValueOnce([{ status: 'posted', reason: null, createdAt: ago(60 * 24 * 40) }]);
      await checkSentinel({ body: commentBody });
      expect(repoMock.listAlertsForArtifact).toHaveBeenCalledWith('ro1', '900', '901');
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'dedup' }));
      expect(repoMock.insertAlert).not.toHaveBeenCalled();
      expect(confluenceMock.createFooterComment).not.toHaveBeenCalled();
    });

    it('updated:page re-fires for the same page never re-alert (lifetime dedup per route and page)', async () => {
      const pageBody = { v: 1, source: 'confluence', kind: 'page', artifactId: '900', commentId: '', eventType: 'avi:confluence:updated:page', attempt: 1 };
      confluenceMock.getSentinelContent.mockResolvedValue(
        content({ id: '900', type: 'page', pageId: '900', pageTitle: 'Gateway notes', versionBy: { accountId: 'acc-human' }, links: {} }),
      );
      await checkSentinel({ body: pageBody });
      expect(confluenceMock.createFooterComment).toHaveBeenCalledTimes(1);
      repoMock.listAlertsForArtifact.mockResolvedValue([{ status: 'posted', reason: null, createdAt: ago(60 * 25) }]);
      await checkSentinel({ body: pageBody });
      expect(repoMock.listAlertsForArtifact).toHaveBeenLastCalledWith('ro1', '900', '');
      expect(confluenceMock.createFooterComment).toHaveBeenCalledTimes(1);
      expect(repoMock.insertAlert).toHaveBeenCalledTimes(1);
    });

    it('a crash after posting (row left failed/posting) never leads to a second post', async () => {
      repoMock.listAlertsForArtifact.mockResolvedValueOnce([{ status: 'failed', reason: 'posting', createdAt: ago(5) }]);
      await checkSentinel({ body: commentBody });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'in_flight' }));
      expect(repoMock.insertAlert).not.toHaveBeenCalled();
      expect(confluenceMock.createFooterComment).not.toHaveBeenCalled();
    });

    it('repeated failures back off (1 h) and stop after 3, without new rows', async () => {
      repoMock.listAlertsForArtifact.mockResolvedValueOnce([{ status: 'failed', reason: 'api_error', createdAt: ago(10) }]);
      await checkSentinel({ body: commentBody });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'backoff' }));
      repoMock.listAlertsForArtifact.mockResolvedValueOnce([
        { status: 'failed', reason: 'api_error', createdAt: ago(300) },
        { status: 'failed', reason: 'api_error', createdAt: ago(200) },
        { status: 'failed', reason: 'rate_limited', createdAt: ago(100) },
      ]);
      await checkSentinel({ body: commentBody });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'gave_up' }));
      expect(repoMock.insertAlert).not.toHaveBeenCalled();
      expect(confluenceMock.createFooterComment).not.toHaveBeenCalled();
    });

    it('weekly cap: the row is inserted first, then the cap is recounted; over the cap → skipped, nothing posted', async () => {
      repoMock.countAlertsSince.mockResolvedValueOnce(51);
      await checkSentinel({ body: commentBody });
      expect(repoMock.insertAlert).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', reason: 'posting' }));
      expect(repoMock.countAlertsSince).toHaveBeenCalledWith(expect.any(String), 't-pay');
      expect(repoMock.updateAlert).toHaveBeenCalledWith('alert-1', { status: 'skipped', reason: 'weekly_cap' });
      expect(confluenceMock.createFooterComment).not.toHaveBeenCalled();
      // At the cap (own row included) is still allowed; the setting overrides the default.
      repoMock.getSetting.mockImplementation(async (k: string) => (k === 'sentinel_weekly_cap' ? 60 : undefined));
      repoMock.countAlertsSince.mockResolvedValueOnce(60).mockResolvedValueOnce(1);
      await checkSentinel({ body: commentBody });
      expect(confluenceMock.createFooterComment).toHaveBeenCalledTimes(1);
    });

    it('daily cap over all teams (default 200, setting sentinel_daily_cap)', async () => {
      repoMock.countAlertsSince.mockImplementation(async (_since: string, teamId?: string) => (teamId ? 1 : 201));
      await checkSentinel({ body: commentBody });
      expect(repoMock.updateAlert).toHaveBeenCalledWith('alert-1', { status: 'skipped', reason: 'daily_cap' });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'daily_cap', cap: 200 }));
      expect(confluenceMock.createFooterComment).not.toHaveBeenCalled();
      repoMock.getSetting.mockImplementation(async (k: string) => (k === 'sentinel_daily_cap' ? 500 : undefined));
      await checkSentinel({ body: commentBody });
      expect(confluenceMock.createFooterComment).toHaveBeenCalledTimes(1);
    });

    it('one comment per team even when two routes match', async () => {
      repoMock.listActiveRoutes.mockResolvedValue([ROUTE, { ...ROUTE, id: 'ro2' }]);
      await checkSentinel({ body: commentBody });
      expect(confluenceMock.createFooterComment).toHaveBeenCalledTimes(1);
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'team_already_alerted', routeId: 'ro2' }));
    });

    it('on 429 marks the alert rate limited and re-queues after 60 s with attempt + 1, at most 3 attempts', async () => {
      confluenceMock.createFooterComment.mockRejectedValue(new ConfluenceError(429, 'Confluence comment 429: slow down'));
      await checkSentinel({ body: commentBody });
      expect(repoMock.updateAlert).toHaveBeenCalledWith('alert-1', expect.objectContaining({ status: 'failed', reason: 'rate_limited' }));
      expect(queue.push).toHaveBeenCalledWith('sentinel', { body: { ...commentBody, attempt: 2 }, delayInSeconds: 60 });
      queue.push.mockClear();
      await checkSentinel({ body: { ...commentBody, attempt: 3 } });
      expect(queue.push).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith('sentinel: rate limited, gave up', { attempt: 3 });
    });

    it('a 403 marks the alert failed (api_error) without a retry', async () => {
      confluenceMock.createFooterComment.mockRejectedValue(new ConfluenceError(403, 'Confluence comment 403: forbidden'));
      expect(await checkSentinel({ body: commentBody })).toBeUndefined();
      expect(repoMock.updateAlert).toHaveBeenCalledWith('alert-1', { status: 'failed', reason: 'api_error', error: 'Confluence comment 403: forbidden' });
      expect(queue.push).not.toHaveBeenCalled();
    });

    it('a permanent read failure (410 removed endpoint, 404) is skipped with a reason, never re-queued', async () => {
      confluenceMock.getSentinelContent.mockRejectedValueOnce(new ConfluenceError(410, 'Confluence get content 5472298 410: This deprecated endpoint has been removed.'));
      expect(await checkSentinel({ body: commentBody })).toBeUndefined();
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'read_failed_410' }));
      expect(console.error).not.toHaveBeenCalledWith('sentinel failed', expect.anything());
      confluenceMock.getSentinelContent.mockResolvedValueOnce(undefined);
      await checkSentinel({ body: commentBody });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'not_found' }));
      expect(queue.push).not.toHaveBeenCalled();
      expect(repoMock.insertAlert).not.toHaveBeenCalled();
    });

    it('a comment the search index does not have yet is re-queued on 60, 90, 120, 120, 120, 120 s (~10 min), then gives up', async () => {
      confluenceMock.getSentinelContent.mockResolvedValue('not_indexed');
      const delays: number[] = [];
      for (let attempt = 1; attempt <= 7; attempt += 1) {
        queue.push.mockClear();
        await checkSentinel({ body: { ...commentBody, attempt } });
        const call = queue.push.mock.calls[0] as unknown[] | undefined;
        if (call) {
          expect(call[1]).toEqual({ body: { ...commentBody, attempt: attempt + 1 }, delayInSeconds: expect.any(Number) });
          delays.push((call[1] as { delayInSeconds: number }).delayInSeconds);
        }
      }
      expect(delays).toEqual([60, 90, 120, 120, 120, 120]);
      expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(600);
      expect(Math.max(...delays)).toBeLessThanOrEqual(900);
      expect(console.warn).toHaveBeenCalledWith('sentinel: not indexed yet, gave up', { attempt: 7 });
      // 429 keeps its own limit of 3 attempts.
      expect(console.warn).not.toHaveBeenCalledWith('sentinel: rate limited, gave up', expect.anything());
    });

    it('one retry chain per artifact: a second attempt-1 delivery (backup copy) is skipped while the chain runs', async () => {
      confluenceMock.getSentinelContent.mockResolvedValue('not_indexed');
      // First delivery: takes the artifact lock and the chain lock, re-queues, keeps the chain lock.
      await checkSentinel({ body: commentBody });
      expect(repoMock.acquireAppLock).toHaveBeenCalledWith('sentinel-chain:confluence.0.901', expect.any(String), 900);
      expect(repoMock.releaseAppLock).not.toHaveBeenCalledWith('sentinel-chain:confluence.0.901');
      expect(queue.push).toHaveBeenCalledTimes(1);
      // Backup copy: the artifact lock is free, the chain lock is held → skipped, no read, no re-queue.
      repoMock.acquireAppLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      confluenceMock.getSentinelContent.mockClear();
      await checkSentinel({ body: commentBody });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'chain_active' }));
      expect(confluenceMock.getSentinelContent).not.toHaveBeenCalled();
      expect(queue.push).toHaveBeenCalledTimes(1);
      expect(repoMock.releaseAppLock).not.toHaveBeenCalledWith('sentinel-chain:confluence.0.901');
      // The chain's own re-queued delivery does not need the chain lock; once it posts, the chain lock is freed.
      confluenceMock.getSentinelContent.mockResolvedValue(content());
      repoMock.acquireAppLock.mockClear();
      await checkSentinel({ body: { ...commentBody, attempt: 2 } });
      expect(repoMock.acquireAppLock).toHaveBeenCalledTimes(1);
      expect(confluenceMock.createFooterComment).toHaveBeenCalledTimes(1);
      expect(repoMock.releaseAppLock).toHaveBeenCalledWith('sentinel-chain:confluence.0.901');
    });

    it('a comment on a blog post (no page) is skipped; the v2 author of a posted comment is learned as an app account', async () => {
      confluenceMock.getSentinelContent.mockResolvedValueOnce(content({ pageId: null }));
      await checkSentinel({ body: commentBody });
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'not_on_page' }));
      confluenceMock.createFooterComment.mockResolvedValueOnce({ id: '778', via: 'v2', authorId: 'app-hs' });
      await checkSentinel({ body: commentBody });
      expect(repoMock.setSetting).toHaveBeenCalledWith('app_account_ids', ['app-hs']);
    });

    it('builds the comment link from the site URL when v2 gives no base', async () => {
      confluenceMock.getSentinelContent.mockResolvedValueOnce(content({ links: { webui: '/spaces/PLAT/pages/900?focusedCommentId=901' } }));
      await checkSentinel({ body: commentBody });
      expect(repoMock.insertAlert).toHaveBeenCalledWith(expect.objectContaining({ artifactUrl: 'https://one.atlassian.net/wiki/spaces/PLAT/pages/900?focusedCommentId=901' }));
    });

    it('Jira comment: posts on the issue (ADF); a restricted comment is skipped', async () => {
      const body = { v: 1, source: 'jira', kind: 'comment', artifactId: '10001', commentId: '200', eventType: 'avi:jira:commented:issue', attempt: 1 };
      repoMock.listActiveRoutes.mockResolvedValue([{ ...ROUTE, sourceType: 'jira_project', sourceKey: 'PAY' }]);
      jiraMock.getIssueForSentinel.mockResolvedValue({ id: '10001', key: 'PAY-7', fields: { summary: 'Release notes', project: { key: 'PAY' } } });
      jiraMock.getComment.mockResolvedValueOnce({ id: '200', author: { accountId: 'u', accountType: 'atlassian' }, body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'gateway timeout' }] }] } });
      await checkSentinel({ body });
      expect(jiraMock.addComment).toHaveBeenCalledWith('10001', expect.objectContaining({ type: 'doc' }), { internal: false });
      expect(repoMock.insertAlert).toHaveBeenCalledWith(expect.objectContaining({ artifactUrl: 'https://one.atlassian.net/browse/PAY-7?focusedCommentId=200', artifactTitle: 'Release notes' }));
      jiraMock.addComment.mockClear();
      jiraMock.getComment.mockResolvedValueOnce({ id: '200', visibility: { type: 'role', value: 'Developers' }, body: 'gateway' });
      await checkSentinel({ body });
      expect(jiraMock.addComment).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledWith('sentinel skipped', expect.objectContaining({ reason: 'restricted' }));
    });

    it('on a JSM (service_desk) issue the alert is an internal note', async () => {
      const body = { v: 1, source: 'jira', kind: 'issue', artifactId: '10002', commentId: '', eventType: 'avi:jira:created:issue', attempt: 1 };
      repoMock.listActiveRoutes.mockResolvedValue([{ ...ROUTE, sourceType: 'jira_project', sourceKey: 'INC' }]);
      jiraMock.getIssueForSentinel.mockResolvedValue({
        id: '10002',
        key: 'INC-70',
        fields: { summary: 'Gateway errors at checkout', project: { key: 'INC', projectTypeKey: 'service_desk' }, creator: { accountId: 'cust', accountType: 'customer' } },
      });
      await checkSentinel({ body });
      expect(jiraMock.addComment).toHaveBeenCalledWith('10002', expect.objectContaining({ type: 'doc' }), { internal: true });
    });

    it('a 429 while reading the artifact re-queues too; an invalid body is ignored', async () => {
      const body = { v: 1, source: 'jira', kind: 'issue', artifactId: '10001', commentId: '', eventType: 'avi:jira:created:issue', attempt: 1 };
      jiraMock.getIssueForSentinel.mockRejectedValueOnce(new JiraError(429, 'Jira 429: slow down'));
      await checkSentinel({ body });
      expect(queue.push).toHaveBeenCalledWith('sentinel', { body: { ...body, attempt: 2 }, delayInSeconds: 60 });
      expect(await checkSentinel({ body: { v: 1, source: 'jira' } })).toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith('sentinel: invalid event ignored', expect.anything());
    });

    it('asks for a retry with retryData while the schema or the lock is busy', async () => {
      sql.ensureSchema.mockRejectedValueOnce(new SchemaSettingUpError(15, 16));
      expect(await checkSentinel({ body: commentBody })).toMatchObject({ retryOptions: { retryData: { reason: 'schema' } } });
      repoMock.acquireAppLock.mockResolvedValueOnce(false);
      expect(await checkSentinel({ body: commentBody })).toMatchObject({ retryOptions: { retryData: { reason: 'locked' } } });
    });
  });
});
