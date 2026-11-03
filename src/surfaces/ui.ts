import { Queue } from '@forge/events';
import Resolver from '@forge/resolver';
import { confluence } from '../adapters/confluence';
import { jira } from '../adapters/jira';
import { repo, type AnalysisJob } from '../adapters/repo';
import { ensureSchema } from '../adapters/sql';
import { cloudIdFromInstallContext, readSpike } from '../adapters/teamworkGraph';
import { filterVisible } from '../core/access';
import { MAX_CANDIDATES } from '../core/filter';
import { startAnalysis } from '../core/jobs';
import { MIGRATIONS } from '../core/migrations';
import { SchemaSettingUpError } from '../core/schema';
import { InputError, parseIncidentKey, parseWindowDays } from '../core/validate';

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
const EXCERPT_PREVIEW = 400;

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

/**
 * Latest analysis of the incident: job, funnel (scanned → stored → candidates) and the kept candidates the current
 * user can see; the others are only counted in `hiddenCount`.
 */
resolver.define('getAnalysis', async ({ payload, context }) =>
  guarded(async () => {
    const ctx = context as ResolverContext;
    const incidentKey = incidentKeyOf(payload, ctx);
    await ensureSchema();
    const incident = await jira.getIncidentAsUser(incidentKey);
    if (!incident) throw new InputError(`Incident ${incidentKey} was not found, or you do not have permission to view it.`);
    const job = await repo.getLatestJobForIncident(incidentKey);
    if (!job) return { ready: true, incidentKey, job: null, funnel: null, candidates: [], hiddenCount: 0 };
    const kept = await repo.listKeptCandidates(job.id, MAX_CANDIDATES);
    const events = new Map((await repo.getEventsByIds(kept.map((c) => c.eventId))).map((e) => [e.id, e]));
    const { visible, hiddenCount } = await filterVisible(
      kept.map((c) => ({ candidate: c, event: events.get(c.eventId) })),
      { visibleIssueIds: (ids) => jira.visibleIssueIds(ids), visiblePageIds: (ids) => confluence.visiblePageIds(ids) },
    );
    return {
      ready: true,
      incidentKey,
      job: jobView(job),
      funnel: { scanned: job.scannedCount, stored: job.storedCount, candidates: job.candidateCount, truncated: job.truncatedCount },
      candidates: visible.flatMap(({ candidate: c, event: e }) =>
        e
          ? [
              {
                id: c.id,
                title: e.title,
                source: e.source,
                kind: e.kind,
                artifactKey: e.artifactKey,
                url: e.url,
                daysBefore: c.daysBefore,
                score: c.filterScore,
                hintType: c.hintType,
                reasons: c.reasons,
                matchedKeywords: c.matchedKeywords,
                excerpt: c.excerpt ? c.excerpt.slice(0, EXCERPT_PREVIEW) : null,
              },
            ]
          : [],
      ),
      hiddenCount,
    };
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

export const handler = resolver.getDefinitions();
