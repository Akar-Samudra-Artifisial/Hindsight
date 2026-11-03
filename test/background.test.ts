import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaSettingUpError } from '../src/core/schema';

const sql = vi.hoisted(() => ({ ensureSchema: vi.fn(), requestMigration: vi.fn(), runMigrations: vi.fn() }));
const repoMock = vi.hoisted(() => ({
  saveGraphConnection: vi.fn(),
  acquireAppLock: vi.fn(),
  releaseAppLock: vi.fn(),
  getJob: vi.fn(),
  updateJob: vi.fn(),
}));
const queue = vi.hoisted(() => ({ push: vi.fn() }));
const collect = vi.hoisted(() => ({ runCollectStep: vi.fn() }));
vi.mock('../src/adapters/sql', () => sql);
vi.mock('../src/adapters/repo', () => ({ repo: repoMock }));
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

const { collectEvents, migrateSchema, onAppLifecycle, onConnectionChange, retryLater, SCHEMA_RETRY_SECONDS } = await import('../src/surfaces/background');

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
