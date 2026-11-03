import type { DemoKind } from './validate';

/**
 * One background demo job at a time (Load demo data / Reset to showcase / Remove demo data). The resolver validates
 * and queues it; the `demo-seed` consumer does the work and records progress in `settings.demo_job`, which the setup
 * page polls. The `demo` lock stays held for the job's lifetime; `demo-run` guards against a duplicate delivery.
 */

export type DemoJobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed';

export interface DemoJob {
  id: string;
  kind: DemoKind;
  status: DemoJobStatus;
  step: number;
  total: number;
  message: string;
  /** Delivery attempt the job expects next (bumped when it is re-queued after a 429). */
  attempt: number;
  result?: unknown;
  error?: string;
  startedAt: string;
  updatedAt: string;
  /** Admin who clicked (leads the demo projects). Never sent to the UI. */
  accountId: string;
}

export type PublicDemoJob = Omit<DemoJob, 'accountId'>;

export const DEMO_QUEUE = 'demo-seed';
export const DEMO_JOB_KEY = 'demo_job';
export const DEMO_JOB_LOCK = 'demo';
export const DEMO_RUN_LOCK = 'demo-run';
/** A queued or running job not updated for this long is treated as failed (the consumer timeout is 900 s). */
export const DEMO_JOB_STALE_MS = 15 * 60 * 1000;
export const DEMO_JOB_LOCK_SECONDS = DEMO_JOB_STALE_MS / 1000;
export const MAX_DEMO_ATTEMPTS = 3;
export const DEMO_RETRY_SECONDS = 60;
export const STALE_MESSAGE = 'The demo job stopped responding. Click the button again.';
export const STARTING_MESSAGE = 'Another demo job is starting, try again in a few seconds.';

export const DEMO_JOB_LABELS: Record<DemoKind, string> = {
  load: 'Load demo data',
  reset: 'Reset to showcase',
  remove: 'Remove demo data',
};

/** Shown when a job stopped at its time budget; clicking the same button resumes it (every kind is idempotent). */
export const partialMessage = (kind: DemoKind): string => `Ran out of time. Click ${DEMO_JOB_LABELS[kind]} again to continue.`;

/**
 * Per-delivery run lock: longer than the consumer's work budget (12 min) but shorter than its 900 s timeout, so a
 * delivery killed by the timeout no longer blocks the redelivery of the same attempt.
 */
export const DEMO_RUN_LOCK_SECONDS = 13 * 60;

export interface DemoJobRepo {
  getSetting<T>(k: string): Promise<T | undefined>;
  setSetting(k: string, value: unknown): Promise<void>;
  acquireAppLock(name: string, nowIso: string, seconds: number): Promise<boolean>;
  releaseAppLock(name: string): Promise<void>;
}

export interface DemoJobDeps {
  repo: DemoJobRepo;
  /** Queues the job for the `demo-seed` consumer. */
  push: (jobId: string) => Promise<void>;
  now: () => number;
  newId: () => string;
}

const KINDS: readonly DemoKind[] = ['load', 'reset', 'remove'];
const STATUSES: readonly DemoJobStatus[] = ['queued', 'running', 'done', 'partial', 'failed'];

async function readRaw(repo: Pick<DemoJobRepo, 'getSetting'>): Promise<DemoJob | undefined> {
  const raw = await repo.getSetting<unknown>(DEMO_JOB_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !KINDS.includes(v.kind as DemoKind) || !STATUSES.includes(v.status as DemoJobStatus)) return undefined;
  if (typeof v.startedAt !== 'string' || typeof v.updatedAt !== 'string' || typeof v.accountId !== 'string') return undefined;
  return {
    id: v.id,
    kind: v.kind as DemoKind,
    status: v.status as DemoJobStatus,
    step: typeof v.step === 'number' ? v.step : 0,
    total: typeof v.total === 'number' ? v.total : 0,
    message: typeof v.message === 'string' ? v.message : '',
    attempt: typeof v.attempt === 'number' && v.attempt > 0 ? v.attempt : 1,
    ...(v.result !== undefined ? { result: v.result } : {}),
    ...(typeof v.error === 'string' ? { error: v.error } : {}),
    startedAt: v.startedAt,
    updatedAt: v.updatedAt,
    accountId: v.accountId,
  };
}

