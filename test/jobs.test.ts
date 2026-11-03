import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeLock, canTransition, propertyServiceKey, startAnalysis, type StartDeps } from '../src/core/jobs';
import { InputError } from '../src/core/validate';

const issue = {
  id: '10050',
  key: 'INC-7',
  fields: {
    summary: 'Checkout payments failing',
    description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'HTTP 402' }] }] },
    created: '2026-11-20T10:00:00.000+0000',
    project: { key: 'INC' },
    components: [{ name: 'Checkout' }],
    priority: { name: 'High' },
  },
};

const mapping = {
  id: 'm1',
  serviceKey: 'payments',
  displayName: 'Payments',
  jiraProjectKeys: ['PAY'],
  jiraComponentNames: ['Checkout'],
  confluenceSpaceKeys: ['PLAT'],
  aliases: [],
  ownerTeamId: null,
  ownerTeamName: null,
};

function makeDeps() {
  const repo = {
      getIncident: vi.fn(async (): Promise<unknown> => undefined),
      upsertIncident: vi.fn(async (_i: unknown) => undefined),
      listServiceMappings: vi.fn(async () => [mapping]),
      getSetting: vi.fn(async () => undefined),
      acquireAppLock: vi.fn(async () => true),
      releaseAppLock: vi.fn(async () => undefined),
      getActiveJobForIncident: vi.fn(async () => ({ id: 'job-active' })),
      createJob: vi.fn(async (_job: unknown) => 'job-1'),
      updateJob: vi.fn(async (_id: string, _patch: unknown) => 1),
  };
  const getIncidentAsUser = vi.fn(async (): Promise<unknown> => issue);
  const getIssueProperty = vi.fn(async (): Promise<unknown> => undefined);
  const pushCollect = vi.fn(async (): Promise<void> => undefined);
  const deps = { getIncidentAsUser, getIssueProperty, repo, pushCollect, now: () => Date.parse('2026-11-25T00:00:00Z') } as unknown as StartDeps;
  return { deps, repo, getIncidentAsUser, getIssueProperty, pushCollect };
}

let m: ReturnType<typeof makeDeps>;
let deps: StartDeps;
beforeEach(() => {
  m = makeDeps();
  deps = m.deps;
});

describe('canTransition', () => {
  it('follows the pipeline order and allows failing from any active state', () => {
    expect(canTransition('queued', 'collecting')).toBe(true);
    expect(canTransition('collecting', 'scoring')).toBe(false);
    expect(canTransition('scoring', 'failed')).toBe(true);
    expect(canTransition('done', 'failed')).toBe(false);
  });
});

describe('startAnalysis', () => {
  it('upserts the incident, takes the lock, creates the job and queues collect', async () => {
    const result = await startAnalysis('INC-7', 30, 'acc-1', deps);
    expect(result).toEqual({ status: 'started', jobId: 'job-1', limited: false });
    expect(m.repo.upsertIncident).toHaveBeenCalledWith(
      expect.objectContaining({ issueKey: 'INC-7', issueId: '10050', serviceKey: 'payments', serviceSource: 'component', severity: 'High' }),
    );
    const upserted = m.repo.upsertIncident.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upserted).not.toHaveProperty('scenarioStartedAt');
    expect(m.repo.acquireAppLock).toHaveBeenCalledWith(analyzeLock('INC-7'), '2026-11-25T00:00:00.000Z', 1200);
    const job = m.repo.createJob.mock.calls[0]?.[0] as { scope: { jiraProjectKeys: string[] }; windowTo: string; requestedBy: string };
    expect(job.scope.jiraProjectKeys).toEqual(['INC', 'PAY']);
    expect(job.windowTo).toBe('2026-11-20T10:00:00.000Z');
    expect(job.requestedBy).toBe('acc-1');
    expect(m.pushCollect).toHaveBeenCalledWith({ jobId: 'job-1', attempt: 1 });
  });

  it('returns the running job instead of starting a second one', async () => {
    m.repo.acquireAppLock.mockResolvedValue(false);
    expect(await startAnalysis('INC-7', 30, null, deps)).toEqual({ status: 'running', jobId: 'job-active' });
    expect(m.repo.createJob).not.toHaveBeenCalled();
  });

  it('releases the lock when queueing fails', async () => {
    m.pushCollect.mockRejectedValue(new Error('queue down'));
    await expect(startAnalysis('INC-7', 30, null, deps)).rejects.toThrow('queue down');
    expect(m.repo.releaseAppLock).toHaveBeenCalledWith('analyze:INC-7');
    expect(m.repo.updateJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'failed', lastError: 'Could not queue the analysis: queue down' }));
  });

  it('refuses an incident the user cannot see', async () => {
    m.getIncidentAsUser.mockResolvedValue(undefined);
    await expect(startAnalysis('INC-7', 30, null, deps)).rejects.toBeInstanceOf(InputError);
    expect(m.repo.upsertIncident).not.toHaveBeenCalled();
  });

  it('uses the demo scenario start for the window and the issue property for the service', async () => {
    m.repo.getIncident.mockResolvedValue({ scenarioStartedAt: '2026-11-01T00:00:00.000Z', serviceKey: null, serviceSource: null });
    m.getIssueProperty.mockResolvedValue({ serviceKey: 'payments' });
    await startAnalysis('INC-7', 10, null, deps);
    const job = m.repo.createJob.mock.calls[0]?.[0] as { windowFrom: string; windowTo: string; scope: { serviceSource: string } };
    expect(job.windowTo).toBe('2026-11-01T00:00:00.000Z');
    expect(job.windowFrom).toBe('2026-10-22T00:00:00.000Z');
    expect(job.scope.serviceSource).toBe('property');
  });

  it('propertyServiceKey validates the property value', () => {
    expect(propertyServiceKey({ serviceKey: 'payments' })).toBe('payments');
    expect(propertyServiceKey({ serviceKey: 'bad key!' })).toBeNull();
    expect(propertyServiceKey('payments')).toBeNull();
  });
});
