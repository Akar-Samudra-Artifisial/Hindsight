/**
 * Triggers, queue consumers and the scheduled trigger. Implemented so far: schema migration (lifecycle trigger +
 * `schema-migrate` consumer) and the Teamwork Graph `onConnectionChange` handler, which stores the connection.
 * The rest still only log; the pipeline (collect → score → reach → propose, Sentinel) comes next.
 */
import { InvocationError, InvocationErrorCode, Queue } from '@forge/events';
import { confluence, isConfluenceRateLimited } from '../adapters/confluence';
import { isJiraRateLimited, jira } from '../adapters/jira';
import { repo, type ConnectionAction } from '../adapters/repo';
import { ensureSchema, requestMigration, runMigrations } from '../adapters/sql';
import { COLLECT_BUDGET_MS, COLLECT_PAGES_PER_RUN, runCollectStep, type CollectDeps } from '../core/collect';
import { analyzeLock } from '../core/jobs';
import { SchemaSettingUpError } from '../core/schema';

type ForgeEvent = Record<string, unknown> | undefined;

const CONNECTION_ACTIONS = new Set(['CREATED', 'UPDATED', 'DELETED']);

export const SCHEMA_RETRY_SECONDS = 60;
/** The `schema-migrate` consumer has a 900 s timeout; stop waiting for the DDL rate limit well before that. */
export const MIGRATE_BUDGET_MS = 12 * 60 * 1000;

export interface ConnectionChange {
  action: ConnectionAction;
  connectionId: string;
  name?: string;
  connectorName?: string;
  flowName?: string;
}

function optionalText(raw: unknown, max: number): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw.slice(0, max) : undefined;
}

/**
 * `onConnectionChange` request (passed directly, not under `payload`) → action, connectionId and the connector
 * names, or undefined. Also parses the copy queued on `schema-migrate`, which has the same shape.
 */
export function parseConnectionChange(event: ForgeEvent): ConnectionChange | undefined {
  const action = typeof event?.['action'] === 'string' ? event['action'].toUpperCase() : '';
  const connectionId = event?.['connectionId'];
  if (!CONNECTION_ACTIONS.has(action) || typeof connectionId !== 'string' || connectionId === '' || connectionId.length > 255) return undefined;
  const change: ConnectionChange = { action: action as ConnectionAction, connectionId };
  const name = optionalText(event?.['name'], 255);
  const config = event?.['configProperties'];
  const props = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const connectorName = optionalText(props['connectorName'], 128);
  const flowName = optionalText(props['flowName'], 255);
  if (name) change.name = name;
  if (connectorName) change.connectorName = connectorName;
  if (flowName) change.flowName = flowName;
  return change;
}

/** Queue body form of a change, readable again by `parseConnectionChange`. */
function queuedConnection(change: ConnectionChange): Record<string, unknown> {
  return {
    action: change.action,
    connectionId: change.connectionId,
    name: change.name,
    configProperties: { connectorName: change.connectorName, flowName: change.flowName },
  };
}

async function saveConnection(change: ConnectionChange, via: 'handler' | 'queue'): Promise<void> {
  await repo.saveGraphConnection({
    connectionId: change.connectionId,
    name: change.name,
    connectorName: change.connectorName,
    flowName: change.flowName,
    lastAction: change.action,
    status: change.action === 'DELETED' ? 'deleted' : 'active',
  });
  console.info('graph connection saved', { action: change.action, via });
}

/**
 * Teamwork Graph connector activation/update/removal: stores the connectionId in `graph_connection` (writes to the
 * graph happen later from the pipeline). When the schema is not ready yet, or saving fails, the change is queued on
 * `schema-migrate`, whose consumer saves it once migrations are done. Only an unrecognised payload reports failure.
 */
