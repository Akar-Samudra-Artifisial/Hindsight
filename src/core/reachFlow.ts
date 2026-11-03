import type { Incident, ReachPath, Repo, Route, ServiceMapping, Signal, StoredEvent } from '../adapters/repo';
import type { ContributorsResult, TeamLookup } from '../adapters/teamworkGraph';
import { filterVisible, type AccessDeps } from './access';
import { computeMetrics, reachedWithUnknownTime, teamUuid, termsOf, traceReach, type ReachMetrics, type ReachSignal, type Touch, type TouchesResult } from './reach';
import { proposeRoutes, type RouteSignal } from './routes';
import { InputError } from './validate';
import type { ReachVia } from '../adapters/repo';

/**
 * Reach and routes for one incident, shared by the incident panel (resolvers) and the Rovo actions. Runs as the
 * current user: the incident and every traced artifact must be visible to them, and Teamwork Graph is read with
 * their session. Results are stored (`reach_paths`, `routes`); the dossier is refreshed by the `score` consumer.
 */

/** Resolver limit is 25 s; tracing stops starting new signals after this long. */
export const TRACE_BUDGET_MS = 18_000;

export interface ReachFlowDeps extends AccessDeps {
  repo: Pick<
    Repo,
    | 'getIncident'
    | 'listServiceMappings'
    | 'listSignalsForIncident'
    | 'getEventsByIds'
    | 'listEventTouches'
    | 'getCandidatesByIds'
    | 'upsertReachPaths'
    | 'listReachPaths'
    | 'upsertRoutes'
    | 'listRoutes'
    | 'deleteProposedRoutes'
    | 'getRoute'
    | 'decideRoute'
    | 'getSetting'
  >;
  getIncidentAsUser(key: string): Promise<unknown>;
  /** Is the current user a Jira administrator (`mypermissions` ADMINISTER, as the user)? Gates pause/resume. */
  isAdminAsUser(): Promise<boolean>;
  /** Site cloud id (resolver context, else looked up); null when unknown. */
  cloudId(): Promise<string | null>;
  /** Watchers of a Jira issue (with account type) as the app; throws on failure. */
  watchersOf(issueId: string): Promise<{ accountId: string; accountType: string | null }[]>;
  /** Who saved each version of a Confluence page, as the user; throws on failure (429 included). */
  pageVersionAuthors(pageId: string): Promise<{ accountId: string; at: string | null }[]>;
  isRateLimited(err: unknown): boolean;
  teamLookup(cloudId: string): TeamLookup;
  /** Queues a dossier rewrite (queue consumer); never throws. */
  refreshDossier(incidentKey: string): Promise<void>;
  now(): number;
}

export type GraphUnavailable = 'no_responder_team' | 'no_site_id';

export interface Responder {
  teamId: string;
  teamName: string;
}

/** Responder team of the incident: the stored one, else the owner team of its service mapping. */
export function responderOf(incident: Incident | undefined, mappings: readonly ServiceMapping[]): Responder | null {
  if (incident?.responderTeamId) return { teamId: teamUuid(incident.responderTeamId), teamName: incident.responderTeamName ?? 'the responder team' };
  const mapping = incident?.serviceKey ? mappings.find((m) => m.serviceKey === incident.serviceKey) : undefined;
  if (!mapping?.ownerTeamId) return null;
  return { teamId: teamUuid(mapping.ownerTeamId), teamName: mapping.ownerTeamName ?? 'the responder team' };
}

async function requireIncident(incidentKey: string, deps: ReachFlowDeps): Promise<Incident> {
  if (!(await deps.getIncidentAsUser(incidentKey))) throw new InputError(`Incident ${incidentKey} was not found, or you do not have permission to view it.`);
  const incident = await deps.repo.getIncident(incidentKey);
  if (!incident) throw new InputError(`${incidentKey} has not been analysed yet. Open the Hindsight panel on the incident and click Analyze.`);
  return incident;
}

interface VisibleSignal {
  signal: Signal;
  event: StoredEvent;
}

