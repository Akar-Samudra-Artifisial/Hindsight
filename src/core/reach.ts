import type { GraphState, ReachPath, ReachPathInput, ReachStep, ReachStopPoint, ReachVia } from '../adapters/repo';

/**
 * Signal reach (pure). For every confirmed signal: who touched its artifact (authors, commenters, watchers, page
 * contributors), which teams those people belong to, whether a member of the responder team touched it before the
 * incident started, and where it stopped otherwise. Account ids are used here and dropped: paths hold team names only.
 */

/** Most signals traced per call; the rest are stored as `pending` ("Trace remaining"). */
export const MAX_TRACE_SIGNALS = 20;
/** Most team steps kept per path (the responder team is always kept when it touched the artifact). */
export const MAX_STEPS = 5;

export type TouchRole = 'author' | 'commenter' | 'watcher' | 'contributor';

export interface Touch {
  accountId: string;
  role: TouchRole;
  /** ISO time of the touch; null when unknown (watchers, page contributors). */
  at: string | null;
}

export interface ReachSignal {
  signalId: string;
  daysBefore: number;
  source: string;
  artifactId: string;
}

export interface GraphTeam {
  id: string;
  name: string;
}

export type TouchesResult = { ok: true; touches: Touch[] } | { ok: false; rateLimited: boolean };
export type TeamsResult = { ok: true; teams: GraphTeam[] } | { ok: false; rateLimited: boolean };

export interface TraceDeps {
  touchesOf(signal: ReachSignal): Promise<TouchesResult>;
  teamsOf(accountId: string): Promise<TeamsResult>;
  now(): number;
}

export interface TraceInput {
  incidentKey: string;
  /** Incident start (scenario start for demo data). */
  incidentStartedAt: string;
  /** Demo incident: touch times are real, not scenario times, so the "before the incident" check is skipped. */
  simulated: boolean;
  responderTeamId: string;
  signals: readonly ReachSignal[];
  via: ReachVia;
  /** Epoch ms after which no new signal is started. */
  deadline: number;
  /** Words of the service (name, aliases): teams whose name matches them are listed first. */
  relatedTerms?: readonly string[];
  maxSignals?: number;
  /** Signals that already have an `ok` path: traced last. */
  alreadyOk?: ReadonlySet<string>;
}

export interface TraceResult {
  paths: ReachPathInput[];
  /** Stopped early (deadline, signal cap or 429): some paths are `pending`. */
  partial: boolean;
  rateLimited: boolean;
  traced: number;
  reached: number;
}

/** `ari:cloud:identity::team/<uuid>` or a bare uuid → lower-case uuid (anything else is trimmed and lower-cased). */
export function teamUuid(id: string): string {
  const m = /team\/([^/\s]+)$/i.exec(id.trim());
  return (m?.[1] ?? id.trim()).toLowerCase();
}

const ROLE_ORDER: Record<TouchRole, number> = { author: 0, commenter: 1, watcher: 2, contributor: 3 };

/** Lower-case words of at least 4 letters, for matching team names with the service. */
export function termsOf(texts: readonly string[]): string[] {
  const words = texts.flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 4);
  return [...new Set(words)];
}

function relatedName(name: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => w.length >= 4 && terms.some((t) => w.startsWith(t) || t.startsWith(w)));
}

const minIso = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);

interface TeamTouch {
  id: string | null;
  name: string | null;
  roles: Set<TouchRole>;
  accounts: Set<string>;
  at: string | null;
  /** Latest known touch (stop point = the team that touched last). */
  last: string | null;
}

