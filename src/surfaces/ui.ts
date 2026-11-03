import { randomUUID } from 'node:crypto';
import { Queue } from '@forge/events';
import Resolver from '@forge/resolver';
import { confluence } from '../adapters/confluence';
import { jira } from '../adapters/jira';
import { repo, type AnalysisJob } from '../adapters/repo';
import { ensureSchema } from '../adapters/sql';
import { cloudIdFromInstallContext, readSpike } from '../adapters/teamworkGraph';
import { decideSignal, listVisibleSignals } from '../core/decisions';
import { INCIDENT_SLOT } from '../core/demoData';
import { DEMO_QUEUE, publicJob, readDemoJob, startDemoJob } from '../core/demoJob';
import { DOSSIER_STATUS_KEY, type DossierStatus } from '../core/dossier';
import { containerNotes, existingContainerWarnings } from '../core/seed';
import { startAnalysis } from '../core/jobs';
import { MIGRATIONS } from '../core/migrations';
import { SchemaSettingUpError } from '../core/schema';
import {
  InputError,
  MAX_SERVICE_MAPPINGS,
  parseDecision,
  parseDemoKind,
  parseIncidentKey,
  parseServiceKey,
  parseServiceMapping,
  parseSignalId,
  parseWindowDays,
} from '../core/validate';

const SETUP_MODULE = 'hindsight-setup';
const SURFACES = new Set(['incident', 'insights', 'setup']);

const resolver = new Resolver();

interface SchemaReply {
  ready: boolean;
  applied: number;
  total: number;
}

/** Schema state without DDL; while pending, `ensureSchema` also queues a migration run. */
async function schemaReply(): Promise<SchemaReply> {
  try {
    await ensureSchema();
    return { ready: true, applied: MIGRATIONS.length, total: MIGRATIONS.length };
  } catch (err) {
    if (err instanceof SchemaSettingUpError) return { ready: false, applied: err.applied, total: err.total };
    throw err;
  }
}

resolver.define('getStatus', async ({ payload }) => {
  const surface = typeof payload['surface'] === 'string' ? payload['surface'] : '';
  if (!SURFACES.has(surface)) return { error: `Unknown surface "${surface}".` };
  return { surface, ...(await schemaReply()) };
});

interface ResolverContext {
  accountId?: string;
  moduleKey?: string;
  cloudId?: string;
  installContext?: string;
  extension?: { issue?: { key?: string } };
}

const collectQueue = new Queue({ key: 'collect' });
const scoreQueue = new Queue({ key: 'score' });
const demoQueue = new Queue({ key: DEMO_QUEUE });

/** Incident key from the payload, else the issue the panel is open on. */
function incidentKeyOf(payload: Record<string, unknown>, ctx: ResolverContext): string {
  return parseIncidentKey(payload['incidentKey'] ?? ctx.extension?.issue?.key);
}

/** Turns input and schema errors into replies the UI can show; other errors propagate. */
async function guarded<T>(run: () => Promise<T>): Promise<T | { error: string } | SchemaReply> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InputError) return { error: err.message };
    if (err instanceof SchemaSettingUpError) return { ready: false, applied: err.applied, total: err.total };
    throw err;
  }
}

/**
 * Gate for every setup mutation: the call must come from the Hindsight setup page and the current user must be a
 * Jira administrator (`mypermissions` as the user). Throws InputError, which `guarded` turns into `{ error }`.
 */
async function requireSetupAdmin(ctx: ResolverContext, what: string): Promise<string> {
  if (ctx.moduleKey !== SETUP_MODULE) throw new InputError(`${what} is only available on Hindsight setup.`);
  if (!ctx.accountId) throw new InputError('No user in context.');
  if (!(await jira.isAdminAsUser())) throw new InputError('Only Jira administrators can change Hindsight setup.');
  return ctx.accountId;
}

/** Starts (or returns the running) analysis of the incident, as the current user. */
resolver.define('startAnalysis', async ({ payload, context }) =>
  guarded(async () => {
    const ctx = context as ResolverContext;
    const incidentKey = incidentKeyOf(payload, ctx);
    const windowDays = parseWindowDays(payload['windowDays']);
    await ensureSchema();
    const result = await startAnalysis(incidentKey, windowDays, ctx.accountId ?? null, {
      getIncidentAsUser: (key) => jira.getIncidentAsUser(key),
      getIssueProperty: (key, property) => jira.getIssueProperty(key, property),
      repo,
      pushCollect: async (body) => {
        await collectQueue.push({ body: { ...body } });
      },
      now: Date.now,
    });
    console.info('analysis start', { incidentKey, status: result.status, jobId: result.jobId });
    return { ready: true, incidentKey, ...result };
  }),
);