/** Confirmed signals of the incident whose artifact the user can view. */
async function visibleConfirmed(incidentKey: string, deps: ReachFlowDeps): Promise<{ all: Signal[]; visible: VisibleSignal[] }> {
  const all = await deps.repo.listSignalsForIncident(incidentKey);
  const confirmed = all.filter((s) => s.status === 'confirmed');
  if (confirmed.length === 0) return { all, visible: [] };
  const events = new Map((await deps.repo.getEventsByIds([...new Set(confirmed.map((s) => s.eventId))])).map((e) => [e.id, e]));
  const { visible } = await filterVisible(
    confirmed.map((signal) => ({ signal, event: events.get(signal.eventId) })),
    deps,
  );
  return { all, visible: visible.flatMap((v) => (v.event ? [{ signal: v.signal, event: v.event }] : [])) };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * `settings` key with the app account ids collect saw as authors (`accountType: 'app'`). `/rest/api/3/myself` as the
 * app needs a scope Hindsight does not have, so app accounts are learned from author and watcher account types.
 */
export const APP_ACCOUNTS_KEY = 'app_account_ids';
export const MAX_APP_ACCOUNTS = 20;

export function parseAppAccounts(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v !== '').slice(0, MAX_APP_ACCOUNTS) : [];
}

export function mergeAppAccounts(known: readonly string[], ids: readonly string[]): string[] {
  return [...new Set([...known, ...ids])].slice(-MAX_APP_ACCOUNTS);
}

/**
 * Touches per artifact, people only: stored event authors (collect already drops app authors), Jira watchers (as the
 * app), page version authors (as the user, so the "Reviewed by" stamp counts) and page contributors (Teamwork Graph).
 * App accounts (from `settings`, or watchers of type `app`) are dropped.
 */
function touchReader(visible: readonly VisibleSignal[], cloudId: string, deps: ReachFlowDeps) {
  const lookup = deps.teamLookup(cloudId);
  let authors: Promise<Map<string, Touch[]>> | undefined;
  let appAccounts: Promise<Set<string>> | undefined;
  let watchersFailed = false;
  let versionsFailed = false;
  const readAuthors = () =>
    (authors ??= deps.repo.listEventTouches(visible.map((v) => v.event.artifactId)).then((rows) => {
      const map = new Map<string, Touch[]>();
      for (const r of rows) {
        const key = `${r.source === 'confluence' ? 'page' : 'issue'}|${r.artifactId}`;
        map.set(key, [...(map.get(key) ?? []), { accountId: r.authorAccountId, role: r.kind === 'comment' ? 'commenter' : 'author', at: r.at }]);
      }
      return map;
    }));
  const readAppAccounts = () =>
    (appAccounts ??= deps.repo
      .getSetting<unknown>(APP_ACCOUNTS_KEY)
      .then((raw) => new Set(parseAppAccounts(raw)))
      .catch((err: unknown) => {
        console.warn('reach: known app accounts unavailable', { error: errorText(err) });
        return new Set<string>();
      }));
  let excluded = 0;

  const touchesOf = async (s: ReachSignal): Promise<TouchesResult> => {
    const page = s.source === 'confluence';
    const apps = await readAppAccounts();
    const touches = [...((await readAuthors()).get(`${page ? 'page' : 'issue'}|${s.artifactId}`) ?? [])];
    if (page) {
      if (!versionsFailed) {
        try {
          touches.push(...(await deps.pageVersionAuthors(s.artifactId)).map((v): Touch => ({ accountId: v.accountId, role: 'contributor', at: v.at })));
        } catch (err) {
          if (deps.isRateLimited(err)) return { ok: false, rateLimited: true };
          versionsFailed = true;
          console.warn('reach: page versions unavailable, using Teamwork Graph contributors only', { error: errorText(err) });
        }
      }
      const c: ContributorsResult = await lookup.contributorsOf(s.artifactId);
      if (c.ok) touches.push(...c.accountIds.map((accountId): Touch => ({ accountId, role: 'contributor', at: null })));
      else if (c.status === 429) return { ok: false, rateLimited: true };
      else console.warn('reach: page contributors unavailable', { status: c.status, error: c.error.slice(0, 200) });
    } else if (!watchersFailed) {
      try {
        for (const w of await deps.watchersOf(s.artifactId)) {
          if (w.accountType === 'app') apps.add(w.accountId);
          else touches.push({ accountId: w.accountId, role: 'watcher', at: null });
        }
      } catch (err) {
        if (deps.isRateLimited(err)) return { ok: false, rateLimited: true };
        watchersFailed = true;
        console.warn('reach: watchers unavailable, using authors and comments only', { error: errorText(err) });
      }
    }
    const people = touches.filter((t) => !apps.has(t.accountId));
    excluded += touches.length - people.length;
    return { ok: true, touches: people };
  };

  const teamsOf = async (accountId: string) => {
    const r = await lookup.teamsOf(accountId);
    if (r.ok) return { ok: true as const, teams: r.teams };
    if (r.status !== 429) console.warn('reach: team lookup failed', { status: r.status, error: r.error.slice(0, 200) });
    return { ok: false as const, rateLimited: r.status === 429 };
  };

  return { touchesOf, teamsOf, watchersAvailable: () => !watchersFailed, appTouchesExcluded: () => excluded, appAccountsKnown: async () => (await readAppAccounts()).size };
}

