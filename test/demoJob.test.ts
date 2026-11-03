import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEMO_JOB_KEY,
  DEMO_JOB_LOCK,
  DEMO_JOB_STALE_MS,
  DEMO_RUN_LOCK,
  partialMessage,
  readDemoJob,
  runDemoJob,
  startDemoJob,
  STALE_MESSAGE,
  type DemoJob,
  type RunDemoJobDeps,
} from '../src/core/demoJob';

const JOB = '0b6c2f6e-4b7a-4c51-9a55-8f1d3c2a1e00';

function memoryRepo() {
  const settings = new Map<string, unknown>();
  const locks = new Set<string>();
  return {
    settings,
    locks,
    getSetting: async <T,>(k: string): Promise<T | undefined> => settings.get(k) as T | undefined,
    setSetting: vi.fn(async (k: string, v: unknown) => {
      settings.set(k, structuredClone(v));
    }),
    acquireAppLock: vi.fn(async (name: string) => {
      if (locks.has(name)) return false;
      locks.add(name);
      return true;
    }),
    releaseAppLock: vi.fn(async (name: string) => {
      locks.delete(name);
    }),
  };
}

let now = Date.parse('2026-11-03T10:00:00.000Z');
let repo: ReturnType<typeof memoryRepo>;
const push = vi.fn();