/** Epoch ms of an ISO time; null when missing or invalid. */
const msOf = (iso: string | null): number | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};
const maxIso = (a: string | null, b: string | null): string | null => {
  const am = msOf(a);
  const bm = msOf(b);
  if (am === null) return bm === null ? null : b;
  return bm === null || am >= bm ? a : b;
};
/** Stored step times are rounded to the day: enough for the map, less precise about individual activity. */
const dayOf = (iso: string | null): string | null => {
  const ms = msOf(iso);
  return ms === null ? null : `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;
};

const pathOf = (s: ReachSignal, input: TraceInput, graphState: GraphState, rest: Partial<ReachPathInput> = {}): ReachPathInput => ({
  signalId: s.signalId,
  incidentKey: input.incidentKey,
  reached: null,
  hopCount: 0,
  steps: [],
  stopPoint: null,
  graphState,
  responderTeamId: input.responderTeamId,
  via: input.via,
  ...rest,
});

type SignalOutcome = { kind: 'path'; path: ReachPathInput } | { kind: 'rate_limited' } | { kind: 'deadline' };

async function traceOne(s: ReachSignal, input: TraceInput, deps: TraceDeps): Promise<SignalOutcome> {
  const touches = await deps.touchesOf(s);
  if (!touches.ok) return touches.rateLimited ? { kind: 'rate_limited' } : { kind: 'path', path: pathOf(s, input, 'unknown') };

  const byAccount = new Map<string, Touch[]>();
  for (const t of touches.touches) byAccount.set(t.accountId, [...(byAccount.get(t.accountId) ?? []), t]);

  const responder = teamUuid(input.responderTeamId);
  const startMs = msOf(input.incidentStartedAt);
  const teams = new Map<string, TeamTouch>();
  const noTeam: TeamTouch = { id: null, name: null, roles: new Set(), accounts: new Set(), at: null, last: null };
  let failed = 0;
  let responderBefore = false;
  let responderBeforeAt: string | null = null;
  let responderUnknownTime = false;

  for (const [accountId, list] of byAccount) {
    if (deps.now() >= input.deadline) return { kind: 'deadline' };
    const lookup = await deps.teamsOf(accountId);
    if (!lookup.ok) {
      if (lookup.rateLimited) return { kind: 'rate_limited' };
      failed += 1;
      continue;
    }
    const earliest = list.reduce<string | null>((acc, t) => (msOf(t.at) === null ? acc : minIso(acc, t.at)), null);
    const latest = list.reduce<string | null>((acc, t) => maxIso(acc, t.at), null);
    const buckets = lookup.teams.length === 0 ? [noTeam] : lookup.teams.map((t) => {
      const id = teamUuid(t.id);
      const existing = teams.get(id) ?? { id, name: t.name || null, roles: new Set<TouchRole>(), accounts: new Set<string>(), at: null, last: null };
      teams.set(id, existing);
      return existing;
    });
    for (const b of buckets) {
      b.accounts.add(accountId);
      for (const t of list) b.roles.add(t.role);
      b.at = minIso(b.at, earliest);
      b.last = maxIso(b.last, latest);
    }
    if (lookup.teams.some((t) => teamUuid(t.id) === responder)) {
      for (const t of list) {
        const ms = msOf(t.at);
        // No timestamp (or no valid incident start) → "time unknown", never an error.
        if (ms === null || (startMs === null && !input.simulated)) responderUnknownTime = true;
        else if (input.simulated || ms < (startMs ?? 0)) {
          responderBefore = true;
          responderBeforeAt = minIso(responderBeforeAt, t.at);
        }
      }
    }
  }
  if (byAccount.size > 0 && failed === byAccount.size) return { kind: 'path', path: pathOf(s, input, 'unknown') };

  const reached = responderBefore || responderUnknownTime;
  const terms = input.relatedTerms ?? [];
  const ranked = [...teams.values()]
    .filter((t) => t.id !== responder)
    .sort(
      (a, b) =>
        Number(relatedName(b.name ?? '', terms)) - Number(relatedName(a.name ?? '', terms)) ||
        b.accounts.size - a.accounts.size ||
        (a.name ?? '').localeCompare(b.name ?? '') ||
        (a.id ?? '').localeCompare(b.id ?? ''),
    );
  const toStep = (t: TeamTouch, at: string | null = t.at): ReachStep => ({
    role: [...t.roles].sort((x, y) => ROLE_ORDER[x] - ROLE_ORDER[y]).join(', '),
    teamId: t.id,
    teamName: t.name,
    at: dayOf(at),
  });
  const steps = ranked.slice(0, MAX_STEPS).map((t) => toStep(t));
  // People in no team: neither roles nor time, so a lone person's activity is not described.
  if (noTeam.accounts.size > 0) steps.push({ role: '', teamId: null, teamName: null, at: null });
  const responderTouch = teams.get(responder);
  if (responderTouch) steps.push(toStep(responderTouch, reached ? (responderBefore ? responderBeforeAt : null) : responderTouch.at));

  // Stop point: the team that touched the artifact last (unknown times count as oldest); ties keep the ranking.
  const top = ranked.reduce<TeamTouch | undefined>((best, t) => {
    if (!best) return t;
    return (msOf(t.last) ?? -Infinity) > (msOf(best.last) ?? -Infinity) ? t : best;
  }, undefined);
  const stopPoint: ReachStopPoint | null = reached ? null : { teamId: top?.id ?? null, teamName: top?.name ?? null, missingLinks: 1 };
  return {
    kind: 'path',
    path: pathOf(s, input, 'ok', { reached, hopCount: teams.size, steps, stopPoint }),
  };
}

/**
 * Traces up to `maxSignals` signals until the deadline; a 429 stops the run (rest `pending`). Signals without a known
 * path (`alreadyOk`) go first, earliest first, so "Trace remaining" always moves forward.
 */
export async function traceReach(input: TraceInput, deps: TraceDeps): Promise<TraceResult> {
  const max = input.maxSignals ?? MAX_TRACE_SIGNALS;
  const done = input.alreadyOk ?? new Set<string>();
  const ordered = [...input.signals].sort(
    (a, b) => Number(done.has(a.signalId)) - Number(done.has(b.signalId)) || b.daysBefore - a.daysBefore || a.signalId.localeCompare(b.signalId),
  );
  const paths: ReachPathInput[] = [];
  let rateLimited = false;
  let traced = 0;
  for (const [i, s] of ordered.entries()) {
    if (rateLimited || i >= max || deps.now() >= input.deadline) {
      paths.push(pathOf(s, input, 'pending'));
      continue;
    }
    const outcome = await traceOne(s, input, deps);
    if (outcome.kind !== 'path') {
      if (outcome.kind === 'rate_limited') rateLimited = true;
      paths.push(pathOf(s, input, 'pending'));
      continue;
    }
    traced += 1;
    paths.push(outcome.path);
  }
  return {
    paths,
    partial: paths.some((p) => p.graphState === 'pending'),
    rateLimited,
    traced,
    reached: paths.filter((p) => p.reached === true).length,
  };
}

// --- Metrics ---------------------------------------------------------------------------------------

export interface MetricSignal {
  id: string;
  status: string;
  daysBefore: number;
}

export interface ReachMetrics {
  confirmed: number;
  /** Days before the incident of the earliest confirmed signal. */
  firstSignalDays: number;
  /** first − (latest-reaching signal's days before); equals first when nothing reached the responder team. */
  awarenessGapDays: number;
  reached: number;
  /** Confirmed signals with a known graph (`ok`): the denominator of reach. */
  considered: number;
  /** Confirmed signals without a usable trace (unknown, pending or not traced yet). */
  unknown: number;
  pending: number;
  /** Reached signals whose responder touch had no timestamp. */
  timeUnknown: number;
  /** Most frequent stop point of the signals that did not reach the responder team. */
  stopPoint: { teamName: string | null; missingLinks: number; signals: number } | null;
}

type PathLike = Pick<ReachPath, 'signalId' | 'reached' | 'graphState' | 'steps' | 'stopPoint' | 'responderTeamId'>;

/** True when a reached path's responder touch has no timestamp ("time unknown"). */
export function reachedWithUnknownTime(p: PathLike): boolean {
  if (p.reached !== true || !p.responderTeamId) return false;
  const responder = teamUuid(p.responderTeamId);
  const step = p.steps.find((s) => s.teamId !== null && teamUuid(s.teamId) === responder);
  return step !== undefined && step.at === null;
}

/** Metrics over confirmed signals only; null when nothing is confirmed ("Confirm a signal to compute reach"). */
export function computeMetrics(signals: readonly MetricSignal[], paths: readonly PathLike[]): ReachMetrics | null {
  const confirmed = signals.filter((s) => s.status === 'confirmed');
  if (confirmed.length === 0) return null;
  const bySignal = new Map(paths.map((p) => [p.signalId, p]));
  const known = confirmed.filter((s) => bySignal.get(s.id)?.graphState === 'ok');
  const reached = known.filter((s) => bySignal.get(s.id)?.reached === true);
  const first = Math.max(...confirmed.map((s) => s.daysBefore));
  const latestReached = reached.length > 0 ? Math.max(...reached.map((s) => s.daysBefore)) : null;
  const stops = new Map<string, { teamName: string | null; missingLinks: number; signals: number }>();
  for (const s of known) {
    const p = bySignal.get(s.id);
    if (!p || p.reached === true || !p.stopPoint) continue;
    const key = p.stopPoint.teamId ?? '';
    const prev = stops.get(key);
    stops.set(key, { teamName: p.stopPoint.teamName, missingLinks: p.stopPoint.missingLinks, signals: (prev?.signals ?? 0) + 1 });
  }
  const stopPoint = [...stops.values()].sort((a, b) => b.signals - a.signals || (a.teamName ?? '~').localeCompare(b.teamName ?? '~'))[0] ?? null;
  return {
    confirmed: confirmed.length,
    firstSignalDays: first,
    awarenessGapDays: latestReached === null ? first : first - latestReached,
    reached: reached.length,
    considered: known.length,
    unknown: confirmed.length - known.length,
    pending: confirmed.filter((s) => bySignal.get(s.id)?.graphState === 'pending').length,
    timeUnknown: reached.filter((s) => {
      const p = bySignal.get(s.id);
      return p !== undefined && reachedWithUnknownTime(p);
    }).length,
    stopPoint,
  };
}

/** "Stopped at Arkana Platform · 1 missing link to Arkana Payments" (or "no team" when nobody in a team touched it). */
export function stopPointCopy(stop: { teamName: string | null; missingLinks: number }, responderName: string): string {
  const links = `${stop.missingLinks} missing link${stop.missingLinks === 1 ? '' : 's'}`;
  return `Stopped at ${stop.teamName ?? 'no team'} · ${links} to ${responderName}`;
}
