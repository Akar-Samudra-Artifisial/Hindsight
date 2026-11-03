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
}));
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

describe('scoreCandidates (dossier, gate G3)', () => {
  beforeEach(() => {
    repoMock.getJob.mockResolvedValue({ id: JOB, incidentKey: 'INC-7', windowDays: 30, candidateCount: 3, status: 'scoring' });
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
