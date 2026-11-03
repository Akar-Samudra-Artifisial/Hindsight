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
}));
const llm = vi.hoisted(() => ({ pickModels: vi.fn(), chatTool: vi.fn() }));
vi.mock('@forge/llm', () => ({ chat: vi.fn(), list: vi.fn() }));
vi.mock('../src/llm', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/llm')>()), ...llm }));
const tw = vi.hoisted(() => ({ writeDossier: vi.fn() }));
const jiraMock = vi.hoisted(() => ({ getIssueSelf: vi.fn() }));
vi.mock('../src/adapters/teamworkGraph', () => tw);
vi.mock('../src/adapters/jira', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/jira')>();
  return { ...actual, jira: { ...actual.jira, ...jiraMock } };
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

const { collectEvents, demoJob, migrateSchema, onAppLifecycle, onConnectionChange, retryLater, SCHEMA_RETRY_SECONDS, scoreCandidates } = await import(
  '../src/surfaces/background'
);

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