export const onConnectionChange = async (event: ForgeEvent): Promise<{ success: boolean; message?: string }> => {
  const change = parseConnectionChange(event);
  if (!change) {
    console.warn('onConnectionChange: unrecognised payload', { keys: Object.keys(event ?? {}) });
    return { success: false, message: 'Unrecognised connection change.' };
  }
  try {
    await ensureSchema();
    await saveConnection(change, 'handler');
  } catch (err) {
    const reason = err instanceof SchemaSettingUpError ? 'schema not ready' : err instanceof Error ? err.message : String(err);
    try {
      const jobId = await requestMigration('connection', { connection: queuedConnection(change) });
      console.info('graph connection queued', { action: change.action, reason, jobId });
    } catch (queueErr) {
      console.error('graph connection not saved', {
        action: change.action,
        reason,
        queueError: queueErr instanceof Error ? queueErr.message : String(queueErr),
      });
    }
  }
  return { success: true };
};

/** Asks the queue to redeliver the event after `seconds`. */
export function retryLater(seconds: number, reason = 'rate_limited'): InvocationError {
  // retryData must be set: the Forge runtime measures its serialised size and fails with ERR_INVALID_ARG_TYPE when it is undefined.
  return new InvocationError({
    retryAfter: seconds,
    retryReason: InvocationErrorCode.FUNCTION_UPSTREAM_RATE_LIMITED,
    retryData: { reason },
  });
}

/** Lifecycle trigger (app installed / major upgrade): start the schema migration right away. */
export async function onAppLifecycle(event: ForgeEvent): Promise<void> {
  const eventType = typeof event?.['eventType'] === 'string' ? event['eventType'] : 'lifecycle';
  const jobId = await requestMigration(eventType);
  console.info('hindsight migrations: queued', { eventType, jobId });
}

interface QueueEvent {
  body?: Record<string, unknown>;
}

/**
 * Consumer for the `schema-migrate` queue: the only place that runs DDL. Waits out the Forge SQL DDL rate limit and
 * asks for a redelivery (same body) if it runs out of time. A queued connector change is saved once the schema is done.
 */
export async function migrateSchema(event: QueueEvent | undefined): Promise<InvocationError | void> {
  const result = await runMigrations(MIGRATE_BUDGET_MS);
  console.info('hindsight migrations', result);
  if (result.status === 'pending') return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
  const raw = event?.body?.['connection'];
  if (raw === undefined) return;
  const change = parseConnectionChange(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined);
  if (!change) {
    console.warn('hindsight migrations: queued connection change is invalid, ignored');
    return;
  }
  await saveConnection(change, 'queue');
}

const stub = (name: string) => async (event: ForgeEvent): Promise<void> => {
  console.info(`${name}: not implemented yet`, { keys: Object.keys(event ?? {}) });
};

export const COLLECT_QUEUE = 'collect';
export const SCORE_QUEUE = 'score';
export const MAX_COLLECT_ATTEMPTS = 3;
export const RATE_LIMIT_DELAY_SECONDS = 60;
export const JOB_LOCK_SECONDS = 15 * 60;
const collectQueue = new Queue({ key: COLLECT_QUEUE });
const scoreQueue = new Queue({ key: SCORE_QUEUE });

const collectDeps: CollectDeps = {
  repo,
  jira: { searchPage: (jql, token) => jira.searchPage(jql, token), listComments: (id, startAt, max) => jira.listComments(id, startAt, max) },
  confluence: { searchContent: (cql, cursor) => confluence.searchContent(cql, cursor) },
  isRateLimited: (err) => isJiraRateLimited(err) || isConfluenceRateLimited(err),
  now: Date.now,
};

