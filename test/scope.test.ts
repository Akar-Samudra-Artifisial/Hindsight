import { describe, expect, it } from 'vitest';
import { buildScope, eventServiceKey, parseScope, type ScopeIncident, type ScopeMapping } from '../src/core/scope';

const payments: ScopeMapping = {
  serviceKey: 'payments',
  jiraProjectKeys: ['PAY', 'INC'],
  jiraComponentNames: ['Checkout'],
  confluenceSpaceKeys: ['PLAT'],
  aliases: ['payment gateway'],
};
const search: ScopeMapping = { serviceKey: 'search', jiraProjectKeys: ['SRCH'], jiraComponentNames: ['Search'], confluenceSpaceKeys: ['SRCH'], aliases: [] };

const incident = (over: Partial<ScopeIncident> = {}): ScopeIncident => ({
  issueKey: 'INC-7',
  projectKey: 'INC',
  summary: 'Checkout payments failing',
  description: 'HTTP 402',
  componentNames: [],
  startedAt: '2026-11-20T10:00:00.000Z',
  scenarioStartedAt: null,
  propertyServiceKey: null,
  manualServiceKey: null,
  ...over,
});
const noExclusions = { excludedProjectKeys: [], excludedSpaceKeys: [] };

describe('buildScope', () => {
  it('resolves the service from the issue property first', () => {
    const s = buildScope(incident({ propertyServiceKey: 'payments', componentNames: ['Search'] }), [payments, search], noExclusions, 30);
    expect(s).toMatchObject({ serviceKey: 'payments', serviceSource: 'property', limited: false, jiraProjectKeys: ['INC', 'PAY'], confluenceSpaceKeys: ['PLAT'] });
    expect(s.keywords.map((k) => k.stem)).toContain('gateway');
  });

  it('then a matching component, then the manual choice', () => {
    expect(buildScope(incident({ componentNames: ['checkout'] }), [payments, search], noExclusions, 30).serviceSource).toBe('component');
    expect(buildScope(incident({ manualServiceKey: 'search' }), [payments, search], noExclusions, 30)).toMatchObject({
      serviceKey: 'search',
      serviceSource: 'manual',
    });
  });

  it('without a service the scope is limited and covers every mapping', () => {
    const s = buildScope(incident({ propertyServiceKey: 'unknown' }), [payments, search], noExclusions, 30);
    expect(s).toMatchObject({ serviceKey: null, limited: true, jiraProjectKeys: ['INC', 'PAY', 'SRCH'], confluenceSpaceKeys: ['PLAT', 'SRCH'] });
  });

  it('honours exclusions', () => {
    const s = buildScope(incident(), [payments, search], { excludedProjectKeys: ['pay', 'INC'], excludedSpaceKeys: ['SRCH'] }, 30);
    expect(s.jiraProjectKeys).toEqual(['SRCH']);
    expect(s.confluenceSpaceKeys).toEqual(['PLAT']);
  });

  it('uses real time for queries and scenario time for the window', () => {
    const s = buildScope(incident({ scenarioStartedAt: '2026-11-01T00:00:00.000Z' }), [payments], noExclusions, 30);
    expect(s.queryFrom).toBe('2026-10-20T10:00:00.000Z');
    expect(s.queryTo).toBe('2026-11-21T10:00:00.000Z');
    expect(s.windowFrom).toBe('2026-10-02T00:00:00.000Z');
    expect(s.windowTo).toBe('2026-11-01T00:00:00.000Z');
  });

  it('round-trips through parseScope (JSON)', () => {
    const s = buildScope(incident({ componentNames: ['Checkout'] }), [payments, search], noExclusions, 14);
    expect(parseScope(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(() => parseScope({})).toThrow('missing');
  });
});

describe('eventServiceKey', () => {
  const services = buildScope(incident(), [payments, search], noExclusions, 30).services;
  it('prefers a mapped component, then an unambiguous project or space', () => {
    expect(eventServiceKey(services, { projectKey: 'SRCH', componentNames: ['Checkout'] })).toBe('payments');
    expect(eventServiceKey(services, { projectKey: 'pay' })).toBe('payments');
    expect(eventServiceKey(services, { spaceKey: 'SRCH' })).toBe('search');
    expect(eventServiceKey(services, { projectKey: 'OTHER' })).toBeNull();
  });
});
