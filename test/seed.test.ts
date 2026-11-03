import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoArtifact, DemoArtifactInput, ScenarioEventInput, ServiceMapping } from '../src/adapters/repo';
import { DEMO, DEMO_ARTIFACTS } from '../src/core/demoData';
import { DOSSIER_IDS_KEY } from '../src/core/dossier';
import { containerNotes, existingContainerWarnings, INC_SLOT, loadDemoData, PAY_SLOT, removeDemoData, resetShowcase, SeedError, SPACE_SLOT, T0_SETTING, type SeedDeps } from '../src/core/seed';

const NOW = Date.parse('2026-11-03T10:00:00.000Z');

function fakeWorld(opts: { existingPageTitle?: string; incRefused?: boolean } = {}) {
  let nextId = 1000;
  const calls: string[] = [];
  const projects = new Map<string, { id: string; key: string; name: string; projectTypeKey: string }>();
  const issues = new Map<string, { id: string; key: string; summary: string }>();
  const counters: Record<string, number> = {};
  const artifacts = new Map<string, DemoArtifact>();
  const settings = new Map<string, unknown>();
  const events: ScenarioEventInput[] = [];
  const mappings: ServiceMapping[] = [];
  const newIssue = (projectKey: string, summary: string) => {
    counters[projectKey] = (counters[projectKey] ?? 0) + 1;
    const issue = { id: String(nextId++), key: `${projectKey}-${counters[projectKey]}`, summary };
    issues.set(issue.key, issue);
    calls.push(`issue:${issue.key}:${summary}`);
    return { id: issue.id, key: issue.key };
  };

  const jira: SeedDeps['jira'] = {
    getProject: vi.fn(async (key: string) => projects.get(key)),
    createProject: vi.fn(async (input) => {
      if (opts.incRefused && input.key === 'INC') throw Object.assign(new Error('Jira 403: You do not have permission'), { status: 403 });
      const p = { id: String(nextId++), key: input.key, name: input.name, projectTypeKey: input.projectTypeKey };
      projects.set(input.key, p);
      calls.push(`project:${input.key}`);
      return { id: p.id, key: p.key };
    }),
    issueTypes: vi.fn(async (key: string) =>
      key === 'INC'
        ? [
            { id: '1', name: '[System] Incident' },
            { id: '2', name: '[System] Service request' },
          ]
        : [
            { id: '10', name: 'Task' },
            { id: '11', name: 'Story' },
          ],
    ),
    bulkCreateIssues: vi.fn(async (projectKey: string, _type: string, items) => items.map((i: { summary: string }) => newIssue(projectKey, i.summary))),
    createIssue: vi.fn(async (projectKey: string, _type: string, item) => newIssue(projectKey, item.summary)),
    addComment: vi.fn(async (key: string) => {
      calls.push(`comment:${key}`);
      return { id: String(nextId++) };
    }),
    transitionToDone: vi.fn(async (key: string, resolution?: string, _opts?: { preferResolved?: boolean }) => {
      calls.push(`close:${key}:${resolution ?? ''}`);
      return { closed: true as const, status: 'Done', resolution: resolution ?? null, path: [] };
    }),
    setIssueProperty: vi.fn(async () => undefined),
    deleteIssue: vi.fn(async (key: string) => {
      issues.delete(key);
    }),
    countIssues: vi.fn(async () => issues.size),
  };
  const pages = new Map<string, string>();
  const confluence: SeedDeps['confluence'] = {
    findSpace: vi.fn(async () => undefined),
    createSpace: vi.fn(async (key: string) => ({ id: '77', key })),
    findPageByTitle: vi.fn(async (_space: string, title: string) => (title === opts.existingPageTitle ? { id: '555', webUrl: 'https://x/wiki/555' } : undefined)),
    createPage: vi.fn(async (_space: string, title: string) => {
      const id = String(nextId++);
      pages.set(id, title);
      calls.push(`page:${title}`);
      return { id, webUrl: `https://x/wiki/${id}` };
    }),
    addPageLabel: vi.fn(async () => undefined),
    createFooterComment: vi.fn(async (pageId: string) => {
      calls.push(`page-comment:${pageId}`);
      return { id: String(nextId++), via: 'v2' as const };
    }),
    deletePage: vi.fn(async (id: string) => {
      pages.delete(id);
    }),
    countByCql: vi.fn(async () => pages.size),
  };
  const repo: SeedDeps['repo'] = {
    getSetting: async <T,>(k: string): Promise<T | undefined> => (settings.get(k) ?? undefined) as T | undefined,
    setSetting: vi.fn(async (k: string, v: unknown) => {
      settings.set(k, v);
    }),
    listDemoArtifacts: vi.fn(async () => [...artifacts.values()]),
    upsertDemoArtifact: vi.fn(async (a: DemoArtifactInput) => {
      artifacts.set(a.slot, {
        slot: a.slot,
        role: a.role,
        source: a.source,
        artifactId: a.artifactId,
        commentId: a.commentId ?? '',
        artifactKey: a.artifactKey ?? null,
        url: a.url ?? null,
        scenarioAt: a.scenarioAt ?? null,
        createdByApp: a.createdByApp,
        createdAt: new Date(NOW).toISOString(),
      });
    }),
    deleteDemoArtifacts: vi.fn(async (slots: readonly string[]) => {
      for (const s of slots) artifacts.delete(s);
      return slots.length;
    }),
    listServiceMappings: vi.fn(async () => mappings),
    upsertServiceMapping: vi.fn(async (m) => {
      mappings.push(m as never);
      return 'm1';
    }),
    seedScenarioEvents: vi.fn(async (rows: readonly ScenarioEventInput[]) => {
      events.push(...rows);
      return rows.length;
    }),
    seedIncidentScenario: vi.fn(async () => undefined),
    deleteEventsByRefs: vi.fn(async (refs) => refs.length),
    deleteJobsForIncident: vi.fn(async () => 1),
    deleteIncident: vi.fn(async () => 1),
    releaseAppLock: vi.fn(async () => undefined),
    getActiveGraphConnection: vi.fn(async () => ({ connectionId: 'conn-1' }) as Awaited<ReturnType<SeedDeps['repo']['getActiveGraphConnection']>>),
  };
  const graph: SeedDeps['graph'] = { deleteDossiers: vi.fn(async () => ({ success: true })) };
  const deps: SeedDeps = {
    jira,
    confluence,
    repo,
    graph,
    now: () => NOW,
    sleep: vi.fn(async () => undefined),
    deadline: NOW + 60_000,
    indexWaitMs: 180_000,
    progress: vi.fn(async () => undefined),
  };
  return { deps, calls, artifacts, settings, events, projects, mappings };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const ISSUE_SPECS = DEMO_ARTIFACTS.filter((s) => s.kind === 'issue').length;
const COMMENT_SPECS = DEMO_ARTIFACTS.filter((s) => s.kind === 'issue-comment' || s.kind === 'page-comment').length;
const PAGE_SPECS = DEMO_ARTIFACTS.filter((s) => s.kind === 'page').length;

describe('loadDemoData', () => {
  it('creates projects, space, every artifact and the incident, with 10 progress steps', async () => {
    const w = fakeWorld();
    const r = await loadDemoData('acc-1', w.deps);
    expect(r).toMatchObject({ complete: true, indexed: true, incidentKey: 'INC-15', existing: 0 });
    expect(r.created).toEqual({ projects: 2, spaces: 1, issues: ISSUE_SPECS + 1, comments: COMMENT_SPECS, pages: PAGE_SPECS });
    expect(w.deps.progress).toHaveBeenCalledTimes(10);
    expect(w.deps.jira.createProject).toHaveBeenCalledWith(expect.objectContaining({ key: 'INC', projectTypeKey: 'service_desk', leadAccountId: 'acc-1' }));
    expect(w.deps.repo.upsertServiceMapping).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: 'checkout', jiraProjectKeys: ['PAY', 'INC'] }));
    expect(w.settings.get(T0_SETTING)).toBe('2026-11-02T10:00:00.000Z');
  });

  it('creates the incident last, closes both S2 tickets as Cannot Reproduce and sets the issue property', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    const creates = w.calls.filter((c) => /^(issue|page|comment|page-comment):/.test(c));
    expect(creates.at(-1)).toBe(`issue:INC-15:${DEMO.incident.summary}`);
    expect(w.calls.filter((c) => c.endsWith(':Cannot Reproduce'))).toHaveLength(2);
    expect(w.deps.jira.setIssueProperty).toHaveBeenCalledWith('INC-15', 'hindsight', { serviceKey: 'checkout', demo: true, scenarioStartedAt: '2026-11-02T10:00:00.000Z' });
    expect(w.deps.repo.seedIncidentScenario).toHaveBeenCalledWith(
      expect.objectContaining({ issueKey: 'INC-15', scenarioStartedAt: '2026-11-02T10:00:00.000Z', scenarioResolvedAt: '2026-11-02T13:00:00.000Z' }),
    );
  });

  it('pre-seeds a scenario event for every artifact, JSM source for INC, parent ids for comments', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    expect(w.events).toHaveLength(DEMO_ARTIFACTS.length);
    for (const e of w.events) {
      expect(Date.parse(e.scenarioAt)).toBeLessThan(Date.parse('2026-11-02T10:00:00.000Z'));
      expect(Date.parse(e.scenarioAt)).toBeGreaterThan(Date.parse('2026-10-03T10:00:00.000Z'));
    }
    const s1 = w.artifacts.get('signal:s1-vendor-tls')!;
    const s1Event = w.events.find((e) => e.commentId === s1.commentId)!;
    expect(s1Event).toMatchObject({ source: 'confluence', kind: 'comment', artifactId: w.artifacts.get('distractor:plat-01')!.artifactId, spaceKey: 'PLAT' });
    expect(w.events.find((e) => e.artifactKey === w.artifacts.get('signal:s2a-jsm')!.artifactKey && e.kind === 'issue')).toMatchObject({ source: 'jsm', projectKey: 'INC' });
    expect(w.events.find((e) => e.commentId === w.artifacts.get('signal:s3-unanswered')!.commentId)).toMatchObject({ source: 'jira', title: 'Upgrade payment client' });
  });

  it('is idempotent: a second run creates nothing and rewrites the scenario rows', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    const before = w.calls.length;
    const r = await loadDemoData('acc-1', w.deps);
    expect(w.calls.slice(before).filter((c) => !c.startsWith('close:'))).toEqual([]);
    expect(w.calls.slice(before)).toEqual([]);
    expect(r.created).toEqual({ projects: 0, spaces: 0, issues: 0, comments: 0, pages: 0 });
    expect(w.deps.repo.seedScenarioEvents).toHaveBeenCalledTimes(2);
  });

  it('stops as partial at the deadline and resumes where it stopped', async () => {
    const w = fakeWorld();
    let steps = 0;
    w.deps.progress = vi.fn(async () => {
      steps += 1;
      if (steps === 5) w.deps.deadline = NOW - 1;
    });
    const first = await loadDemoData('acc-1', w.deps);
    expect(first.complete).toBe(false);
    expect(w.artifacts.has('incident')).toBe(false);
    w.deps.deadline = NOW + 60_000;
    w.deps.progress = vi.fn(async () => undefined);
    const second = await loadDemoData('acc-1', w.deps);
    expect(second.complete).toBe(true);
    expect(second.created.projects).toBe(0);
    expect(w.calls.filter((c) => c.startsWith('issue:'))).toHaveLength(ISSUE_SPECS + 1);
  });

  it('uses existing projects and pages without creating them (created_by_app = 0)', async () => {
    const w = fakeWorld({ existingPageTitle: 'Build pipeline conventions' });
    w.projects.set('PAY', { id: '1', key: 'PAY', name: 'Payments', projectTypeKey: 'software' });
    await loadDemoData('acc-1', w.deps);
    expect(w.calls).not.toContain('project:PAY');
    expect(w.artifacts.get(PAY_SLOT)).toMatchObject({ createdByApp: false, source: 'jira' });
    expect(w.artifacts.get(INC_SLOT)).toMatchObject({ createdByApp: true, source: 'jsm' });
    expect(w.artifacts.get('distractor:plat-06')).toMatchObject({ createdByApp: false, artifactId: '555' });
  });

  it('turns a refused INC creation into a SeedError with the manual fallback', async () => {
    const w = fakeWorld({ incRefused: true });
    await expect(loadDemoData('acc-1', w.deps)).rejects.toThrow(SeedError);
    await expect(loadDemoData('acc-1', w.deps)).rejects.toThrow(/Create a Jira Service Management project with key INC/);
    expect(w.artifacts.has(PAY_SLOT)).toBe(true);
  });

  it('reports indexed: false when search does not catch up in time', async () => {
    const w = fakeWorld();
    w.deps.jira.countIssues = vi.fn(async () => 0);
    w.deps.indexWaitMs = 30_000;
    const r = await loadDemoData('acc-1', w.deps);
    expect(r).toMatchObject({ complete: true, indexed: false });
  });
});