beforeEach(() => {
  now = Date.parse('2026-11-03T10:00:00.000Z');
  repo = memoryRepo();
  push.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const startDeps = () => ({ repo, push, now: () => now, newId: () => JOB });

function runDeps(over: Partial<RunDemoJobDeps> = {}): RunDemoJobDeps {
  return {
    repo,
    now: () => now,
    run: vi.fn(async () => ({ complete: true })),
    userMessage: () => undefined,
    isRateLimited: (err) => (err as { status?: number }).status === 429,
    requeue: vi.fn(async () => undefined),
    ...over,
  };
}

const stored = () => repo.settings.get(DEMO_JOB_KEY) as DemoJob;

describe('startDemoJob', () => {
  it('queues a job, holds the demo lock and never exposes the account id', async () => {
    const r = await startDemoJob('load', 'acc-1', startDeps());
    expect(r).toMatchObject({ started: true, job: { id: JOB, kind: 'load', status: 'queued', attempt: 1 } });
    expect(JSON.stringify(r)).not.toContain('acc-1');
    expect(push).toHaveBeenCalledWith(JOB);
    expect(repo.locks.has(DEMO_JOB_LOCK)).toBe(true);
  });

  it('a double click returns the active job instead of starting another', async () => {
    await startDemoJob('load', 'acc-1', startDeps());
    const second = await startDemoJob('remove', 'acc-1', { ...startDeps(), newId: () => 'other' });
    expect(second).toMatchObject({ started: false, job: { id: JOB, kind: 'load' } });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('a stale job reads as failed and a new one can start', async () => {
    await startDemoJob('load', 'acc-1', startDeps());
    now += DEMO_JOB_STALE_MS + 1000;
    expect(await readDemoJob({ repo, now: () => now })).toMatchObject({ status: 'failed', error: STALE_MESSAGE });
    repo.locks.delete(DEMO_JOB_LOCK); // the lock expires together with the stale limit
    const r = await startDemoJob('reset', 'acc-1', { ...startDeps(), newId: () => 'job-2' });
    expect(r).toMatchObject({ started: true, job: { id: 'job-2', kind: 'reset' } });
  });

  it('marks the job failed and releases the lock when queueing fails', async () => {
    push.mockRejectedValue(new Error('queue down'));
    await expect(startDemoJob('load', 'acc-1', startDeps())).rejects.toThrow('queue down');
    expect(stored()).toMatchObject({ status: 'failed' });
    expect(repo.locks.has(DEMO_JOB_LOCK)).toBe(false);
  });
});

describe('runDemoJob', () => {
  beforeEach(async () => {
    await startDemoJob('load', 'acc-1', startDeps());
  });

  it('runs a queued job to done, records progress and releases both locks', async () => {
    const deps = runDeps({
      run: async (_job, progress) => {
        await progress(3, 10, 'Preparing Confluence space PLAT');
        expect(stored()).toMatchObject({ status: 'running', step: 3, total: 10 });
        return { complete: true, created: 5 };
      },
    });
    expect(await runDemoJob(JOB, 1, deps)).toBe('done');
    expect(stored()).toMatchObject({ status: 'done', message: 'Done', result: { complete: true, created: 5 } });
    expect(repo.locks.size).toBe(0);
  });

  it('ends as partial when the work stops at the deadline', async () => {
    expect(await runDemoJob(JOB, 1, runDeps({ run: async () => ({ complete: false }) }))).toBe('partial');
    expect(stored()).toMatchObject({ status: 'partial', message: 'Ran out of time. Click Load demo data again to continue.' });
  });

  it('the partial message names the button of the job kind', () => {
    expect(partialMessage('remove')).toBe('Ran out of time. Click Remove demo data again to continue.');
    expect(partialMessage('reset')).toBe('Ran out of time. Click Reset to showcase again to continue.');
  });

  it('a redelivery of the same attempt resumes a running job whose delivery died (run lock expired)', async () => {
    repo.settings.set(DEMO_JOB_KEY, { ...stored(), status: 'running' });
    expect(await runDemoJob(JOB, 1, runDeps())).toBe('done');
  });

  it('a live duplicate of the same attempt is still rejected by the run lock', async () => {
    repo.settings.set(DEMO_JOB_KEY, { ...stored(), status: 'running' });
    repo.locks.add(DEMO_RUN_LOCK);
    expect(await runDemoJob(JOB, 1, runDeps())).toBe('ignored');
  });

  it('fails the job (and frees the lock) when the 429 re-queue itself fails', async () => {
    const limited = Object.assign(new Error('Jira 429'), { status: 429 });
    const deps = runDeps({ run: async () => Promise.reject(limited), requeue: vi.fn(async () => Promise.reject(new Error('queue down'))) });
    expect(await runDemoJob(JOB, 1, deps)).toBe('failed');
    expect(stored()).toMatchObject({ status: 'failed', error: expect.stringMatching(/could not be retried/) });
    expect(repo.locks.size).toBe(0);
  });

  it('a SeedError-like failure shows the user message and releases the lock', async () => {
    const deps = runDeps({ run: async () => Promise.reject(new Error('Create INC')), userMessage: (e) => (e as Error).message });
    expect(await runDemoJob(JOB, 1, deps)).toBe('failed');
    expect(stored()).toMatchObject({ status: 'failed', error: 'Create INC' });
    expect(repo.locks.has(DEMO_JOB_LOCK)).toBe(false);
  });

  it('on 429 re-queues with attempt + 1, keeps the job running and the demo lock held, then accepts the redelivery', async () => {
    const limited = Object.assign(new Error('Jira 429'), { status: 429 });
    const deps = runDeps({ run: vi.fn().mockRejectedValueOnce(limited).mockResolvedValueOnce({ complete: true }) });
    expect(await runDemoJob(JOB, 1, deps)).toBe('requeued');
    expect(deps.requeue).toHaveBeenCalledWith(JOB, 2, 60);
    expect(stored()).toMatchObject({ status: 'running', attempt: 2 });
    expect(repo.locks.has(DEMO_JOB_LOCK)).toBe(true);
    expect(repo.locks.has(DEMO_RUN_LOCK)).toBe(false);
    // A stale duplicate of attempt 1 is ignored; attempt 2 resumes.
    expect(await runDemoJob(JOB, 1, deps)).toBe('ignored');
    expect(await runDemoJob(JOB, 2, deps)).toBe('done');
    expect(repo.locks.size).toBe(0);
  });

  it('gives up after 3 rate-limited attempts', async () => {
    const limited = Object.assign(new Error('Jira 429'), { status: 429 });
    repo.settings.set(DEMO_JOB_KEY, { ...stored(), status: 'running', attempt: 3 });
    expect(await runDemoJob(JOB, 3, runDeps({ run: async () => Promise.reject(limited) }))).toBe('failed');
    expect(stored().error).toMatch(/rate limiting/);
  });

  it('ignores unknown jobs, finished jobs and a concurrent duplicate', async () => {
    expect(await runDemoJob('other', 1, runDeps())).toBe('ignored');
    repo.locks.add(DEMO_RUN_LOCK);
    expect(await runDemoJob(JOB, 1, runDeps())).toBe('ignored');
    repo.locks.delete(DEMO_RUN_LOCK);
    await runDemoJob(JOB, 1, runDeps());
    expect(await runDemoJob(JOB, 1, runDeps())).toBe('ignored');
  });
});