export const isActive = (job: Pick<DemoJob, 'status'> | undefined): boolean => job?.status === 'queued' || job?.status === 'running';

/** The current job; a queued/running job that stopped updating is reported as failed so it can be started again. */
export async function readDemoJob(deps: { repo: Pick<DemoJobRepo, 'getSetting'>; now: () => number }): Promise<DemoJob | undefined> {
  const job = await readRaw(deps.repo);
  if (job && isActive(job) && deps.now() - Date.parse(job.updatedAt) > DEMO_JOB_STALE_MS) return { ...job, status: 'failed', error: STALE_MESSAGE };
  return job;
}

export function publicJob(job: DemoJob): PublicDemoJob {
  const { accountId: _account, ...rest } = job;
  return rest;
}

/** Starts a demo job, or returns the active one (a double click, or another button while a job runs). */
export async function startDemoJob(kind: DemoKind, accountId: string, deps: DemoJobDeps): Promise<{ job: PublicDemoJob; started: boolean } | { error: string }> {
  const current = await readDemoJob(deps);
  if (current && isActive(current)) return { job: publicJob(current), started: false };
  if (!(await deps.repo.acquireAppLock(DEMO_JOB_LOCK, new Date(deps.now()).toISOString(), DEMO_JOB_LOCK_SECONDS))) {
    const running = await readDemoJob(deps);
    return running && isActive(running) ? { job: publicJob(running), started: false } : { error: STARTING_MESSAGE };
  }
  try {
    const again = await readDemoJob(deps);
    if (again && isActive(again)) return { job: publicJob(again), started: false };
    const at = new Date(deps.now()).toISOString();
    const job: DemoJob = { id: deps.newId(), kind, status: 'queued', step: 0, total: 0, message: 'Queued', attempt: 1, startedAt: at, updatedAt: at, accountId };
    await deps.repo.setSetting(DEMO_JOB_KEY, job);
    try {
      await deps.push(job.id);
    } catch (err) {
      await deps.repo.setSetting(DEMO_JOB_KEY, { ...job, status: 'failed', error: `${DEMO_JOB_LABELS[kind]} could not be queued. Try again.`, updatedAt: new Date(deps.now()).toISOString() });
      throw err;
    }
    return { job: publicJob(job), started: true };
  } catch (err) {
    await deps.repo.releaseAppLock(DEMO_JOB_LOCK);
    throw err;
  }
}

export type DemoProgress = (step: number, total: number, message: string) => Promise<void>;

/** What a job's work returns; `complete: false` means it stopped at the time budget and can be resumed. */
export interface DemoRunResult {
  complete: boolean;
  [k: string]: unknown;
}

export interface RunDemoJobDeps {
  repo: DemoJobRepo;
  now: () => number;
  run: (job: DemoJob, progress: DemoProgress) => Promise<DemoRunResult>;
  /** Message for an error the admin can act on; undefined for unexpected errors (logged, generic message). */
  userMessage: (err: unknown) => string | undefined;
  isRateLimited: (err: unknown) => boolean;
  /** Re-queues the job event after `delaySeconds` with the given attempt. */
  requeue: (jobId: string, attempt: number, delaySeconds: number) => Promise<void>;
}

export type RunOutcome = 'done' | 'partial' | 'failed' | 'requeued' | 'ignored';

/**
 * Consumer side: runs job `jobId` and records progress and the outcome. Accepts a `queued` job, or a `running` job
 * whose expected attempt matches (re-delivery after a 429). Ignores unknown, replaced, finished or duplicate events.
 * Never throws, so the queue does not redeliver a job that failed halfway.
 */