/** True when the schema is ready; while it is setting up the caller asks for a redelivery. */
async function schemaReady(where: string): Promise<boolean> {
  try {
    await ensureSchema();
    return true;
  } catch (err) {
    if (err instanceof SchemaSettingUpError) {
      console.info(`${where}: schema setting up, retrying later`, { applied: err.applied, total: err.total });
      return false;
    }
    throw err;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJobBody(body: Record<string, unknown> | undefined): { jobId: string; attempt: number } {
  const jobId = body?.['jobId'];
  if (typeof jobId !== 'string' || !UUID.test(jobId)) throw new Error('collect event body.jobId must be a job id');
  const raw = body?.['attempt'];
  const attempt = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 1;
  return { jobId, attempt };
}

async function failJob(jobId: string, incidentKey: string | undefined, error: string): Promise<void> {
  await repo.updateJob(jobId, { status: 'failed', lastError: error.slice(0, 1024), finishedAt: new Date().toISOString() });
  if (incidentKey) await repo.releaseAppLock(analyzeLock(incidentKey));
}

/**
 * Consumer for the `collect` queue: runs one resumable collect step under the `job:<id>` lock. More work → re-queue;
 * 429 → re-queue after 60 s with `attempt + 1` (fails the job after 3); done → queue `score`.
 */
export async function collectEvents(event: QueueEvent | undefined): Promise<InvocationError | void> {
  const { jobId, attempt } = parseJobBody(event?.body);
  if (!(await schemaReady('collectEvents'))) return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
  const lock = `job:${jobId}`;
  if (!(await repo.acquireAppLock(lock, new Date().toISOString(), JOB_LOCK_SECONDS))) return retryLater(SCHEMA_RETRY_SECONDS, 'locked');
  let incidentKey: string | undefined;
  try {
    incidentKey = (await repo.getJob(jobId))?.incidentKey;
    const result = await runCollectStep(jobId, collectDeps, { maxPages: COLLECT_PAGES_PER_RUN, deadline: Date.now() + COLLECT_BUDGET_MS });
    switch (result.status) {
      case 'more':
        await collectQueue.push({ body: { jobId, attempt: 1 } });
        console.info('collect', { jobId, phase: result.phase, ...result.counts });
        return;
      case 'rate_limited':
        if (attempt >= MAX_COLLECT_ATTEMPTS) {
          await failJob(jobId, incidentKey, 'rate limited');
          console.warn('collect: rate limited, job failed', { jobId, attempt });
          return;
        }
        await collectQueue.push({ body: { jobId, attempt: attempt + 1 }, delayInSeconds: RATE_LIMIT_DELAY_SECONDS });
        console.warn('collect: rate limited, re-queued', { jobId, phase: result.phase, attempt });
        return;
      case 'finalized':
        // Collect is done; scoring runs per job, so a new analysis of the incident may start.
        if (incidentKey) await repo.releaseAppLock(analyzeLock(incidentKey));
        await scoreQueue.push({ body: { jobId } });
        console.info('collect finalized', { jobId, ...result.counts });
        return;
      case 'failed':
        if (incidentKey) await repo.releaseAppLock(analyzeLock(incidentKey));
        console.error('collect failed', { jobId, error: result.error });
        return;
      case 'skipped':
        console.info('collect skipped', { jobId, reason: result.reason });
        return;
    }
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await failJob(jobId, incidentKey, error);
    console.error('collect failed', { jobId, error: error.slice(0, 300) });
  } finally {
    await repo.releaseAppLock(lock);
  }
}

/** Consumer for the `score` queue. Week 3 scores the kept candidates with Forge LLM; for now it only logs. */
export async function scoreCandidates(event: QueueEvent | undefined): Promise<void> {
  const jobId = typeof event?.body?.['jobId'] === 'string' ? event.body['jobId'] : null;
  const job = jobId ? await repo.getJob(jobId) : undefined;
  console.info('score stub', { jobId, candidateCount: job?.candidateCount ?? null });
}

export const onWorkEvent = stub('onWorkEvent');
export const traceReach = stub('traceReach');
export const proposeRoutesJob = stub('proposeRoutesJob');
export const checkSentinel = stub('checkSentinel');
export const demoJob = stub('demoJob');
export const purgeExpired = stub('purgeExpired');