export interface RouteView {
  routeId: string;
  rank: number;
  sourceType: Route['sourceType'];
  sourceKey: string;
  estimatedDaysSaved: number;
  maxDaysBefore: number;
  reason: string;
  status: Route['status'];
  keywords: string[];
  signalIds: string[];
  activatedAt: string | null;
}

export const routeView = (r: Route): RouteView => ({
  routeId: r.id,
  rank: r.rankNo,
  sourceType: r.sourceType,
  sourceKey: r.sourceKey,
  estimatedDaysSaved: r.estimatedDaysSaved,
  maxDaysBefore: r.maxDaysBefore,
  reason: r.reason,
  status: r.status,
  keywords: r.spec.keywords,
  signalIds: r.signalIds,
  activatedAt: r.activatedAt,
});

export interface PathView {
  signalId: string;
  reached: boolean | null;
  graphState: ReachPath['graphState'];
  timeUnknown: boolean;
  hopCount: number;
  steps: ReachPath['steps'];
  stopPoint: ReachPath['stopPoint'];
  computedAt: string;
}

const pathView = (p: ReachPath): PathView => ({
  signalId: p.signalId,
  reached: p.reached,
  graphState: p.graphState,
  timeUnknown: reachedWithUnknownTime(p),
  hopCount: p.hopCount,
  steps: p.steps,
  stopPoint: p.stopPoint,
  computedAt: p.computedAt,
});

/**
 * Why there are no routes: every confirmed signal with graph context reached the responder (`none_needed`), no
 * signal has graph context yet (`no_graph`), or the signals have no routable source (`no_source`). Null with routes.
 */
export type RoutesNote = 'none_needed' | 'no_graph' | 'no_source' | null;

export interface ReachView {
  graphAvailable: boolean;
  reason: GraphUnavailable | null;
  responderTeamName: string | null;
  /** Team uuid of the responder (to match map nodes); a team id, not a person. */
  responderTeamId: string | null;
  simulated: boolean;
  /** Over the confirmed signals in `visibleSignalIds` only. */
  metrics: ReachMetrics | null;
  /** Paths of the signals in `visibleSignalIds` only. */
  paths: PathView[];
  /** Routes built from at least one visible signal, best first (display rank 1..n). */
  routes: RouteView[];
  routesNote: RoutesNote;
}

const STATUS_ORDER: Record<Route['status'], number> = { active: 0, paused: 1, proposed: 2, dismissed: 3 };

