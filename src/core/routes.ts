import type { ReachPath, RouteInput, RouteSourceType } from '../adapters/repo';

/**
 * Routes (pure, deterministic, no LLM). For every confirmed signal that did not reach the responder team, propose
 * "mention the responder team when a matching item appears in this source". Sources are deduplicated per
 * (type, key). Days saved are counterfactual: baseline = latest-reaching signal (else 0), gain = max(0, daysBefore −
 * baseline) × confidence; a route keeps its best gain.
 */

export interface RouteSignal {
  signalId: string;
  daysBefore: number;
  confidence: number;
  source: string;
  projectKey: string | null;
  spaceKey: string | null;
  componentNames: readonly string[];
  labels: readonly string[];
  keywords: readonly string[];
}

export interface ProposeInput {
  incidentKey: string;
  responderTeamId: string;
  responderTeamName: string;
  /** Confirmed signals only. */
  signals: readonly RouteSignal[];
  paths: readonly Pick<ReachPath, 'signalId' | 'reached' | 'graphState' | 'stopPoint'>[];
  /** Share of incidents the source would have covered; 1 until cross-incident data exists. */
  coverage?: number;
}

export const MAX_ROUTE_KEYWORDS = 8;

export function routeSource(s: RouteSignal): { sourceType: RouteSourceType; sourceKey: string } | null {
  if (s.source === 'confluence') return s.spaceKey ? { sourceType: 'confluence_space', sourceKey: s.spaceKey } : null;
  if (s.projectKey) return { sourceType: 'jira_project', sourceKey: s.projectKey };
  if (s.componentNames[0]) return { sourceType: 'jira_component', sourceKey: s.componentNames[0] };
  if (s.labels[0]) return { sourceType: 'jira_label', sourceKey: s.labels[0] };
  return null;
}

const SOURCE_LABEL: Record<RouteSourceType, string> = {
  confluence_space: 'Confluence space',
  jira_project: 'Jira project',
  jira_component: 'Jira component',
  jira_label: 'Jira label',
};

export const sourceLabel = (type: RouteSourceType, key: string): string => `${SOURCE_LABEL[type]} ${key}`;
export const sourceTypeLabel = (type: RouteSourceType): string => SOURCE_LABEL[type];

const round1 = (n: number): number => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function proposeRoutes(input: ProposeInput): RouteInput[] {
  // Only signals with a known graph count: an unknown or pending trace neither proposes a route nor sets the baseline.
  const paths = new Map(input.paths.filter((p) => p.graphState === 'ok').map((p) => [p.signalId, p]));
  const reachedDays = input.signals.filter((s) => paths.get(s.signalId)?.reached === true).map((s) => s.daysBefore);
  const baseline = reachedDays.length > 0 ? Math.max(...reachedDays) : 0;
  const coverage = input.coverage ?? 1;

  interface Group {
    sourceType: RouteSourceType;
    sourceKey: string;
    gain: number;
    best: RouteSignal;
    maxDaysBefore: number;
    signalIds: string[];
    keywords: Set<string>;
  }
  const groups = new Map<string, Group>();
  for (const s of input.signals) {
    const path = paths.get(s.signalId);
    if (!path || path.reached === true) continue;
    const src = routeSource(s);
    if (!src) continue;
    const gain = Math.max(0, s.daysBefore - baseline) * Math.min(1, Math.max(0, s.confidence));
    const key = `${src.sourceType}|${src.sourceKey}`;
    const g = groups.get(key) ?? { ...src, gain: -1, best: s, maxDaysBefore: 0, signalIds: [], keywords: new Set<string>() };
    if (gain > g.gain) {
      g.gain = gain;
      g.best = s;
    }
    g.maxDaysBefore = Math.max(g.maxDaysBefore, s.daysBefore);
    g.signalIds.push(s.signalId);
    for (const k of s.keywords) if (g.keywords.size < MAX_ROUTE_KEYWORDS) g.keywords.add(k.toLowerCase());
    groups.set(key, g);
  }

  const routes = [...groups.values()].map((g) => {
    const estimated = round1(g.gain);
    const stop = paths.get(g.best.signalId)?.stopPoint;
    const where = stop ? `stopped at ${stop.teamName ?? 'no team'}` : 'was never traced to a team';
    return {
      originIncidentKey: input.incidentKey,
      sourceType: g.sourceType,
      sourceKey: g.sourceKey,
      spec: { keywords: [...g.keywords], target: { teamId: input.responderTeamId, action: 'mention' as const } },
      reason: `${plural(g.signalIds.length, 'confirmed signal', 'confirmed signals')} in ${sourceLabel(g.sourceType, g.sourceKey)}, the earliest ${plural(g.maxDaysBefore, 'day', 'days')} before the incident, ${where} and did not reach ${input.responderTeamName}.`,
      estimatedDaysSaved: estimated,
      maxDaysBefore: g.maxDaysBefore,
      signalIds: g.signalIds,
      score: Math.round(estimated * coverage * 100) / 100,
      rankNo: 0,
    };
  });
  routes.sort((a, b) => b.score - a.score || b.maxDaysBefore - a.maxDaysBefore || `${a.sourceType}|${a.sourceKey}`.localeCompare(`${b.sourceType}|${b.sourceKey}`));
  return routes.map((r, i) => ({ ...r, rankNo: i + 1 }));
}

/** "~11 days earlier (up to 12)". */
export function daysSavedCopy(estimated: number, maxDaysBefore: number): string {
  return `~${Math.round(estimated)} day${Math.round(estimated) === 1 ? '' : 's'} earlier (up to ${maxDaysBefore})`;
}

export const ROUTE_ASSUMPTION = 'assumes the mention is read and acted on';