function jobView(job: AnalysisJob) {
  const scope = (job.scope ?? {}) as { limited?: unknown; serviceKey?: unknown };
  return {
    id: job.id,
    status: job.status,
    windowDays: job.windowDays,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastError: job.lastError,
    progress: job.progress,
    limited: scope.limited === true,
    serviceKey: typeof scope.serviceKey === 'string' ? scope.serviceKey : null,
  };
}

const accessDeps = { visibleIssueIds: (ids: readonly string[]) => jira.visibleIssueIds(ids), visiblePageIds: (ids: readonly string[]) => confluence.visiblePageIds(ids) };

/**
 * Latest analysis of the incident: job (with scoring progress), funnel (scanned → stored → candidates), the signals
 * the current user can see (others only counted in `hiddenCount`) and how many candidates failed scoring.
 */
resolver.define('getAnalysis', async ({ payload, context }) =>
  guarded(async () => {
    const ctx = context as ResolverContext;
    const incidentKey = incidentKeyOf(payload, ctx);
    await ensureSchema();
    const incident = await jira.getIncidentAsUser(incidentKey);
    if (!incident) throw new InputError(`Incident ${incidentKey} was not found, or you do not have permission to view it.`);
    const [job, stored] = await Promise.all([repo.getLatestJobForIncident(incidentKey), repo.getIncident(incidentKey)]);
    const simulated = { simulated: stored?.scenarioStartedAt != null, scenarioStartedAt: stored?.scenarioStartedAt ?? null };
    const { signals, hiddenCount } = await listVisibleSignals(incidentKey, { repo, ...accessDeps });
    if (!job) return { ready: true, incidentKey, ...simulated, job: null, funnel: null, signals, hiddenCount, scoreFailedCount: 0, scoreFailed: { quoteNotFound: 0, invalidOutput: 0 } };
    const [counts, errors] = await Promise.all([repo.candidateStatusCounts(job.id), repo.scoreErrorCounts(job.id)]);
    return {
      ready: true,
      incidentKey,
      ...simulated,
      job: jobView(job),
      funnel: { scanned: job.scannedCount, stored: job.storedCount, candidates: job.candidateCount, truncated: job.truncatedCount },
      signals,
      hiddenCount,
      scoreFailedCount: counts['score_failed'] ?? 0,
      scoreFailed: { quoteNotFound: errors['quote_not_found'] ?? 0, invalidOutput: errors['llm_invalid_output'] ?? 0 },
    };
  }),
);

/** Confirm / reject / undo a signal from the incident panel, as the current user (same rules as `confirm-signal`). */
resolver.define('decideSignal', async ({ payload, context }) =>
  guarded(async () => {
    const ctx = context as ResolverContext;
    const incidentKey = incidentKeyOf(payload, ctx);
    const signalId = parseSignalId(payload['signalId']);
    const decision = parseDecision(payload['decision']);
    if (!ctx.accountId) throw new InputError('No user in context.');
    await ensureSchema();
    const result = await decideSignal(
      { incidentKey, signalId, decision, accountId: ctx.accountId },
      { getIncidentAsUser: (key) => jira.getIncidentAsUser(key), repo, ...accessDeps },
    );
    console.info('signal decision', { incidentKey, signalId, decision, status: result.status });
    return { ready: true, ...result };
  }),
);

/** Teamwork Graph connector status for the setup page; never returns the connectionId. */
resolver.define('getGraphConnection', async ({ context }) => {
  const ctx = context as ResolverContext;
  if (ctx.moduleKey !== SETUP_MODULE) return { error: 'getGraphConnection is only available on Hindsight setup.' };
  const schema = await schemaReply();
  if (!schema.ready) return { connected: false, name: null, updatedAt: null };
  const connection = await repo.getActiveGraphConnection();
  return { connected: connection !== undefined, name: connection?.name ?? null, updatedAt: connection?.updatedAt ?? null };
});

/** Teamwork Graph read spike, as the current user; setup page only. */
resolver.define('twgSpike', async ({ context }) => {
  const ctx = context as ResolverContext;
  if (ctx.moduleKey !== SETUP_MODULE) return { error: 'twgSpike is only available on Hindsight setup.' };
  if (!ctx.accountId) return { error: 'No user in context.' };
  const cloudId = ctx.cloudId || cloudIdFromInstallContext(ctx.installContext);
  if (!cloudId) return { error: 'Site id unavailable.' };
  return readSpike(cloudId, ctx.accountId);
});

// --- Service mappings (setup, admin only) ---------------------------------------------------------

