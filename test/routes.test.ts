import { describe, expect, it } from 'vitest';
import { daysSavedCopy, proposeRoutes, routeSource, type RouteSignal } from '../src/core/routes';

const PAYMENTS = '855b1079-8375-4d0d-a163-ddc96cdb696f';
const sig = (signalId: string, daysBefore: number, confidence: number, source: string, keys: { projectKey?: string; spaceKey?: string }, keywords: string[] = []): RouteSignal => ({
  signalId,
  daysBefore,
  confidence,
  source,
  projectKey: keys.projectKey ?? null,
  spaceKey: keys.spaceKey ?? null,
  componentNames: [],
  labels: [],
  keywords,
});
const DEMO = [
  sig('s1', 12, 0.92, 'confluence', { spaceKey: 'PLAT' }, ['tls', 'payment gateway']),
  sig('s2a', 6, 0.8, 'jsm', { projectKey: 'INC' }, ['payment', 'checkout']),
  sig('s2b', 6, 0.75, 'jsm', { projectKey: 'INC' }, ['checkout']),
  sig('s3', 3, 0.85, 'jira', { projectKey: 'PAY' }, ['426']),
];
const stop = { teamId: 'fa2a7a5c', teamName: 'Arkana Platform', missingLinks: 1 };
const notReached = (signalId: string) => ({ signalId, reached: false, graphState: 'ok' as const, stopPoint: stop });

describe('proposeRoutes', () => {
  it('demo → 3 routes (PLAT, INC, PAY); top ≈ 11.0 days (up to 12)', () => {
    const routes = proposeRoutes({ incidentKey: 'INC-60', responderTeamId: PAYMENTS, responderTeamName: 'Arkana Payments', signals: DEMO, paths: DEMO.map((s) => notReached(s.signalId)) });
    expect(routes.map((r) => [r.rankNo, r.sourceType, r.sourceKey, r.estimatedDaysSaved, r.maxDaysBefore])).toEqual([
      [1, 'confluence_space', 'PLAT', 11, 12],
      [2, 'jira_project', 'INC', 4.8, 6],
      [3, 'jira_project', 'PAY', 2.6, 3],
    ]);
    expect(routes[1]!.signalIds).toEqual(['s2a', 's2b']);
    expect(routes[1]!.spec).toEqual({ keywords: ['payment', 'checkout'], target: { teamId: PAYMENTS, action: 'mention' } });
    expect(routes[0]!.reason).toBe('1 confirmed signal in Confluence space PLAT, the earliest 12 days before the incident, stopped at Arkana Platform and did not reach Arkana Payments.');
    expect(daysSavedCopy(routes[0]!.estimatedDaysSaved, routes[0]!.maxDaysBefore)).toBe('~11 days earlier (up to 12)');
  });

  it('the baseline is the latest-reaching signal; reached signals get no route', () => {
    const paths = [notReached('s1'), { signalId: 's2a', reached: true, graphState: 'ok' as const, stopPoint: null }, notReached('s2b'), notReached('s3')];
    const routes = proposeRoutes({ incidentKey: 'INC-60', responderTeamId: PAYMENTS, responderTeamName: 'Arkana Payments', signals: DEMO, paths });
    // baseline 6: S1 (12−6)×0.92 = 5.5; INC only s2b (6−6)=0; PAY max(0, 3−6)=0.
    expect(routes.map((r) => [r.sourceKey, r.estimatedDaysSaved, r.signalIds])).toEqual([
      ['PLAT', 5.5, ['s1']],
      ['INC', 0, ['s2b']],
      ['PAY', 0, ['s3']],
    ]);
  });

  it('nothing to route when every signal reached; sources fall back to component and label', () => {
    expect(proposeRoutes({ incidentKey: 'INC-1', responderTeamId: PAYMENTS, responderTeamName: 'P', signals: DEMO.slice(0, 1), paths: [{ signalId: 's1', reached: true, graphState: 'ok', stopPoint: null }] })).toEqual([]);
    expect(routeSource({ ...DEMO[1]!, projectKey: null, componentNames: ['Checkout'] })).toEqual({ sourceType: 'jira_component', sourceKey: 'Checkout' });
    expect(routeSource({ ...DEMO[1]!, projectKey: null, labels: ['tls'] })).toEqual({ sourceType: 'jira_label', sourceKey: 'tls' });
    expect(routeSource({ ...DEMO[0]!, spaceKey: null })).toBeNull();
  });
});
