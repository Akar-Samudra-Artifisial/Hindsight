import { describe, expect, it } from 'vitest';
import { lockName, type Route } from '../src/adapters/repo';
import {
  alertGate,
  buildAlertComment,
  DEFAULT_DAILY_CAP,
  DEFAULT_WEEKLY_CAP,
  isSelfArtifact,
  matchedKeywords,
  matchRoutes,
  MAX_FAILED_POSTS,
  NOT_INDEXED_DELAYS_SECONDS,
  noticeText,
  notIndexedDelay,
  sentinelChainLock,
  parseDailyCap,
  parseSentinelBody,
  parseWeeklyCap,
  parseWorkEvent,
  prefilter,
  routeMatchesSource,
  sentinelBody,
  sentinelLock,
  SENTINEL_MARKER,
  type ArtifactPlace,
} from '../src/core/sentinel';
import { adfToText } from '../src/core/text';

const route = (over: Partial<Route> = {}): Route => ({
  id: 'ro1',
  originIncidentKey: 'INC-60',
  sourceType: 'confluence_space',
  sourceKey: 'PLAT',
  spec: { keywords: ['gateway', 'tls certificate'], target: { teamId: 't-pay', action: 'mention' } },
  reason: 'r',
  estimatedDaysSaved: 11,
  maxDaysBefore: 12,
  signalIds: ['s1'],
  score: 11,
  rankNo: 1,
  status: 'active',
  activatedAt: '2026-11-03T10:00:00.000Z',
  createdAt: '2026-11-03T09:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  ...over,
});

const plat: ArtifactPlace = { source: 'confluence', projectKey: null, spaceKey: 'PLAT', componentNames: [], labels: [] };
const pay: ArtifactPlace = { source: 'jira', projectKey: 'PAY', spaceKey: null, componentNames: ['Checkout'], labels: ['vendor'] };

describe('parseWorkEvent', () => {
  it('reads a Jira issue and comment event (ids and keys only)', () => {
    const issue = { id: '10001', key: 'PAY-1', fields: { project: { key: 'PAY' } } };
    expect(parseWorkEvent({ eventType: 'avi:jira:created:issue', issue, atlassianId: 'acc-1' })).toEqual({
      source: 'jira',
      kind: 'issue',
      artifactId: '10001',
      commentId: '',
      eventType: 'avi:jira:created:issue',
      projectKey: 'PAY',
      spaceKey: null,
      actorId: 'acc-1',
      selfGenerated: false,
    });
    expect(parseWorkEvent({ eventType: 'avi:jira:commented:issue', issue, comment: { id: '200', body: 'x' }, selfGenerated: true })).toMatchObject({
      kind: 'comment',
      artifactId: '10001',
      commentId: '200',
      selfGenerated: true,
    });
  });

  it('reads Confluence page and comment events; a comment page is resolved later', () => {
    expect(parseWorkEvent({ eventType: 'avi:confluence:created:page', content: { id: '900', space: { key: 'PLAT' } } })).toMatchObject({
      source: 'confluence',
      kind: 'page',
      artifactId: '900',
      spaceKey: 'PLAT',
    });
    expect(parseWorkEvent({ eventType: 'avi:confluence:created:comment', content: { id: 901, space: { key: 'PLAT' } } })).toMatchObject({
      kind: 'comment',
      artifactId: '',
      commentId: '901',
    });
  });

  it('ignores other events and payloads without ids', () => {
    expect(parseWorkEvent({ eventType: 'avi:jira:deleted:issue', issue: { id: '1' } })).toBeUndefined();
    expect(parseWorkEvent({ eventType: 'avi:jira:created:issue', issue: { id: 'abc' } })).toBeUndefined();
    expect(parseWorkEvent({ eventType: 'avi:jira:commented:issue', issue: { id: '1' } })).toBeUndefined();
    expect(parseWorkEvent(undefined)).toBeUndefined();
  });
});