describe('resetShowcase', () => {
  it('needs a loaded demo', async () => {
    await expect(resetShowcase(fakeWorld().deps)).rejects.toThrow(SeedError);
  });

  it('forgets analyses of the demo incident and re-writes the scenario without creating artifacts', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    const before = w.calls.length;
    const r = await resetShowcase(w.deps);
    expect(r).toMatchObject({ complete: true, incidentKey: 'INC-15' });
    expect(w.deps.repo.deleteJobsForIncident).toHaveBeenCalledWith('INC-15');
    expect(w.deps.repo.releaseAppLock).toHaveBeenCalledWith('analyze:INC-15');
    expect(w.calls.length).toBe(before);
    expect(w.deps.repo.setSetting).toHaveBeenCalledWith('dossier_last', null);
  });
});

describe('removeDemoData', () => {
  it('deletes only what the app created; projects, space and pre-existing pages stay', async () => {
    const w = fakeWorld({ existingPageTitle: 'Build pipeline conventions' });
    await loadDemoData('acc-1', w.deps);
    const r = await removeDemoData(w.deps);
    expect(r).toMatchObject({ complete: true, deletedIssues: ISSUE_SPECS + 1, deletedPages: PAGE_SPECS - 1, kept: 1 });
    expect(w.deps.confluence.deletePage).not.toHaveBeenCalledWith('555');
    expect([...w.artifacts.keys()].sort()).toEqual([INC_SLOT, PAY_SLOT, SPACE_SLOT].sort());
    expect(w.deps.repo.deleteIncident).toHaveBeenCalledWith('INC-15');
    expect(w.deps.repo.deleteJobsForIncident).toHaveBeenCalledWith('INC-15');
    expect(w.settings.get(T0_SETTING)).toBeNull();
    expect(w.deps.repo.setSetting).toHaveBeenCalledWith('dossier_last', null);
  });

  it('deletes the tracked dossiers and the demo incident dossier, then forgets them', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    w.settings.set(DOSSIER_IDS_KEY, ['dossier-inc-3', 'dossier-inc-15']);
    const r = await removeDemoData(w.deps);
    expect(w.deps.graph.deleteDossiers).toHaveBeenCalledWith('conn-1', ['dossier-inc-3', 'dossier-inc-15']);
    expect(r).toMatchObject({ complete: true, deletedDossiers: 2, warnings: [] });
    expect(w.settings.get(DOSSIER_IDS_KEY)).toEqual([]);
    expect(console.info).toHaveBeenCalledWith('dossier deleted', { ids: ['dossier-inc-3', 'dossier-inc-15'], result: { success: true } });
  });

  it('skips the dossier delete without an active connection', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    vi.mocked(w.deps.repo.getActiveGraphConnection).mockResolvedValue(undefined);
    const r = await removeDemoData(w.deps);
    expect(w.deps.graph.deleteDossiers).not.toHaveBeenCalled();
    expect(r).toMatchObject({ complete: true, deletedDossiers: 0, warnings: [] });
    expect(console.info).toHaveBeenCalledWith('dossier delete skipped', { ids: ['dossier-inc-15'], reason: 'no connection' });
  });

  it('a failed dossier delete is a warning; Remove still completes and the ids stay tracked', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    w.settings.set(DOSSIER_IDS_KEY, ['dossier-inc-15']);
    vi.mocked(w.deps.graph.deleteDossiers).mockResolvedValue({ success: false, error: 'HTTP 500' });
    const r = await removeDemoData(w.deps);
    expect(r).toMatchObject({ complete: true, deletedDossiers: 0 });
    expect(r.warnings?.[0]).toContain('HTTP 500');
    expect(w.settings.get(DOSSIER_IDS_KEY)).toEqual(['dossier-inc-15']);
    expect(w.deps.repo.deleteIncident).toHaveBeenCalledWith('INC-15');
  });

  it('a Load after Remove creates a fresh incident in the kept projects', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    await removeDemoData(w.deps);
    const r = await loadDemoData('acc-1', w.deps);
    expect(r.created.projects).toBe(0);
    expect(r.incidentKey).toBe('INC-30');
  });
});

