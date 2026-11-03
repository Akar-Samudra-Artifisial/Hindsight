/** Reach / routes data as returned by `getAnalysis` (`reach`) and `traceReach`; team names only, never people. */

export interface ReachStep {
  role: string;
  teamId: string | null;
  teamName: string | null;
  at: string | null;
}

export interface StopPoint {
  teamId: string | null;
  teamName: string | null;
  missingLinks: number;
}

export interface PathView {
  signalId: string;
  reached: boolean | null;
  graphState: 'ok' | 'unknown' | 'pending';
  timeUnknown: boolean;
  hopCount: number;
  steps: ReachStep[];
  stopPoint: StopPoint | null;
  computedAt: string;
}

export interface RouteView {
  routeId: string;
  rank: number;
  sourceType: 'confluence_space' | 'jira_project' | 'jira_component' | 'jira_label';
  sourceKey: string;
  estimatedDaysSaved: number;
  maxDaysBefore: number;
  reason: string;
  status: 'proposed' | 'active' | 'paused' | 'dismissed';
  keywords: string[];
  signalIds: string[];
  activatedAt: string | null;
}

export interface ReachMetrics {
  confirmed: number;
  firstSignalDays: number;
  awarenessGapDays: number;
  reached: number;
  considered: number;
  unknown: number;
  pending: number;
  timeUnknown: number;
  stopPoint: { teamName: string | null; missingLinks: number; signals: number } | null;
}

export interface ReachView {
  graphAvailable: boolean;
  reason: 'no_responder_team' | 'no_site_id' | null;
  responderTeamName: string | null;
  responderTeamId: string | null;
  simulated: boolean;
  metrics: ReachMetrics | null;
  paths: PathView[];
  routes: RouteView[];
  routesNote: 'none_needed' | 'no_graph' | 'no_source' | null;
}

/** A Sentinel alert as returned by `getSentinelAlerts` / `alertFeedback`; title/url are null when not viewable. */
export interface AlertView {
  alertId: string;
  routeId: string;
  status: 'posted' | 'skipped' | 'failed';
  reason: string | null;
  source: string;
  artifactKind: string;
  title: string | null;
  url: string | null;
  matchedKeywords: string[];
  teamName: string | null;
  feedback: 'useful' | 'not_useful' | null;
  createdAt: string;
}

export type AlertsByRoute = Record<string, { postedCount: number; last: AlertView }>;

const SOURCE_LABEL: Record<RouteView['sourceType'], string> = {
  confluence_space: 'Confluence space',
  jira_project: 'Jira project',
  jira_component: 'Jira component',
  jira_label: 'Jira label',
};

export const sourceLabel = (type: RouteView['sourceType'], key: string) => `${SOURCE_LABEL[type]} ${key}`;

export function daysSavedCopy(estimated: number, upTo: number): string {
  const d = Math.round(estimated);
  return `~${d} day${d === 1 ? '' : 's'} earlier (up to ${upTo})`;
}

export function stopCopy(stop: { teamName: string | null; missingLinks: number }, responder: string): string {
  return `Stopped at ${stop.teamName ?? 'no team'} · ${stop.missingLinks} missing link${stop.missingLinks === 1 ? '' : 's'} to ${responder}`;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
