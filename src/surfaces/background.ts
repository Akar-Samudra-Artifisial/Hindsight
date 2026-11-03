/**
 * Triggers, queue consumers and the scheduled trigger. Implemented so far: schema migration, the Teamwork Graph
 * `onConnectionChange` handler (stores the connection), collect, LLM scoring with the dossier write, the demo job and
 * Sentinel (work-event triggers + `sentinel` consumer). The remaining stubs only log.
 */
import { InvocationError, InvocationErrorCode, Queue } from '@forge/events';
import { confluence, ConfluenceError, isConfluenceRateLimited } from '../adapters/confluence';
import { isJiraRateLimited, jira, JiraError } from '../adapters/jira';
import { COLLECTED_JOB_STATUSES, repo, type ConnectionAction, type JobStatus, type ServiceMapping, type Signal } from '../adapters/repo';
import { ensureSchema, requestMigration, runMigrations } from '../adapters/sql';
import { deleteObjects, writeDossier } from '../adapters/teamworkGraph';
import { COLLECT_BUDGET_MS, COLLECT_PAGES_PER_RUN, runCollectStep, type CollectDeps } from '../core/collect';
import { DEMO_QUEUE, runDemoJob, type DemoJob, type DemoProgress, type DemoRunResult } from '../core/demoJob';
import {
  buildDossier,
  DOSSIER_ALL_INCIDENTS_KEY,
  DOSSIER_IDS_KEY,
  DOSSIER_OBJECT_TYPE,
  DOSSIER_STATUS_KEY,
  parseDossierIds,
  withDossierId,
  type DossierReach,
  type DossierStatus,
} from '../core/dossier';
import { computeMetrics, teamUuid } from '../core/reach';
import { APP_ACCOUNTS_KEY, mergeAppAccounts, parseAppAccounts, responderOf } from '../core/reachFlow';
import {
  alertGate,
  buildAlertComment,
  isSelfArtifact,
  matchRoutes,
  MAX_SENTINEL_ATTEMPTS,
  parseDailyCap,
  parseSentinelBody,
  parseWeeklyCap,
  parseWorkEvent,
  prefilter,
  sentinelBody,
  sentinelLock,
  SENTINEL_DAILY_CAP_KEY,
  SENTINEL_QUEUE,
  SENTINEL_WEEKLY_CAP_KEY,
  type ArtifactPlace,
  type SentinelBody,
} from '../core/sentinel';
import { adfToText, storageToText } from '../core/text';
import { sourceTypeLabel } from '../core/routes';
import { INCIDENT_SLOT } from '../core/demoData';
import { analyzeLock } from '../core/jobs';
import { SchemaSettingUpError } from '../core/schema';
import { runScoring, type ScoreDeps, type ScoreRunResult } from '../core/score';
import { chatTool, isLlmRateLimited, LlmUnavailableError, pickModels } from '../llm';
import { SCORE_TOOL } from '../llm/prompts';
import { loadDemoData, removeDemoData, resetShowcase, SeedError, type SeedDeps } from '../core/seed';

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
  jira: { searchPage: (jql, token) => jira.searchPage(jql, token), listComments: (id, startAt, max) => jira.listComments(id, startAt, max), siteUrl: () => jira.siteUrl() },
  confluence: { searchContent: (cql, cursor) => confluence.searchContent(cql, cursor) },
  isRateLimited: (err) => isJiraRateLimited(err) || isConfluenceRateLimited(err),
  now: Date.now,
  noteAppAccounts: async (ids) => {
    const known = parseAppAccounts(await repo.getSetting<unknown>(APP_ACCOUNTS_KEY));
    const merged = mergeAppAccounts(known, ids);
    if (merged.length !== known.length) await repo.setSetting(APP_ACCOUNTS_KEY, merged);
  },
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

/**
 * The dossier is visible to everyone on the site, so it is only written for the demo incident, unless the admin
 * opted in with `settings.dossier_all_incidents = true`.
 */