describe('review fixes', () => {
  it('records every bulk-created issue before the one-by-one fallback, so a 429 there leaves no unrecorded issue', async () => {
    const w = fakeWorld();
    const realBulk = w.deps.jira.bulkCreateIssues;
    // PAY tasks: the second element is rejected by bulk; its single create then hits 429.
    w.deps.jira.bulkCreateIssues = vi.fn(async (key: string, type: string, items) => {
      if (!(key === 'PAY' && items.length > 2)) return realBulk(key, type, items);
      const out = await realBulk(key, type, items.filter((_: unknown, i: number) => i !== 1));
      return [out[0], undefined, ...out.slice(1)];
    });
    w.deps.jira.createIssue = vi.fn(async () => Promise.reject(Object.assign(new Error('Jira 429'), { status: 429 })));
    await expect(loadDemoData('acc-1', w.deps)).rejects.toThrow('429');
    const createdKeys = w.calls.filter((c) => c.startsWith('issue:PAY-')).map((c) => c.split(':')[1]);
    const recorded = new Set([...w.artifacts.values()].map((a) => a.artifactKey));
    expect(createdKeys.length).toBeGreaterThan(10);
    for (const k of createdKeys) expect(recorded.has(k!)).toBe(true);
  });

  it('creates the checkout mapping only when missing and never overwrites an edited one', async () => {
    const w = fakeWorld();
    w.mappings.push({ id: 'x', serviceKey: 'checkout', displayName: 'Edited', jiraProjectKeys: ['PAY'], jiraComponentNames: [], confluenceSpaceKeys: [], aliases: [], ownerTeamId: null, ownerTeamName: null });
    await loadDemoData('acc-1', w.deps);
    await resetShowcase(w.deps);
    expect(w.deps.repo.upsertServiceMapping).not.toHaveBeenCalled();
    const fresh = fakeWorld();
    await loadDemoData('acc-1', fresh.deps);
    expect(fresh.deps.repo.upsertServiceMapping).toHaveBeenCalledTimes(1);
  });

  it('warns in progress and in the result when an existing project or space is reused', async () => {
    const w = fakeWorld();
    w.projects.set('PAY', { id: '1', key: 'PAY', name: 'Payments', projectTypeKey: 'software' });
    w.deps.confluence.findSpace = vi.fn(async () => ({ id: '9', key: 'PLAT' }));
    const r = await loadDemoData('acc-1', w.deps);
    const payWarning = 'Using existing project PAY; demo issues will be added to it and removed by Remove demo data.';
    const spaceWarning = 'Using existing space PLAT; demo pages will be added to it and removed by Remove demo data.';
    expect(r.warnings).toEqual([payWarning, spaceWarning]);
    expect(w.deps.progress).toHaveBeenCalledWith(1, 10, payWarning);
    expect(w.deps.progress).toHaveBeenCalledWith(3, 10, spaceWarning);
    expect(existingContainerWarnings([...w.artifacts.values()])).toEqual([payWarning, spaceWarning]);
  });

  it('no warning when the app created everything', async () => {
    const r = await loadDemoData('acc-1', fakeWorld().deps);
    expect(r.warnings).toEqual([]);
  });
});

