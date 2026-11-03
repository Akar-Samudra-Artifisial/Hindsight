import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestTeamworkGraph = vi.fn();
const setObjects = vi.fn();
vi.mock('@forge/api', () => ({ default: { asUser: () => ({ requestTeamworkGraph }), asApp: () => ({}) }, route: () => '' }));
vi.mock('@forge/teamwork-graph', () => ({ graph: { setObjects } }));

const { cloudIdFromInstallContext, readSpike, runGraphQuery, SPIKE_OBJECT_ID, spikeDocument, summariseWrite, writeDossier, writeObjects } = await import(
  '../src/adapters/teamworkGraph'
);
const { parseConnectionChange } = await import('../src/surfaces/background');

const CLOUD = '0f3a1b2c-1111-2222-3333-444455556666';
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  requestTeamworkGraph.mockReset();
  setObjects.mockReset();
});

describe('runGraphQuery', () => {
  it('sends the site query context and returns data', async () => {
    requestTeamworkGraph.mockResolvedValue(reply(200, { data: { atlassianUserInTeams: { edges: [] } } }));
    const r = await runGraphQuery(CLOUD, 'query x { y }', { a: 1 }, 'hindsight_x');
    expect(r).toEqual({ ok: true, status: 200, data: { atlassianUserInTeams: { edges: [] } } });
    expect(requestTeamworkGraph).toHaveBeenCalledWith('query x { y }', { a: 1 }, 'hindsight_x', undefined, {
      'X-Query-Context': `ari:cloud:platform::site/${CLOUD}`,
    });
  });
  it('treats data: null as a failure with the first GraphQL error', async () => {
    requestTeamworkGraph.mockResolvedValue(reply(200, { data: null, errors: [{ message: 'Field not found' }] }));
    expect(await runGraphQuery(CLOUD, 'q', {}, 'op')).toEqual({ ok: false, status: 200, error: 'Field not found' });
  });
  it('reports a non-2xx status', async () => {
    requestTeamworkGraph.mockResolvedValue(reply(403, {}));
    expect(await runGraphQuery(CLOUD, 'q', {}, 'op')).toEqual({ ok: false, status: 403, error: 'HTTP 403' });
  });
  it('never throws', async () => {
    requestTeamworkGraph.mockRejectedValue(new Error('network down'));
    expect(await runGraphQuery(CLOUD, 'q', {}, 'op')).toEqual({ ok: false, status: 0, error: 'network down' });
  });
});

describe('readSpike', () => {
  it('queries teams and work items for the user ARI', async () => {
    requestTeamworkGraph.mockResolvedValue(reply(200, { data: {} }));
    const r = await readSpike(CLOUD, 'acc-1');
    expect(r.cloudId).toBe(CLOUD);
    expect(requestTeamworkGraph).toHaveBeenCalledTimes(2);
    const ops = requestTeamworkGraph.mock.calls.map((c) => [c[1], c[2]]);
    expect(ops).toEqual([
      [{ userId: 'ari:cloud:identity::user/acc-1' }, 'hindsight_userTeams'],
      [{ userId: 'ari:cloud:identity::user/acc-1' }, 'hindsight_userWorkItems'],
    ]);
  });
});

describe('cloudIdFromInstallContext', () => {
  it('parses a site ARI', () => {
    expect(cloudIdFromInstallContext(`ari:cloud:jira::site/${CLOUD}`)).toBe(CLOUD);
    expect(cloudIdFromInstallContext('nonsense')).toBeUndefined();
  });
});

describe('spikeDocument', () => {
  it('builds a stable atlassian:document visible to everyone', () => {
    const now = new Date('2026-11-03T10:00:00.000Z');
    const doc = spikeDocument('https://example.atlassian.net/', now);
    expect(doc).toMatchObject({
      schemaVersion: '1.0',
      id: SPIKE_OBJECT_ID,
      updateSequenceNumber: now.getTime(),
      displayName: 'Hindsight spike signal',
      url: 'https://example.atlassian.net/jira',
      createdAt: '2026-11-03T10:00:00.000Z',
      lastUpdatedAt: '2026-11-03T10:00:00.000Z',
      permissions: [{ accessControls: [{ principals: [{ type: 'EVERYONE' }] }] }],
    });
    expect(doc['atlassian:document'].type.category).toBe('DOCUMENT');
    expect(doc['atlassian:document'].content.mimeType).toBe('text/plain');
  });
});

describe('writeObjects', () => {
  it('counts accepted and rejected objects', async () => {
    setObjects.mockResolvedValue({ success: true, results: { accepted: [{ entityType: 'atlassian:document', entityId: { id: 'x' } }], rejected: [] } });
    const doc = spikeDocument('https://example.atlassian.net', new Date(0));
    const r = await writeObjects('conn-1', [doc]);
    expect(setObjects).toHaveBeenCalledWith({ objects: [doc], connectionId: 'conn-1' });
    expect(r).toMatchObject({ success: true, accepted: 1, rejected: 0 });
  });
  it('returns the error instead of throwing', async () => {
    setObjects.mockRejectedValue(new Error('validation failed'));
    expect(await writeObjects('conn-1', [])).toEqual({ success: false, accepted: 0, rejected: 0, error: 'validation failed' });
  });
  it('summarises a failed response', () => {
    expect(summariseWrite({ success: false, error: 'forbidden' })).toEqual({ success: false, accepted: 0, rejected: 0, error: 'forbidden' });
  });
});

describe('parseConnectionChange', () => {
  it('reads action and connectionId from the request', () => {
    expect(parseConnectionChange({ action: 'CREATED', connectionId: 'c-1', configProperties: {} })).toEqual({ action: 'CREATED', connectionId: 'c-1' });
    expect(parseConnectionChange({ action: 'deleted', connectionId: 'c-1' })).toEqual({ action: 'DELETED', connectionId: 'c-1' });
  });
  it('reads the connection name and connector config names, ignoring non-strings', () => {
    expect(
      parseConnectionChange({ action: 'UPDATED', connectionId: 'c-1', name: 'Signals', configProperties: { connectorName: 'hs', flowName: 7 } }),
    ).toEqual({ action: 'UPDATED', connectionId: 'c-1', name: 'Signals', connectorName: 'hs' });
  });
  it.each([undefined, {}, { action: 'CREATED' }, { action: 'OTHER', connectionId: 'c' }, { action: 'CREATED', connectionId: '' }])('rejects %o', (e) => {
    expect(parseConnectionChange(e)).toBeUndefined();
  });
});

describe('writeDossier', () => {
  it('writes the one document for the connection and summarises the result', async () => {
    setObjects.mockResolvedValue({ success: true, results: { accepted: [{ id: 'dossier-inc-1' }], rejected: [] } });
    const doc = spikeDocument('https://x.atlassian.net', new Date('2026-11-03T10:00:00Z'));
    const r = await writeDossier('conn-1', doc);
    expect(setObjects).toHaveBeenCalledWith({ objects: [doc], connectionId: 'conn-1' });
    expect(r).toMatchObject({ success: true, accepted: 1, rejected: 0 });
  });
  it('never throws', async () => {
    setObjects.mockRejectedValue(new Error('preview down'));
    expect(await writeDossier('conn-1', spikeDocument('https://x', new Date()))).toMatchObject({ success: false, error: 'preview down' });
  });
});