/** True for the incident created by Load demo data (same test as the dossier gate). */
async function isDemoIncident(incidentKey: string): Promise<boolean> {
  const artifacts = await repo.listDemoArtifacts();
  return artifacts.some((a) => a.slot === INCIDENT_SLOT && a.artifactKey === incidentKey);
}

async function dossierAllowed(incidentKey: string): Promise<{ allowed: boolean; demo: boolean }> {
  const demo = await isDemoIncident(incidentKey);
  if (demo) return { allowed: true, demo };
  return { allowed: (await repo.getSetting<unknown>(DOSSIER_ALL_INCIDENTS_KEY)) === true, demo };
}

/** Remembers a demo dossier id before it is written, so Remove demo data can delete it later. */
async function trackDossier(id: string): Promise<void> {
  const ids = parseDossierIds(await repo.getSetting<unknown>(DOSSIER_IDS_KEY));
  if (!ids.includes(id)) await repo.setSetting(DOSSIER_IDS_KEY, withDossierId(ids, id));
}

/** Reach metrics and the top route for the dossier; undefined until confirmed signals were traced. */
async function dossierReach(incidentKey: string, signals: readonly Signal[]): Promise<DossierReach | undefined> {
  const [paths, routes] = await Promise.all([repo.listReachPaths(incidentKey), repo.listRoutes(incidentKey)]);
  const metrics = computeMetrics(signals, paths);
  if (!metrics || metrics.considered === 0) return undefined;
  const top = routes.find((r) => r.status === 'active') ?? routes[0];
  return {
    firstSignalDays: metrics.firstSignalDays,
    awarenessGapDays: metrics.awarenessGapDays,
    reached: metrics.reached,
    considered: metrics.considered,
    topRoute: top ? { source: sourceTypeLabel(top.sourceType), estimatedDaysSaved: top.estimatedDaysSaved, maxDaysBefore: top.maxDaysBefore } : null,
  };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Writes the incident's dossier to Teamwork Graph through the stored connector connection (gate G3: a write from a
 * consumer, outside `onConnectionChange`). Not the demo incident (and no opt-in) or no active connection → skipped. Never throws: the dossier is a bonus and
 * must not fail the scoring job. The outcome is kept in `settings.dossier_last` for the setup page.
 */
export async function writeIncidentDossier(job: { id: string; incidentKey: string; windowDays: number; status?: JobStatus; candidateCount?: number }): Promise<DossierStatus> {
  const { incidentKey } = job;
  const at = new Date().toISOString();
  let status: DossierStatus;
  try {
    const { allowed, demo } = await dossierAllowed(incidentKey);
    if (!allowed) {
      // Not recorded in dossier_last: the setup page reports the demo dossier, not every analysed incident.
      console.info('dossier skipped', { incidentKey, reason: 'not demo incident' });
      return { incidentKey, at, skipped: 'not demo incident' };
    }
    const connection = await repo.getActiveGraphConnection();
    if (!connection) {
      console.info('dossier skipped', { incidentKey, reason: 'no connection' });
      status = { incidentKey, at, skipped: 'no connection' };
    } else {
      const issue = await jira.getIssueSelf(incidentKey);
      if (!issue?.siteUrl) throw new Error(`incident ${incidentKey} not readable by the app`);
      // After scoring: counts of signals that are not rejected. Before: kept candidates (test dossier).
      const scored = job.status === 'done';
      const allSignals = scored ? await repo.listSignalsForIncident(incidentKey) : [];
      const items = scored ? allSignals.filter((s) => s.status !== 'rejected') : await repo.listKeptCandidates(job.id, 200);
      const reach = scored ? await dossierReach(incidentKey, allSignals) : undefined;
      const doc = buildDossier({
        incidentKey,
        siteUrl: issue.siteUrl,
        windowDays: job.windowDays,
        candidateCount: scored ? (job.candidateCount ?? items.length) : items.length,
        earliestDaysBefore: items.length > 0 ? Math.max(...items.map((c) => c.daysBefore)) : null,
        ...(scored ? { signalCount: items.length } : {}),
        ...(reach ? { reach } : {}),
        now: new Date(),
      });
      if (demo) await trackDossier(doc.id);
      const result = await writeDossier(connection.connectionId, doc);
      if (result.error || !result.success) {
        console.warn('dossier failed', { incidentKey, accepted: result.accepted, rejected: result.rejected, error: result.error ?? 'not successful' });
        status = { incidentKey, at, accepted: result.accepted, rejected: result.rejected, error: result.error ?? 'Teamwork Graph did not accept the write.' };
      } else {
        console.info('dossier written', { incidentKey, accepted: result.accepted, rejected: result.rejected, connectionId: '<redacted>' });
        status = { incidentKey, at, accepted: result.accepted, rejected: result.rejected };
      }
    }
  } catch (err) {
    console.warn('dossier failed', { incidentKey, error: errorMessage(err) });
    status = { incidentKey, at, error: errorMessage(err) };
  }
  await repo.setSetting(DOSSIER_STATUS_KEY, status).catch((err: unknown) => console.warn('dossier status not saved', { error: errorMessage(err) }));
  return status;
}