/** Stored reach state of an incident for the panel and the actions (no Teamwork Graph calls). */
export async function readReach(incidentKey: string, visibleSignalIds: ReadonlySet<string>, deps: Pick<ReachFlowDeps, 'repo'>): Promise<ReachView> {
  const [incident, mappings, signals, paths, routes] = await Promise.all([
    deps.repo.getIncident(incidentKey),
    deps.repo.listServiceMappings(),
    deps.repo.listSignalsForIncident(incidentKey),
    deps.repo.listReachPaths(incidentKey),
    deps.repo.listRoutes(incidentKey),
  ]);
  const responder = responderOf(incident, mappings);
  const visiblePaths = paths.filter((p) => visibleSignalIds.has(p.signalId));
  const metrics = responder ? computeMetrics(signals.filter((s) => visibleSignalIds.has(s.id)), visiblePaths) : null;
  // Active routes keep the rank of the run that proposed them, so ranks can repeat: re-rank for display.
  const shown = routes
    .filter((r) => r.signalIds.some((id) => visibleSignalIds.has(id)))
    .sort((a, b) => b.estimatedDaysSaved - a.estimatedDaysSaved || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.rankNo - b.rankNo || a.id.localeCompare(b.id))
    .map((r, i) => ({ ...routeView(r), rank: i + 1 }));
  const routesNote: RoutesNote =
    shown.length > 0 || !metrics ? null : metrics.considered === 0 ? 'no_graph' : metrics.reached === metrics.considered ? 'none_needed' : 'no_source';
  return {
    graphAvailable: responder !== null,
    reason: responder ? null : 'no_responder_team',
    responderTeamName: responder?.teamName ?? null,
    responderTeamId: responder?.teamId ?? null,
    simulated: incident?.scenarioStartedAt != null,
    metrics,
    paths: visiblePaths.map(pathView),
    routes: shown,
    routesNote,
  };
}

export interface TraceOutcome extends ReachView {
  incidentKey: string;
  partial: boolean;
  rateLimited: boolean;
  traced: number;
  watchersAvailable: boolean;
}

async function storeRoutes(incidentKey: string, responder: Responder, visible: readonly VisibleSignal[], deps: ReachFlowDeps): Promise<number> {
  const paths = await deps.repo.listReachPaths(incidentKey);
  const candidates = new Map((await deps.repo.getCandidatesByIds([...new Set(visible.map((v) => v.signal.candidateId))])).map((c) => [c.id, c]));
  const signals: RouteSignal[] = visible.map(({ signal, event }) => ({
    signalId: signal.id,
    daysBefore: signal.daysBefore,
    confidence: signal.confidence,
    source: event.source,
    projectKey: event.projectKey,
    spaceKey: event.spaceKey,
    componentNames: event.componentNames,
    labels: event.labels,
    keywords: candidates.get(signal.candidateId)?.matchedKeywords ?? [],
  }));
  const routes = proposeRoutes({ incidentKey, responderTeamId: responder.teamId, responderTeamName: responder.teamName, signals, paths });
  const existing = await deps.repo.listRoutes(incidentKey);
  await deps.repo.upsertRoutes(routes);
  // Stale = proposed, no longer proposed now, and built only from signals this user can see (others are left alone).
  const visibleIds = new Set(visible.map((v) => v.signal.id));
  const fresh = new Set(routes.map((r) => `${r.sourceType}|${r.sourceKey}`));
  const stale = existing.filter(
    (r) => r.status === 'proposed' && !fresh.has(`${r.sourceType}|${r.sourceKey}`) && r.signalIds.length > 0 && r.signalIds.every((id) => visibleIds.has(id)),
  );
  if (stale.length > 0) await deps.repo.deleteProposedRoutes(incidentKey, stale.map((r) => r.id));
  return routes.length;
}

/**
 * Traces the confirmed signals the user can view (or only `signalId`), stores their paths, recomputes the routes and
 * queues a dossier refresh. Without a responder team or site id nothing is traced ("Graph context not available").
 */