describe('sentinel queue body', () => {
  it('round-trips and rejects anything else', () => {
    const e = parseWorkEvent({ eventType: 'avi:confluence:created:comment', content: { id: '901' } })!;
    const body = sentinelBody(e);
    expect(parseSentinelBody(JSON.parse(JSON.stringify(body)))).toEqual({ v: 1, source: 'confluence', kind: 'comment', artifactId: '', commentId: '901', eventType: 'avi:confluence:created:comment', attempt: 1 });
    expect(() => parseSentinelBody({ ...body, v: 2 })).toThrow();
    expect(() => parseSentinelBody({ ...body, commentId: '' })).toThrow();
    expect(() => parseSentinelBody({ ...body, source: 'jira' })).toThrow(/artifactId/);
    expect(() => parseSentinelBody({ ...body, commentId: '1; DROP' })).toThrow();
    expect(sentinelLock(body)).toBe('sentinel:confluence.0.901');
    expect(sentinelChainLock(body)).toBe('sentinel-chain:confluence.0.901');
    expect(lockName(sentinelChainLock({ source: 'confluence', artifactId: '123456789012345678', commentId: '123456789012345678' }))).toBeTruthy();
  });

  it('notIndexedDelay: 60, 90, then 120 s, six re-queues in all (~10.5 min, each ≤ 900 s)', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(notIndexedDelay)).toEqual([60, 90, 120, 120, 120, 120, null]);
    expect(NOT_INDEXED_DELAYS_SECONDS.reduce((a, b) => a + b, 0)).toBe(630);
  });
});

describe('matching', () => {
  it('matches the route source: space, project, component and label', () => {
    expect(routeMatchesSource(route(), plat)).toBe(true);
    expect(routeMatchesSource(route({ sourceKey: 'OPS' }), plat)).toBe(false);
    expect(routeMatchesSource(route(), pay)).toBe(false);
    expect(routeMatchesSource(route({ sourceType: 'jira_project', sourceKey: 'PAY' }), pay)).toBe(true);
    expect(routeMatchesSource(route({ sourceType: 'jira_component', sourceKey: 'checkout' }), pay)).toBe(true);
    expect(routeMatchesSource(route({ sourceType: 'jira_label', sourceKey: 'Vendor' }), pay)).toBe(true);
  });

  it('a keyword matches when all its stems occur; one keyword is enough', () => {
    expect(matchedKeywords(['gateway', 'tls certificate'], 'The payment gateways reject old TLS certificates')).toEqual(['gateway', 'tls certificate']);
    expect(matchedKeywords(['tls certificate'], 'TLS handshake')).toEqual([]);
    expect(matchedKeywords(['the'], 'the the')).toEqual([]);
  });

  it('matchRoutes needs an active route, the same source and a keyword', () => {
    const text = 'Provider notice: gateway maintenance';
    expect(matchRoutes([route()], plat, text)).toEqual([{ route: route(), matched: ['gateway'] }]);
    expect(matchRoutes([route()], plat, 'Lunch menu')).toEqual([]);
    expect(matchRoutes([route({ sourceKey: 'OPS' })], plat, text)).toEqual([]);
    expect(matchRoutes([route({ status: 'paused' })], plat, text)).toEqual([]);
  });

  it('prefilter lets through what an active route could cover', () => {
    expect(prefilter({ source: 'confluence', projectKey: null, spaceKey: 'PLAT' }, [route()])).toBe(true);
    expect(prefilter({ source: 'confluence', projectKey: null, spaceKey: 'OPS' }, [route()])).toBe(false);
    expect(prefilter({ source: 'jira', projectKey: 'PAY', spaceKey: null }, [route()])).toBe(false);
    expect(prefilter({ source: 'jira', projectKey: 'PAY', spaceKey: null }, [route({ sourceType: 'jira_project', sourceKey: 'PAY' })])).toBe(true);
    expect(prefilter({ source: 'jira', projectKey: 'OPS', spaceKey: null }, [route({ sourceType: 'jira_label', sourceKey: 'x' })])).toBe(true);
  });
});

describe('isSelfArtifact', () => {
  it('app authors and known app accounts are self; the marker only counts without a known author', () => {
    expect(isSelfArtifact({ accountId: 'app-1', accountType: 'app' }, [], 'x')).toBe(true);
    expect(isSelfArtifact({ accountId: 'app-2', accountType: 'atlassian' }, ['app-2'], 'x')).toBe(true);
    expect(isSelfArtifact({ accountId: 'u', accountType: 'atlassian' }, ['app-2'], 'gateway notice')).toBe(false);
    expect(isSelfArtifact(null, [], 'gateway')).toBe(false);
    expect(isSelfArtifact(null, [], `${SENTINEL_MARKER} Heads-up`)).toBe(true);
  });

  it('a person typing the marker does not make their artifact self (spoof)', () => {
    expect(isSelfArtifact({ accountId: 'u', accountType: 'atlassian' }, [], `${SENTINEL_MARKER} gateway outage`)).toBe(false);
  });
});