describe('closing demo issues', () => {
  it('resolves the incident (preferResolved) and logs every close with slot, status and resolution', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    expect(w.deps.jira.transitionToDone).toHaveBeenCalledWith('INC-15', undefined, { preferResolved: true });
    expect(w.deps.jira.transitionToDone).toHaveBeenCalledWith(expect.stringMatching(/^INC-/), 'Cannot Reproduce', { preferResolved: false });
    const closed = (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === 'demo: issue closed').map((c) => c[1] as { slot: string });
    expect(closed.map((c) => c.slot).sort()).toEqual(['incident', 'signal:s2a-jsm', 'signal:s2b-jsm']);
    expect(closed.find((c) => c.slot === 'signal:s2a-jsm')).toMatchObject({ status: 'Done', resolution: 'Cannot Reproduce' });
  });

  it('logs a warning with the slot when no Done status is reachable', async () => {
    const w = fakeWorld();
    w.deps.jira.transitionToDone = vi.fn(async () => ({ closed: false as const, path: [], available: ['Respond → Waiting for customer'] }));
    const r = await loadDemoData('acc-1', w.deps);
    expect(console.warn).toHaveBeenCalledWith(
      'demo: could not close issue, no Done transition reachable',
      expect.objectContaining({ slot: 'signal:s2a-jsm', available: ['Respond → Waiting for customer'] }),
    );
    expect(r.closures.find((c) => c.slot === 'signal:s2b-jsm')).toMatchObject({ outcome: 'not closed', available: ['Respond → Waiting for customer'] });
  });
});