export async function runTrace(incidentKey: string, opts: { via: ReachVia; signalId?: string }, deps: ReachFlowDeps): Promise<TraceOutcome> {
  const started = deps.now();
  const incident = await requireIncident(incidentKey, deps);
  const responder = responderOf(incident, await deps.repo.listServiceMappings());
  const { all, visible } = await visibleConfirmed(incidentKey, deps);
  const visibleIds = new Set(visible.map((v) => v.signal.id));
  if (opts.signalId) {
    const target = all.find((s) => s.id === opts.signalId);
    if (!target || (target.status === 'confirmed' && !visibleIds.has(target.id))) throw new InputError(`Signal ${opts.signalId} was not found on ${incidentKey}.`);
    if (target.status !== 'confirmed') throw new InputError('Only confirmed signals can be traced. Confirm the signal first.');
  }
  const base = { incidentKey, partial: false, rateLimited: false, traced: 0, watchersAvailable: true };
  if (!responder) return { ...base, ...(await readReach(incidentKey, visibleIds, deps)) };
  const cloudId = await deps.cloudId();
  if (!cloudId) {
    const view = await readReach(incidentKey, visibleIds, deps);
    return { ...base, ...view, graphAvailable: false, reason: 'no_site_id', metrics: null };
  }

  const targets = opts.signalId ? visible.filter((v) => v.signal.id === opts.signalId) : visible;
  const known = new Set((await deps.repo.listReachPaths(incidentKey)).filter((p) => p.graphState === 'ok').map((p) => p.signalId));
  const reader = touchReader(targets, cloudId, deps);
  const terms = termsOf([responder.teamName, incident.serviceKey ?? '', ...(await deps.repo.listServiceMappings()).filter((m) => m.serviceKey === incident.serviceKey).flatMap((m) => [m.displayName, ...m.aliases])]);
  const result = await traceReach(
    {
      incidentKey,
      incidentStartedAt: incident.scenarioStartedAt ?? incident.startedAt,
      simulated: incident.scenarioStartedAt != null,
      responderTeamId: responder.teamId,
      signals: targets.map(({ signal, event }) => ({ signalId: signal.id, daysBefore: signal.daysBefore, source: event.source, artifactId: event.artifactId })),
      via: opts.via,
      deadline: started + TRACE_BUDGET_MS,
      relatedTerms: terms,
      alreadyOk: known,
    },
    { touchesOf: reader.touchesOf, teamsOf: reader.teamsOf, now: deps.now },
  );
  // A known path is kept when this run could not trace the signal again (the repo guards this too).
  await deps.repo.upsertReachPaths(result.paths.filter((p) => p.graphState === 'ok' || !known.has(p.signalId)));
  const routeCount = await storeRoutes(incidentKey, responder, visible, deps);
  await deps.refreshDossier(incidentKey);
  console.info('reach traced', {
    incidentKey,
    signals: result.paths.length,
    traced: result.traced,
    reached: result.reached,
    partial: result.partial,
    appTouchesExcluded: reader.appTouchesExcluded(),
    appAccountsKnown: await reader.appAccountsKnown(),
    via: opts.via,
    ms: deps.now() - started,
  });
  console.info('routes proposed', { incidentKey, count: routeCount });
  return {
    ...base,
    partial: result.paths.some((p) => p.graphState === 'pending' && !known.has(p.signalId)),
    rateLimited: result.rateLimited,
    traced: result.traced,
    watchersAvailable: reader.watchersAvailable(),
    ...(await readReach(incidentKey, visibleIds, deps)),
  };
}

/**
 * Routes for the incident: traces first when a confirmed visible signal has no usable path yet, else recomputes the
 * routes from the stored paths. Never demotes an active route.
 */