export const MAX_SCORE_ATTEMPTS = 3;
/** The score consumer stops starting new batches after this long (its timeout is 900 s). */
export const SCORE_BUDGET_MS = 10 * 60 * 1000;

const scoreDeps: ScoreDeps = {
  repo,
  pickModels: () => pickModels(),
  callModel: (model, messages) => chatTool(model, messages, SCORE_TOOL),
  isRateLimited: isLlmRateLimited,
  now: Date.now,
  // Demo incident only: replay earlier verdicts so "Analyze again" gives the same signals while recording.
  scoreCacheFor: async (incidentKey) =>
    (await isDemoIncident(incidentKey))
      ? { get: (promptVersion, eventIds) => repo.getScoreCache(incidentKey, promptVersion, eventIds), put: (rows) => repo.putScoreCache(rows) }
      : null,
};

/**
 * Consumer for the `score` queue (`{jobId, attempt}`): under the `job:<id>` lock it scores the kept candidates of a
 * `scoring` job with Forge LLM in batches of 10. Time left over → re-queue; 429 → re-queue after 60 s with
 * `attempt + 1` (fails the job after 3); finished → job `done` and the dossier is refreshed. A job that is already
 * done (setup "Write test dossier") only gets its dossier written.
 */
export async function scoreCandidates(event: QueueEvent | undefined): Promise<InvocationError | void> {
  const rawId = event?.body?.['jobId'];
  if (typeof rawId !== 'string' || !UUID.test(rawId)) {
    console.warn('score: event without a valid job id, ignored');
    return;
  }
  const { jobId, attempt } = parseJobBody(event?.body);
  if (!(await schemaReady('scoreCandidates'))) return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
  const lock = `job:${jobId}`;
  if (!(await repo.acquireAppLock(lock, new Date().toISOString(), JOB_LOCK_SECONDS))) return retryLater(SCHEMA_RETRY_SECONDS, 'locked');
  try {
    const job = await repo.getJob(jobId);
    if (!job) {
      console.info('score skipped', { jobId, reason: 'job not found' });
      return;
    }
    if (job.status !== 'scoring') {
      if (COLLECTED_JOB_STATUSES.includes(job.status)) await writeIncidentDossier(job);
      else console.info('dossier skipped', { incidentKey: job.incidentKey, reason: `job is ${job.status}` });
      return;
    }
    let result: ScoreRunResult;
    try {
      result = await runScoring(jobId, scoreDeps, { deadline: Date.now() + SCORE_BUDGET_MS });
    } catch (err) {
      const error = err instanceof LlmUnavailableError ? err.message : `Scoring failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
      await failJob(jobId, undefined, error);
      console.error('score failed', { jobId, error: error.slice(0, 300) });
      return;
    }
    switch (result.status) {
      case 'skipped':
        console.info('score skipped', { jobId, reason: result.reason });
        return;
      case 'more':
        await scoreQueue.push({ body: { jobId, attempt: 1 } });
        console.info('score more', { jobId, ...result.progress });
        return;
      case 'rate_limited':
        if (attempt >= MAX_SCORE_ATTEMPTS) {
          await failJob(jobId, undefined, 'LLM rate limited: Forge LLM refused the scoring requests 3 times. Try Analyze again later.');
          console.warn('score: rate limited, job failed', { jobId, attempt });
          return;
        }
        await scoreQueue.push({ body: { jobId, attempt: attempt + 1 }, delayInSeconds: RATE_LIMIT_DELAY_SECONDS });
        console.warn('score: rate limited, re-queued', { jobId, attempt });
        return;
      case 'done': {
        // Before `done`: a redelivery after a crash here still finds the job in `scoring` and repeats the cleanup.
        const stale = await repo.deleteStaleProposedSignals(job.incidentKey, job);
        await repo.updateJob(jobId, { status: 'done', finishedAt: new Date().toISOString() });
        console.info('score done', { jobId, signals: result.progress.signals, failed: result.progress.failed, total: result.progress.total, stale });
        await writeIncidentDossier({ ...job, status: 'done' });
        return;
      }
    }
  } finally {
    await repo.releaseAppLock(lock);
  }
}

/** The demo consumer stops starting new steps after this long (its timeout is 900 s). */
export const DEMO_BUDGET_MS = 12 * 60 * 1000;
/** How long the demo consumer waits for Jira/Confluence search to see the demo data. */
export const DEMO_INDEX_WAIT_MS = 3 * 60 * 1000;
const demoQueue = new Queue({ key: DEMO_QUEUE });

/** Queues a demo job event for the `demo-seed` consumer. */
export async function enqueueDemoJob(jobId: string, attempt = 1, delayInSeconds?: number): Promise<void> {
  await demoQueue.push({ body: { jobId, attempt }, ...(delayInSeconds ? { delayInSeconds } : {}) });
}

function seedDeps(progress: DemoProgress): SeedDeps {
  return {
    jira,
    confluence,
    repo,
    graph: { deleteDossiers: (connectionId, ids) => deleteObjects(connectionId, DOSSIER_OBJECT_TYPE, ids) },
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    deadline: Date.now() + DEMO_BUDGET_MS,
    indexWaitMs: DEMO_INDEX_WAIT_MS,
    progress,
  };
}

/** Runs one demo job's work and logs its outcome. */
export async function runDemoWork(job: DemoJob, progress: DemoProgress): Promise<DemoRunResult> {
  const deps = seedDeps(progress);
  switch (job.kind) {
    case 'load': {
      const result = await loadDemoData(job.accountId, deps);
      console.info('demo load', {
        created: result.created,
        existing: result.existing,
        events: result.events,
        indexed: result.indexed,
        complete: result.complete,
        incidentKey: result.incidentKey,
        warnings: result.warnings,
        closures: result.closures.map((c) => `${c.slot} ${c.key ?? '-'}: ${c.outcome}${c.status ? ` (${c.status}${c.resolution ? `, ${c.resolution}` : ''})` : ''}`),
      });
      return result;
    }
    case 'reset': {
      const result = await resetShowcase(deps);
      console.info('demo reset', result);
      return result;
    }
    case 'remove': {
      const result = await removeDemoData(deps);
      console.info('demo remove', result);
      return result;
    }
  }
}

/** Consumer for the `demo-seed` queue: runs one Load / Reset / Remove job, re-queuing itself after a 429. */
export async function demoJob(event: QueueEvent | undefined): Promise<InvocationError | void> {
  const jobId = event?.body?.['jobId'];
  if (typeof jobId !== 'string' || !UUID.test(jobId)) throw new Error('demo event body.jobId must be a job id');
  const raw = event?.body?.['attempt'];
  const attempt = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 1;
  if (!(await schemaReady('demoJob'))) return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
  await runDemoJob(jobId, attempt, {
    repo,
    now: Date.now,
    run: runDemoWork,
    userMessage: (err) => (err instanceof SeedError ? err.message : undefined),
    isRateLimited: (err) => isJiraRateLimited(err) || isConfluenceRateLimited(err),
    requeue: (id, next, delay) => enqueueDemoJob(id, next, delay),
  });
}

// --- Sentinel ------------------------------------------------------------------------------------

export const SENTINEL_LOCK_SECONDS = 5 * 60;
const sentinelQueue = new Queue({ key: SENTINEL_QUEUE });

/** Queues one artifact for the `sentinel` consumer (also used by the demo "provider notice" resolver). */
export async function enqueueSentinel(body: SentinelBody, delayInSeconds?: number): Promise<void> {
  await sentinelQueue.push({ body: { ...body }, ...(delayInSeconds ? { delayInSeconds } : {}) });
}

const skipped = (reason: string, extra: Record<string, unknown> = {}): void => console.info('sentinel skipped', { reason, ...extra });

async function knownAppAccounts(): Promise<string[]> {
  return parseAppAccounts(await repo.getSetting<unknown>(APP_ACCOUNTS_KEY));
}

/**
 * Jira/Confluence product events (`work-event-jira`, `work-event-confluence`): a thin filter that only queues. Skips
 * self-generated events, events by a known app account, and events no active route could cover. Never throws.
 */
export async function onWorkEvent(event: ForgeEvent): Promise<void> {
  const eventType = typeof event?.['eventType'] === 'string' ? event['eventType'].slice(0, 64) : 'unknown';
  console.info('on-work-event received', { eventType });
  try {
    const e = parseWorkEvent(event);
    if (!e) return skipped('unsupported_event', { eventType });
    try {
      await ensureSchema();
    } catch (err) {
      return skipped('schema_not_ready', { eventType, error: errorMessage(err) });
    }
    if (e.selfGenerated) return skipped('self', { eventType });
    if (e.actorId && (await knownAppAccounts()).includes(e.actorId)) return skipped('self', { eventType, via: 'app_account' });
    const routes = await repo.listActiveRoutes();
    if (routes.length === 0) return skipped('no_active_route', { eventType });
    if (!prefilter(e, routes)) return skipped('source_mismatch', { eventType });
    await enqueueSentinel(sentinelBody(e));
    console.info('sentinel queued', { eventType, source: e.source, kind: e.kind });
  } catch (err) {
    console.error('on-work-event failed', { eventType, error: errorMessage(err) });
  }
}

interface SentinelArtifact {
  place: ArtifactPlace;
  /** Issue or page id (a Confluence comment resolves to its page). */
  artifactId: string;
  text: string;
  title: string | null;
  url: string | null;
  author: { accountId?: string; accountType?: string } | null;
  /** Where the alert comment goes; on a JSM issue it is an internal note. */
  postOn: { source: 'jira'; issueId: string; internal: boolean } | { source: 'confluence'; pageId: string };
}

/** `retry`: the artifact may become readable shortly (search index lag), so the event is re-queued. */
type LoadResult = { ok: true; artifact: SentinelArtifact } | { ok: false; reason: string; retry?: boolean };

/** Reads the artifact of a queued event as the app. */
async function loadArtifact(b: SentinelBody, siteUrl: () => Promise<string | null>): Promise<LoadResult> {
  if (b.source === 'jira') {
    const issue = await jira.getIssueForSentinel(b.artifactId);
    if (!issue) return { ok: false, reason: 'not_found' };
    const f = issue.fields ?? {};
    const place: ArtifactPlace = {
      source: 'jira',
      projectKey: f.project?.key ?? null,
      spaceKey: null,
      componentNames: (f.components ?? []).flatMap((c) => (c.name ? [c.name] : [])),
      labels: f.labels ?? [],
    };
    const base = await siteUrl();
    const issueUrl = base ? `${base}/browse/${issue.key}` : null;
    const postOn = { source: 'jira' as const, issueId: String(issue.id), internal: f.project?.projectTypeKey === 'service_desk' };
    if (b.kind === 'comment') {
      const comment = await jira.getComment(b.artifactId, b.commentId);
      if (!comment) return { ok: false, reason: 'not_found' };
      if (comment.visibility || comment.jsdPublic === false) return { ok: false, reason: 'restricted' };
      return {
        ok: true,
        artifact: {
          place,
          artifactId: b.artifactId,
          text: adfToText(comment.body),
          title: f.summary ?? issue.key,
          url: issueUrl ? `${issueUrl}?focusedCommentId=${b.commentId}` : null,
          author: comment.author ?? null,
          postOn,
        },
      };
    }
    return {
      ok: true,
      artifact: {
        place,
        artifactId: b.artifactId,
        text: `${f.summary ?? ''}\n${adfToText(f.description)}`,
        title: f.summary ?? issue.key,
        url: issueUrl,
        author: f.creator ?? f.reporter ?? null,
        postOn,
      },
    };
  }
  const isComment = b.kind === 'comment';
  const content = await confluence.getSentinelContent(isComment ? 'comment' : 'page', isComment ? b.commentId : b.artifactId);
  if (content === 'not_indexed') return { ok: false, reason: 'not_indexed', retry: true };
  if (!content) return { ok: false, reason: 'not_found' };
  if (!content.pageId) return { ok: false, reason: 'not_on_page' };
  const place: ArtifactPlace = { source: 'confluence', projectKey: null, spaceKey: content.spaceKey, componentNames: [], labels: [] };
  const body = storageToText(content.storage);
  const webui = content.links.webui;
  const base = content.links.base ?? (webui ? await siteUrl().then((s) => (s ? `${s}/wiki` : undefined)) : undefined);
  const url = base && webui ? `${base}${webui}` : null;
  const postOn = { source: 'confluence' as const, pageId: content.pageId };
  if (isComment) {
    return { ok: true, artifact: { place, artifactId: content.pageId, text: body, title: content.pageTitle, url, author: content.createdBy ?? content.versionBy, postOn } };
  }
  // An update is attributed to whoever saved this version, a new page to its creator.
  const author = b.eventType === 'avi:confluence:updated:page' ? content.versionBy : content.createdBy;
  return { ok: true, artifact: { place, artifactId: content.pageId, text: `${content.pageTitle ?? ''}\n${body}`, title: content.pageTitle, url, author, postOn } };
}

/** 400/404/410 from Jira or Confluence will not change on retry (deleted, or an endpoint that was removed). */
const isPermanent = (err: unknown): number | null =>
  (err instanceof ConfluenceError || err instanceof JiraError) && [400, 404, 410].includes(err.status) ? err.status : null;

/** Owner team name for an alert: the service mapping that owns the route target, else the incident's responder. */
async function teamNameFor(teamId: string, incidentKey: string, mappings: readonly ServiceMapping[]): Promise<string | null> {
  const mapped = mappings.find((m) => m.ownerTeamId && teamUuid(m.ownerTeamId) === teamId && m.ownerTeamName);
  if (mapped?.ownerTeamName) return mapped.ownerTeamName;
  const responder = responderOf(await repo.getIncident(incidentKey), mappings);
  return responder && responder.teamId === teamId ? responder.teamName : null;
}

type SentinelOutcome = { status: 'done'; posted: number } | { status: 'rate_limited' } | { status: 'not_indexed' } | { status: 'skipped'; reason: string };

async function runSentinel(b: SentinelBody): Promise<SentinelOutcome> {
  const routes = await repo.listActiveRoutes();
  if (routes.length === 0) return { status: 'skipped', reason: 'no_active_route' };
  let site: Promise<string | null> | undefined;
  const siteUrl = () => (site ??= jira.siteUrl());
  let loaded: LoadResult;
  try {
    loaded = await loadArtifact(b, siteUrl);
  } catch (err) {
    const status = isPermanent(err);
    if (status === null) throw err;
    console.warn('sentinel read failed (not retried)', { source: b.source, kind: b.kind, status, error: errorMessage(err) });
    return { status: 'skipped', reason: `read_failed_${status}` };
  }
  if (!loaded.ok) return loaded.retry ? { status: 'not_indexed' } : { status: 'skipped', reason: loaded.reason };
  const a = loaded.artifact;
  let apps = await knownAppAccounts();
  if (a.author?.accountType === 'app' && a.author.accountId) {
    const merged = mergeAppAccounts(apps, [a.author.accountId]);
    if (merged.length !== apps.length) await repo.setSetting(APP_ACCOUNTS_KEY, merged);
  }
  if (isSelfArtifact(a.author, apps, a.text)) return { status: 'skipped', reason: 'self' };
  const matches = matchRoutes(routes, a.place, a.text);
  if (matches.length === 0) return { status: 'skipped', reason: 'no_match' };

  const now = Date.now();
  const weekSince = new Date(now - 7 * 24 * 3600_000).toISOString();
  const daySince = new Date(now - 24 * 3600_000).toISOString();
  const cap = parseWeeklyCap(await repo.getSetting<unknown>(SENTINEL_WEEKLY_CAP_KEY));
  const dailyCap = parseDailyCap(await repo.getSetting<unknown>(SENTINEL_DAILY_CAP_KEY));
  const mappings = await repo.listServiceMappings();
  const alertedTeams = new Set<string>();
  const artifact = `${b.source}:${b.kind}:${a.artifactId}${b.commentId ? `/${b.commentId}` : ''}`;
  let posted = 0;

  for (const { route, matched } of matches) {
    console.info('sentinel matched', { routeId: route.id, artifact });
    const teamId = route.spec.target.teamId;
    if (alertedTeams.has(teamId)) {
      skipped('team_already_alerted', { routeId: route.id });
      continue;
    }
    const gate = alertGate(await repo.listAlertsForArtifact(route.id, a.artifactId, b.commentId), now);
    if (!gate.go) {
      skipped(gate.reason, { routeId: route.id });
      continue;
    }
    const teamName = await teamNameFor(teamId, route.originIncidentKey, mappings);
    const alert = {
      routeId: route.id,
      incidentKey: route.originIncidentKey,
      source: b.source,
      artifactKind: b.kind,
      artifactId: a.artifactId,
      commentId: b.commentId,
      artifactUrl: a.url,
      artifactTitle: a.title,
      matchedKeywords: matched,
      targetTeamId: teamId,
      targetTeamName: teamName,
    };
    // Recorded (as in flight) before the caps are counted and before posting: concurrent runs count each other's
    // rows, a crash after posting still blocks a second post (lifetime dedup), and a failure stays visible.
    const alertId = await repo.insertAlert({ ...alert, status: 'failed', reason: 'posting' });
    const capHit =
      (await repo.countAlertsSince(weekSince, teamId)) > cap ? { reason: 'weekly_cap', cap } : (await repo.countAlertsSince(daySince)) > dailyCap ? { reason: 'daily_cap', cap: dailyCap } : null;
    if (capHit) {
      await repo.updateAlert(alertId, { status: 'skipped', reason: capHit.reason });
      skipped(capHit.reason, { routeId: route.id, cap: capHit.cap });
      continue;
    }
    const base = await siteUrl();
    const comment = buildAlertComment({
      teamName: teamName ?? 'the owner team',
      incidentKey: route.originIncidentKey,
      incidentUrl: base ? `${base}/browse/${route.originIncidentKey}` : null,
    });
    try {
      const created =
        a.postOn.source === 'jira'
          ? await jira.addComment(a.postOn.issueId, comment.adf, { internal: a.postOn.internal })
          : await confluence.createFooterComment(a.postOn.pageId, comment.storage);
      await repo.updateAlert(alertId, { status: 'posted', reason: null, postedCommentId: created.id, error: null });
      const appAuthor = (created as { authorId?: string }).authorId;
      if (appAuthor && !apps.includes(appAuthor)) {
        apps = mergeAppAccounts(apps, [appAuthor]);
        await repo.setSetting(APP_ACCOUNTS_KEY, apps);
      }
      alertedTeams.add(teamId);
      posted += 1;
      console.info('alert posted', { alertId, commentId: created.id });
    } catch (err) {
      const rateLimited = isJiraRateLimited(err) || isConfluenceRateLimited(err);
      await repo.updateAlert(alertId, { status: 'failed', reason: rateLimited ? 'rate_limited' : 'api_error', error: errorMessage(err) });
      if (rateLimited) return { status: 'rate_limited' };
      console.warn('sentinel post failed', { alertId, error: errorMessage(err) });
    }
  }
  return { status: 'done', posted };
}

/**
 * Consumer for the `sentinel` queue: under a per-artifact lock it reads the artifact as the app, skips app-written
 * artifacts, matches active routes and posts at most one heads-up per team (lifetime dedup per route and artifact
 * or comment, bounded failure retries, weekly cap per team, daily cap overall). 429 → re-queued after 60 s with
 * `attempt + 1`, at most 3 attempts.
 */
export async function checkSentinel(event: QueueEvent | undefined): Promise<InvocationError | void> {
  let body: SentinelBody;
  try {
    body = parseSentinelBody(event?.body);
  } catch (err) {
    console.warn('sentinel: invalid event ignored', { error: errorMessage(err) });
    return;
  }
  if (!(await schemaReady('checkSentinel'))) return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
  const lock = sentinelLock(body);
  if (!(await repo.acquireAppLock(lock, new Date().toISOString(), SENTINEL_LOCK_SECONDS))) return retryLater(SCHEMA_RETRY_SECONDS, 'locked');
  try {
    let outcome: SentinelOutcome;
    try {
      outcome = await runSentinel(body);
    } catch (err) {
      if (!(isJiraRateLimited(err) || isConfluenceRateLimited(err))) {
        console.error('sentinel failed', { source: body.source, kind: body.kind, error: errorMessage(err) });
        return;
      }
      outcome = { status: 'rate_limited' };
    }
    if (outcome.status === 'skipped') return skipped(outcome.reason, { source: body.source, kind: body.kind });
    if (outcome.status === 'done') {
      console.info('sentinel done', { source: body.source, kind: body.kind, posted: outcome.posted });
      return;
    }
    // 429, or a comment the search index does not have yet: re-queued after 60 s, at most 3 attempts.
    const why = outcome.status === 'not_indexed' ? 'not indexed yet' : 'rate limited';
    if (body.attempt >= MAX_SENTINEL_ATTEMPTS) {
      console.warn(`sentinel: ${why}, gave up`, { attempt: body.attempt });
      return;
    }
    await enqueueSentinel({ ...body, attempt: body.attempt + 1 }, RATE_LIMIT_DELAY_SECONDS);
    console.warn(`sentinel: ${why}, re-queued`, { attempt: body.attempt });
  } finally {
    await repo.releaseAppLock(lock);
  }
}

export const traceReach = stub('traceReach');
export const proposeRoutesJob = stub('proposeRoutesJob');
export const purgeExpired = stub('purgeExpired');