describe('load result reports closures and reused containers', () => {
  it('lists S2a, S2b and the incident as closed, and as already closed on a re-run', async () => {
    const w = fakeWorld();
    const first = await loadDemoData('acc-1', w.deps);
    expect(first.closures.map((c) => [c.slot, c.outcome, c.status, c.resolution])).toEqual([
      ['signal:s2a-jsm', 'closed', 'Done', 'Cannot Reproduce'],
      ['signal:s2b-jsm', 'closed', 'Done', 'Cannot Reproduce'],
      ['incident', 'closed', 'Done', null],
    ]);
    expect(console.info).toHaveBeenCalledWith('demo: closing customer tickets', { slots: ['signal:s2a-jsm', 'signal:s2b-jsm'] });
    const second = await loadDemoData('acc-1', w.deps);
    expect(second.closures.map((c) => [c.slot, c.outcome, c.status])).toEqual([
      ['signal:s2a-jsm', 'already closed', 'Done'],
      ['signal:s2b-jsm', 'already closed', 'Done'],
      ['incident', 'already closed', 'Done'],
    ]);
  });

  it('after Remove + Load, containers created earlier by the app get a note (no warning)', async () => {
    const w = fakeWorld();
    await loadDemoData('acc-1', w.deps);
    await removeDemoData(w.deps);
    const r = await loadDemoData('acc-1', w.deps);
    expect(r.warnings).toEqual([]);
    expect(containerNotes([...w.artifacts.values()])).toEqual([
      'Project PAY was created by Hindsight for the demo; Remove demo data keeps it.',
      'Project INC was created by Hindsight for the demo; Remove demo data keeps it.',
      'Space PLAT was created by Hindsight for the demo; Remove demo data keeps it.',
    ]);
    expect(r.closures.every((c) => c.outcome === 'closed')).toBe(true);
  });
});
