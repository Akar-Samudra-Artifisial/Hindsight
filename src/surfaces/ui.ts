import { randomUUID } from 'node:crypto';
import { Queue } from '@forge/events';
import Resolver from '@forge/resolver';
import { confluence } from '../adapters/confluence';
import { jira } from '../adapters/jira';
import { repo, type AnalysisJob } from '../adapters/repo';
import { ensureSchema } from '../adapters/sql';
import { cloudIdFromInstallContext, createTeamLookup, readSpike } from '../adapters/teamworkGraph';
import { decideSignal, listVisibleSignals } from '../core/decisions';
import { INCIDENT_SLOT } from '../core/demoData';
import { DEMO_QUEUE, publicJob, readDemoJob, startDemoJob } from '../core/demoJob';
import { DOSSIER_STATUS_KEY, type DossierStatus } from '../core/dossier';
import { stampDemo } from '../core/demoStamp';
import { activateRoute, readReach, runTrace } from '../core/reachFlow';
import { containerNotes, existingContainerWarnings } from '../core/seed';
import { reachDeps } from './reachDeps';
import { startAnalysis } from '../core/jobs';
import { MIGRATIONS } from '../core/migrations';
import { SchemaSettingUpError } from '../core/schema';
import {
  InputError,
  MAX_SERVICE_MAPPINGS,
  parseDecision,
  parseDemoKind,
  parseIncidentKey,
  parseOptionalSignalId,
  parseRouteId,
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
    const reach = await readReach(incidentKey, new Set(signals.map((x) => x.id)), { repo });
    if (!job) return { ready: true, incidentKey, ...simulated, job: null, funnel: null, signals, hiddenCount, scoreFailedCount: 0, scoreFailed: { quoteNotFound: 0, invalidOutput: 0 }, reach };
    const [counts, errors] = await Promise.all([repo.candidateStatusCounts(job.id), repo.scoreErrorCounts(job.id)]);
    return {
      ready: true,
      incidentKey,
      ...simulated,
      reach,
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

const contextCloudId = (ctx: ResolverContext): string | undefined => ctx.cloudId || cloudIdFromInstallContext(ctx.installContext);

/** Traces the confirmed signals (or one `signalId`) as the current user and recomputes the routes. */
resolver.define('traceReach', async ({ payload, context }) =>
  guarded(async () => {
    const ctx = context as ResolverContext;
    const incidentKey = incidentKeyOf(payload, ctx);
    const signalId = parseOptionalSignalId(payload['signalId']);
    await ensureSchema();
    return { ready: true, ...(await runTrace(incidentKey, { via: 'resolver', ...(signalId ? { signalId } : {}) }, reachDeps(contextCloudId(ctx)))) };
  }),
);

/** Approves a proposed route (→ active) as the current user. */
resolver.define('decideRoute', async ({ payload, context }) =>
  guarded(async () => {
    const ctx = context as ResolverContext;
    const routeId = parseRouteId(payload['routeId']);
    if (!ctx.accountId) throw new InputError('No user in context.');
    await ensureSchema();
    const result = await activateRoute(routeId, ctx.accountId, reachDeps(contextCloudId(ctx)));
    return { ready: true, ...result };
  }),
);

/**
 * Setup, admin only: "Reviewed by" note on the S1 demo page and the admin as watcher of the PAY story and the two S2
 * tickets, as the admin, so Teamwork Graph has a human touch on the demo artifacts. Idempotent.
 */
resolver.define('stampDemo', async ({ context }) =>
  guarded(async () => {
    const accountId = await requireSetupAdmin(context as ResolverContext, 'stampDemo');
    await ensureSchema();
    const result = await stampDemo(accountId, {
      listDemoArtifacts: () => repo.listDemoArtifacts(),
      getPageAsUser: (id) => confluence.getPageAsUser(id),
      updatePageAsUser: (id, page) => confluence.updatePageAsUser(id, page),
      addWatcherAsUser: (key, id) => jira.addWatcherAsUser(key, id),
    });
    console.info('demo stamped', { pages: result.pages + result.pagesAlready, watchers: result.watchers, newPages: result.pages, failed: result.failed.length });
    if (result.failed.length > 0) console.warn('demo stamp issues', { failed: result.failed });
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

const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_SPIKE_ACCOUNTS = 10;
const MAX_SPIKE_CONTRIBUTORS = 5;
/** Last 8 characters: enough to tell test accounts apart without exposing the account id. */
const shortId = (accountId: string): string => `…${accountId.slice(-8)}`;

function parseSpikeAccountIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new InputError('accountIds must be a list of account ids.');
  const ids = [...new Set(value.map((v: string) => v.trim()).filter((v) => v !== ''))];
  if (ids.length > MAX_SPIKE_ACCOUNTS) throw new InputError(`At most ${MAX_SPIKE_ACCOUNTS} account ids.`);
  for (const id of ids) if (!ACCOUNT_ID.test(id)) throw new InputError(`"${shortId(id)}" is not an account id.`);
  return ids;
}

function parseSpikePageId(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return null;
  if (!/^[0-9]{1,20}$/.test(text)) throw new InputError('pageId must be a numeric Confluence page id.');
  return text;
}

/**
 * Spike [VERIFY]: can the current user's session read `atlassianUserInTeams` for OTHER account ids? Looks up the
 * current user plus the given ids (and, optionally, up to 5 contributors of a page). Admin only; replies and logs
 * carry shortened account ids only.
 */
resolver.define('teamSpike', async ({ payload, context }) =>
  guarded(async () => {
    const ctx = context as ResolverContext;
    const self = await requireSetupAdmin(ctx, 'teamSpike');
    const cloudId = ctx.cloudId || cloudIdFromInstallContext(ctx.installContext);
    if (!cloudId) return { error: 'Site id unavailable.' };
    const accountIds = parseSpikeAccountIds(payload['accountIds']);
    const pageId = parseSpikePageId(payload['pageId']);
    const lookup = createTeamLookup(cloudId);

    const lookupTeams = async (accountId: string, source: 'self' | 'input' | 'contributor') => {
      const r = await lookup.teamsOf(accountId);
      return {
        accountId: shortId(accountId),
        source,
        ok: r.ok,
        status: r.status,
        teams: r.ok ? r.teams : [],
        error: r.ok ? null : r.error,
      };
    };

    const results = await Promise.all([self, ...accountIds.filter((id) => id !== self)].map((id) => lookupTeams(id, id === self ? 'self' : 'input')));
    let contributors: Record<string, unknown> | null = null;
    if (pageId) {
      const c = await lookup.contributorsOf(pageId);
      if (c.ok) {
        const teamsOfContributors = await Promise.all(c.accountIds.slice(0, MAX_SPIKE_CONTRIBUTORS).map((id) => lookupTeams(id, 'contributor')));
        contributors = { pageId, ok: true, status: c.status, count: c.accountIds.length, truncated: c.truncated, results: teamsOfContributors };
      } else {
        contributors = { pageId, ok: false, status: c.status, error: c.error };
      }
    }
    console.info('team spike', {
      results: results.map((r) => ({ source: r.source, ok: r.ok, status: r.status, teams: r.teams.length })),
      contributors: contributors ? { ok: contributors['ok'], count: contributors['count'] ?? null } : null,
    });
    return { cloudId, results, contributors };
  }),
);

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