export async function runPropose(incidentKey: string, opts: { via: ReachVia }, deps: ReachFlowDeps): Promise<TraceOutcome> {
  const incident = await requireIncident(incidentKey, deps);
  const responder = responderOf(incident, await deps.repo.listServiceMappings());
  const { visible } = await visibleConfirmed(incidentKey, deps);
  const visibleIds = new Set(visible.map((v) => v.signal.id));
  const base = { incidentKey, partial: false, rateLimited: false, traced: 0, watchersAvailable: true };
  if (!responder) return { ...base, ...(await readReach(incidentKey, visibleIds, deps)) };
  const paths = new Map((await deps.repo.listReachPaths(incidentKey)).map((p) => [p.signalId, p]));
  if (visible.some((v) => paths.get(v.signal.id)?.graphState !== 'ok')) return runTrace(incidentKey, { via: opts.via }, deps);
  const count = await storeRoutes(incidentKey, responder, visible, deps);
  await deps.refreshDossier(incidentKey);
  console.info('routes proposed', { incidentKey, count });
  return { ...base, ...(await readReach(incidentKey, visibleIds, deps)) };
}

/** proposed → active as the current user (the route's incident must be visible to them); active stays active. */
export async function activateRoute(routeId: string, accountId: string, deps: ReachFlowDeps, incidentKey?: string): Promise<{ route: RouteView; changed: boolean }> {
  const route = await deps.repo.getRoute(routeId);
  const notFound = new InputError(incidentKey ? `Route ${routeId} was not found on ${incidentKey}.` : `Route ${routeId} was not found.`);
  if (!route || (incidentKey && route.originIncidentKey !== incidentKey)) throw notFound;
  if (!(await deps.getIncidentAsUser(route.originIncidentKey))) throw notFound;
  if (route.status === 'active') return { route: routeView(route), changed: false };
  if (route.status === 'paused') throw new InputError(`Route ${routeId} is paused. Resume it on the Routes tab of the Hindsight panel.`);
  if (route.status !== 'proposed') throw new InputError(`Route ${routeId} is ${route.status} and cannot be activated.`);
  if ((await deps.repo.decideRoute(route.id, 'proposed', 'active', accountId)) !== 1) throw new InputError('This route was changed by someone else. Refresh and try again.');
  await deps.refreshDossier(route.originIncidentKey);
  console.info('route decision', { incidentKey: route.originIncidentKey, routeId: route.id, status: 'active' });
  const updated = await deps.repo.getRoute(route.id);
  return { route: routeView(updated ?? { ...route, status: 'active' }), changed: true };
}

/**
 * Pause (active → paused) or resume (paused → active) an approved route; Jira administrators only (approving a
 * proposed route stays open to anyone who can view the incident). Sentinel only runs
 * active routes; the rule stays frozen while paused. Already in the target status → unchanged.
 */
export async function setRouteRunning(
  routeId: string,
  to: 'active' | 'paused',
  accountId: string,
  deps: ReachFlowDeps,
  incidentKey?: string,
): Promise<{ route: RouteView; changed: boolean }> {
  const route = await deps.repo.getRoute(routeId);
  const notFound = new InputError(incidentKey ? `Route ${routeId} was not found on ${incidentKey}.` : `Route ${routeId} was not found.`);
  if (!route || (incidentKey && route.originIncidentKey !== incidentKey)) throw notFound;
  if (!(await deps.getIncidentAsUser(route.originIncidentKey))) throw notFound;
  if (!(await deps.isAdminAsUser())) throw new InputError('Only Jira administrators can pause or resume a route.');
  if (route.status === to) return { route: routeView(route), changed: false };
  const from = to === 'paused' ? 'active' : 'paused';
  if (route.status !== from) {
    throw new InputError(to === 'paused' ? `Only an active route can be paused; route ${routeId} is ${route.status}.` : `Only a paused route can be resumed; route ${routeId} is ${route.status}.`);
  }
  if ((await deps.repo.decideRoute(route.id, from, to, accountId)) !== 1) throw new InputError('This route was changed by someone else. Refresh and try again.');
  await deps.refreshDossier(route.originIncidentKey);
  console.info('route decision', { incidentKey: route.originIncidentKey, routeId: route.id, status: to });
  const updated = await deps.repo.getRoute(route.id);
  return { route: routeView(updated ?? { ...route, status: to }), changed: true };
}