resolver.define('listServiceMappings', async ({ context }) =>
  guarded(async () => {
    await requireSetupAdmin(context as ResolverContext, 'listServiceMappings');
    await ensureSchema();
    return { ready: true, mappings: await repo.listServiceMappings(), max: MAX_SERVICE_MAPPINGS };
  }),
);

resolver.define('saveServiceMapping', async ({ payload, context }) =>
  guarded(async () => {
    await requireSetupAdmin(context as ResolverContext, 'saveServiceMapping');
    const mapping = parseServiceMapping(payload['mapping']);
    await ensureSchema();
    const existing = await repo.listServiceMappings();
    if (!existing.some((m) => m.serviceKey === mapping.serviceKey) && existing.length >= MAX_SERVICE_MAPPINGS) {
      throw new InputError(`Hindsight supports at most ${MAX_SERVICE_MAPPINGS} service mappings.`);
    }
    await repo.upsertServiceMapping(mapping);
    console.info('service mapping saved', { serviceKey: mapping.serviceKey });
    return { ready: true, mappings: await repo.listServiceMappings(), max: MAX_SERVICE_MAPPINGS };
  }),
);

resolver.define('deleteServiceMapping', async ({ payload, context }) =>
  guarded(async () => {
    await requireSetupAdmin(context as ResolverContext, 'deleteServiceMapping');
    const serviceKey = parseServiceKey(payload['serviceKey']);
    await ensureSchema();
    const deleted = await repo.deleteServiceMapping(serviceKey);
    console.info('service mapping deleted', { serviceKey, deleted });
    return { ready: true, mappings: await repo.listServiceMappings(), max: MAX_SERVICE_MAPPINGS };
  }),
);

// --- Demo data (setup, admin only) ----------------------------------------------------------------

async function demoIncidentKey(): Promise<string | null> {
  const artifacts = await repo.listDemoArtifacts();
  return artifacts.find((a) => a.slot === INCIDENT_SLOT)?.artifactKey ?? null;
}

resolver.define('startDemoJob', async ({ payload, context }) =>
  guarded(async () => {
    const accountId = await requireSetupAdmin(context as ResolverContext, 'startDemoJob');
    const kind = parseDemoKind(payload['kind']);
    await ensureSchema();
    const result = await startDemoJob(kind, accountId, {
      repo,
      push: async (jobId) => {
        await demoQueue.push({ body: { jobId, attempt: 1 } });
      },
      now: Date.now,
      newId: randomUUID,
    });
    if ('job' in result) console.info('demo job start', { kind, started: result.started, jobId: result.job.id });
    return { ready: true, ...result };
  }),
);

resolver.define('getDemoJob', async ({ context }) =>
  guarded(async () => {
    await requireSetupAdmin(context as ResolverContext, 'getDemoJob');
    await ensureSchema();
    const job = await readDemoJob({ repo, now: Date.now });
    const artifacts = await repo.listDemoArtifacts();
    return {
      ready: true,
      job: job ? publicJob(job) : null,
      incidentKey: artifacts.find((a) => a.slot === INCIDENT_SLOT)?.artifactKey ?? null,
      warnings: existingContainerWarnings(artifacts),
      notes: containerNotes(artifacts).filter((n) => !existingContainerWarnings(artifacts).includes(n)),
    };
  }),
);

// --- Teamwork Graph dossier (setup, admin only) ----------------------------------------------------

/** Queues a `score` run for the demo incident's latest analysis; the consumer writes the dossier (never the resolver). */
resolver.define('writeTestDossier', async ({ context }) =>
  guarded(async () => {
    await requireSetupAdmin(context as ResolverContext, 'writeTestDossier');
    await ensureSchema();
    const incidentKey = await demoIncidentKey();
    if (!incidentKey) throw new InputError('There is no demo incident yet. Click Load demo data first.');
    const job = await repo.getLatestCollectedJobForIncident(incidentKey);
    if (!job) throw new InputError(`No finished analysis of ${incidentKey} yet. Open ${incidentKey}, click Analyze and wait until the candidates appear.`);
    await scoreQueue.push({ body: { jobId: job.id } });
    console.info('test dossier queued', { incidentKey, jobId: job.id });
    return { ready: true, queued: true, incidentKey };
  }),
);

resolver.define('getDossierStatus', async ({ context }) =>
  guarded(async () => {
    await requireSetupAdmin(context as ResolverContext, 'getDossierStatus');
    await ensureSchema();
    return { ready: true, last: (await repo.getSetting<DossierStatus>(DOSSIER_STATUS_KEY)) ?? null };
  }),
);

export const handler = resolver.getDefinitions();