describe('alertGate', () => {
  const NOW = Date.parse('2026-11-03T12:00:00.000Z');
  const row = (status: 'posted' | 'skipped' | 'failed', reason: string | null, minutesAgo: number) => ({ status, reason, createdAt: new Date(NOW - minutesAgo * 60_000).toISOString() });

  it('no history → go', () => {
    expect(alertGate([], NOW)).toEqual({ go: true });
  });

  it('a posted alert blocks for good (page edits never re-alert), however old', () => {
    expect(alertGate([row('posted', null, 60 * 24 * 30)], NOW)).toEqual({ go: false, reason: 'dedup' });
  });

  it('an unfinished post (failed/posting, maybe posted before a crash) counts as sent', () => {
    expect(alertGate([row('failed', 'posting', 600)], NOW)).toEqual({ go: false, reason: 'in_flight' });
  });

  it('a cap skip is not retried', () => {
    expect(alertGate([row('skipped', 'weekly_cap', 5)], NOW)).toEqual({ go: false, reason: 'already_skipped' });
  });

  it('an API error waits an hour; a rate limit does not (the queue retries it)', () => {
    expect(alertGate([row('failed', 'api_error', 30)], NOW)).toEqual({ go: false, reason: 'backoff' });
    expect(alertGate([row('failed', 'api_error', 61)], NOW)).toEqual({ go: true });
    expect(alertGate([row('failed', 'rate_limited', 1)], NOW)).toEqual({ go: true });
  });

  it(`at most ${MAX_FAILED_POSTS} failed posts per route and artifact`, () => {
    expect(alertGate([row('failed', 'api_error', 200), row('failed', 'rate_limited', 300), row('failed', 'api_error', 400)], NOW)).toEqual({ go: false, reason: 'gave_up' });
  });
});

describe('buildAlertComment', () => {
  const input = { teamName: "Arkana <Payments> & O'Neil", incidentKey: 'INC-60', incidentUrl: 'https://one.atlassian.net/browse/INC-60' };

  it('ADF: marker, bold team name and an incident link; no mention, no assignment', () => {
    const { adf, text } = buildAlertComment(input);
    const json = JSON.stringify(adf);
    expect(adfToText(adf)).toContain(SENTINEL_MARKER);
    expect(json).toContain(`{"type":"text","text":"Arkana <Payments> & O'Neil","marks":[{"type":"strong"}]}`);
    expect(json).toContain('"href":"https://one.atlassian.net/browse/INC-60"');
    expect(json).not.toContain('"mention"');
    expect(text).toContain('a past incident in this area (INC-60)');
    expect(text).toContain('No action is assigned');
    expect(text).not.toMatch(/\b(fault|blame|should have|missed by)\b/i);
  });

  it('is neutral: never repeats matched keywords or the route source', () => {
    const { text, storage } = buildAlertComment(input);
    for (const leak of [/keyword/i, /matched/i, /Confluence space/i, /Jira (project|component|label)/i, /PLAT/]) {
      expect(text).not.toMatch(leak);
      expect(storage).not.toMatch(leak);
    }
  });

  it('storage is escaped (including quotes) and the marker makes it self for an unknown author', () => {
    const { storage, text } = buildAlertComment(input);
    expect(storage).toContain('<strong>Arkana &lt;Payments&gt; &amp; O&#39;Neil</strong>');
    expect(storage).toContain('<a href="https://one.atlassian.net/browse/INC-60">INC-60</a>');
    expect(isSelfArtifact(null, [], text)).toBe(true);
  });

  it('without a site URL the incident key is plain text', () => {
    const { storage, adf } = buildAlertComment({ ...input, incidentUrl: null });
    expect(storage).not.toContain('<a ');
    expect(JSON.stringify(adf)).not.toContain('"link"');
  });
});

describe('settings and demo text', () => {
  it('parseWeeklyCap falls back to the default', () => {
    expect(parseWeeklyCap(undefined)).toBe(DEFAULT_WEEKLY_CAP);
    expect(parseWeeklyCap('7')).toBe(7);
    expect(parseWeeklyCap(0)).toBe(DEFAULT_WEEKLY_CAP);
    expect(parseWeeklyCap(2.5)).toBe(DEFAULT_WEEKLY_CAP);
  });

  it('parseDailyCap defaults to 200 and accepts up to 5000', () => {
    expect(parseDailyCap(undefined)).toBe(DEFAULT_DAILY_CAP);
    expect(DEFAULT_DAILY_CAP).toBe(200);
    expect(parseDailyCap('5000')).toBe(5000);
    expect(parseDailyCap(5001)).toBe(200);
  });

  it('noticeText is numbered and matches the route keywords', () => {
    const text = noticeText(3, ['gateway', 'tls certificate']);
    expect(text).toMatch(/^Provider notice #3: /);
    expect(matchRoutes([route()], plat, text)[0]?.matched).toEqual(['gateway', 'tls certificate']);
  });
});