export async function runDemoJob(jobId: string, attempt: number, deps: RunDemoJobDeps): Promise<RunOutcome> {
  const job = await readRaw(deps.repo);
  // A running job is resumed by its expected attempt: the 429 re-queue (attempt + 1) or a redelivery of the same
  // attempt after the previous delivery died (the run lock below rejects a still-live duplicate).
  const resumable = job?.status === 'running' && attempt === job.attempt;
  if (!job || job.id !== jobId || !(job.status === 'queued' || resumable)) {
    console.info('demo job: event ignored', { jobId, attempt, current: job?.id, status: job?.status });
    return 'ignored';
  }
  if (!(await deps.repo.acquireAppLock(DEMO_RUN_LOCK, new Date(deps.now()).toISOString(), DEMO_RUN_LOCK_SECONDS))) {
    console.info('demo job: already running, duplicate event ignored', { jobId, attempt });
    return 'ignored';
  }
  let latest: DemoJob = job;
  let replaced = false;
  let keepJobLock = false;
  const write = async (patch: Partial<DemoJob>): Promise<void> => {
    const stored = await readRaw(deps.repo);
    if (stored && stored.id !== jobId) {
      replaced = true;
      return;
    }
    latest = { ...latest, ...patch, updatedAt: new Date(deps.now()).toISOString() };
    await deps.repo.setSetting(DEMO_JOB_KEY, latest);
  };
  const label = DEMO_JOB_LABELS[job.kind];
  try {
    await write({ status: 'running', message: attempt > 1 ? `Resuming (attempt ${attempt})` : 'Starting' });
    const result = await deps.run(job, (step, total, message) => {
      console.info('demo progress', { kind: job.kind, step, total, message });
      return write({ step, total, message });
    });
    if (result.complete) {
      await write({ status: 'done', step: latest.total, message: 'Done', result });
      return 'done';
    }
    await write({ status: 'partial', message: partialMessage(job.kind), result });
    return 'partial';
  } catch (err) {
    let requeueFailed = false;
    if (deps.isRateLimited(err) && attempt < MAX_DEMO_ATTEMPTS) {
      try {
        await write({ attempt: attempt + 1, message: `Rate limited by Atlassian, retrying in ${DEMO_RETRY_SECONDS} seconds` });
        await deps.requeue(jobId, attempt + 1, DEMO_RETRY_SECONDS);
        console.warn('demo job: rate limited, re-queued', { jobId, kind: job.kind, attempt });
        keepJobLock = true;
        return 'requeued';
      } catch (requeueErr) {
        // Without a queued event the job would sit in "running" until it goes stale; fail it now instead.
        requeueFailed = true;
        console.error('demo job: re-queue failed', { jobId, error: requeueErr instanceof Error ? requeueErr.message : String(requeueErr) });
      }
    }
    const message = requeueFailed
      ? `${label} was rate limited and could not be retried. Click the button again in a minute.`
      : deps.isRateLimited(err)
        ? 'Atlassian kept rate limiting the demo job. Wait a minute and click the button again.'
        : deps.userMessage(err);
    if (message === undefined) console.error(`${label} failed`, { error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : String(err) });
    else console.warn(`${label} stopped`, { message });
    await write({ status: 'failed', error: message ?? `${label} failed. Check the app logs.` }).catch((writeErr: unknown) => {
      console.error('demo job: could not record the failure', { error: writeErr instanceof Error ? writeErr.message : String(writeErr) });
    });
    return 'failed';
  } finally {
    await deps.repo.releaseAppLock(DEMO_RUN_LOCK).catch(() => undefined);
    if (!replaced && !keepJobLock) {
      await deps.repo.releaseAppLock(DEMO_JOB_LOCK).catch((err: unknown) => {
        console.warn('demo job: lock release failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }
}
