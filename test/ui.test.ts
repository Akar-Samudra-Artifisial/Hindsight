import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: { payload: Record<string, unknown>; context: Record<string, unknown> }) => Promise<unknown>;
const defs = vi.hoisted(() => new Map<string, Handler>());
vi.mock('@forge/resolver', () => ({
  default: class {
    define(name: string, fn: Handler) {
      defs.set(name, fn);
    }
    getDefinitions() {
      return defs;
    }
  },
}));
const queue = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@forge/events', () => ({
  Queue: class {
    constructor(readonly opts: { key: string }) {}
    push(payload: unknown) {
      return queue.push(this.opts.key, payload);
    }
  },
}));
vi.mock('../src/adapters/sql', () => ({ ensureSchema: vi.fn(async () => undefined) }));
const repoMock = vi.hoisted(() => ({
  listServiceMappings: vi.fn(),
  upsertServiceMapping: vi.fn(),
  deleteServiceMapping: vi.fn(),
  listDemoArtifacts: vi.fn(),
  getLatestCollectedJobForIncident: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  acquireAppLock: vi.fn(),
  releaseAppLock: vi.fn(),
}));
vi.mock('../src/adapters/repo', () => ({ repo: repoMock }));
const jiraMock = vi.hoisted(() => ({ isAdminAsUser: vi.fn() }));
vi.mock('../src/adapters/jira', () => ({ jira: jiraMock }));
vi.mock('../src/adapters/confluence', () => ({ confluence: {} }));

await import('../src/surfaces/ui');

const setup = { moduleKey: 'hindsight-setup', accountId: 'acc-1' };
const call = (name: string, payload: Record<string, unknown> = {}, context: Record<string, unknown> = setup) => defs.get(name)!({ payload, context });
const mapping = { serviceKey: 'checkout', displayName: 'Checkout', jiraProjectKeys: ['PAY'], confluenceSpaceKeys: [], jiraComponentNames: [], aliases: [] };

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  jiraMock.isAdminAsUser.mockReset().mockResolvedValue(true);
  repoMock.listServiceMappings.mockReset().mockResolvedValue([]);
  repoMock.upsertServiceMapping.mockReset().mockResolvedValue('id');
  repoMock.deleteServiceMapping.mockReset().mockResolvedValue(1);
  repoMock.listDemoArtifacts.mockReset().mockResolvedValue([{ slot: 'incident', artifactKey: 'INC-1' }]);
  repoMock.getLatestCollectedJobForIncident.mockReset().mockResolvedValue({ id: 'job-1' });
  repoMock.getSetting.mockReset().mockResolvedValue(undefined);
  repoMock.setSetting.mockReset().mockResolvedValue(undefined);
  repoMock.acquireAppLock.mockReset().mockResolvedValue(true);
  repoMock.releaseAppLock.mockReset().mockResolvedValue(undefined);
  queue.push.mockReset().mockResolvedValue({ jobId: 'q' });
});

describe('setup resolvers', () => {
  const mutations: [string, Record<string, unknown>][] = [
    ['saveServiceMapping', { mapping }],
    ['deleteServiceMapping', { serviceKey: 'checkout' }],
    ['startDemoJob', { kind: 'load' }],
    ['writeTestDossier', {}],
  ];

  it.each(mutations)('%s refuses calls from another module', async (name, payload) => {
    expect(await call(name, payload, { moduleKey: 'hindsight-incident', accountId: 'acc-1' })).toEqual({ error: `${name} is only available on Hindsight setup.` });
    expect(jiraMock.isAdminAsUser).not.toHaveBeenCalled();
  });

  it.each(mutations)('%s refuses non-admins', async (name, payload) => {
    jiraMock.isAdminAsUser.mockResolvedValue(false);
    expect(await call(name, payload)).toEqual({ error: 'Only Jira administrators can change Hindsight setup.' });
    expect(repoMock.upsertServiceMapping).not.toHaveBeenCalled();
    expect(queue.push).not.toHaveBeenCalled();
  });

  it('saveServiceMapping validates input and enforces the mapping limit', async () => {
    expect(await call('saveServiceMapping', { mapping: { ...mapping, jiraProjectKeys: ['bad key'] } })).toEqual({ error: '"BAD KEY" is not a Jira project key.' });
    repoMock.listServiceMappings.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ serviceKey: `s${i}` })));
    expect(await call('saveServiceMapping', { mapping })).toEqual({ error: 'Hindsight supports at most 50 service mappings.' });
    repoMock.listServiceMappings.mockResolvedValue([]);
    expect(await call('saveServiceMapping', { mapping })).toMatchObject({ ready: true });
    expect(repoMock.upsertServiceMapping).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: 'checkout' }));
  });

  it('startDemoJob queues the job on demo-seed', async () => {
    expect(await call('startDemoJob', { kind: 'load' })).toMatchObject({ ready: true, started: true, job: { kind: 'load', status: 'queued' } });
    expect(queue.push).toHaveBeenCalledWith('demo-seed', { body: { jobId: expect.any(String), attempt: 1 } });
    expect(await call('startDemoJob', { kind: 'nope' })).toEqual({ error: 'kind must be load, reset or remove.' });
  });

  it('writeTestDossier only queues score for the demo incident (the consumer writes)', async () => {
    expect(await call('writeTestDossier')).toEqual({ ready: true, queued: true, incidentKey: 'INC-1' });
    expect(queue.push).toHaveBeenCalledWith('score', { body: { jobId: 'job-1' } });
    expect(repoMock.getLatestCollectedJobForIncident).toHaveBeenCalledWith('INC-1');
    repoMock.getLatestCollectedJobForIncident.mockResolvedValue(undefined);
    expect(await call('writeTestDossier')).toEqual({ error: 'No finished analysis of INC-1 yet. Open INC-1, click Analyze and wait until the candidates appear.' });
  });
});

describe('getDemoJob', () => {
  it('returns reuse warnings for existing containers', async () => {
    repoMock.listDemoArtifacts.mockResolvedValue([
      { slot: 'incident', artifactKey: 'INC-1', createdByApp: true },
      { slot: 'container:project-PAY', artifactKey: 'PAY', createdByApp: false },
    ]);
    expect(await call('getDemoJob')).toMatchObject({
      incidentKey: 'INC-1',
      warnings: ['Using existing project PAY; demo issues will be added to it and removed by Remove demo data.'],
      notes: [],
    });
  });

  it('notes containers the app created on an earlier Load, also when the job is done', async () => {
    repoMock.getSetting.mockResolvedValue({ id: 'j', kind: 'load', status: 'done', step: 10, total: 10, message: 'Done', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), accountId: 'acc-1' });
    repoMock.listDemoArtifacts.mockResolvedValue([{ slot: 'container:space-PLAT', artifactKey: 'PLAT', createdByApp: true }]);
    expect(await call('getDemoJob')).toMatchObject({
      job: { status: 'done' },
      warnings: [],
      notes: ['Space PLAT was created by Hindsight for the demo; Remove demo data keeps it.'],
    });
  });
});
