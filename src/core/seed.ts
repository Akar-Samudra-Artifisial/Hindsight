import type { ConfluenceClient } from '../adapters/confluence';
import type { JiraClient } from '../adapters/jira';
import type { DemoArtifact, DemoArtifactInput, EventRef, EventSource, Repo, ScenarioEventInput } from '../adapters/repo';
import {
  adfParagraphs,
  DEMO,
  DEMO_ARTIFACTS,
  INCIDENT_SLOT,
  newScenarioStart,
  pageStorage,
  pickIssueType,
  scenarioAt,
  storageParagraphs,
  type DemoIssueType,
  type DemoProject,
  type DemoSpec,
} from './demoData';
import type { DemoProgress, DemoRunResult } from './demoJob';
import { analyzeLock, ISSUE_PROPERTY } from './jobs';

/**
 * Demo seed (Arkana Commerce). Idempotent: every artifact has a stable slot in `demo_artifacts`, checked before it is
 * created and written right after, so a re-run (after a timeout or a 429) only creates what is missing. Remove only
 * deletes artifacts the app created; projects and spaces are never deleted.
 */

/** An error the admin can act on; its message is shown on the setup page. */
export class SeedError extends Error {}

export interface SeedDeps {
  jira: Pick<
    JiraClient,
    'getProject' | 'createProject' | 'issueTypes' | 'bulkCreateIssues' | 'createIssue' | 'addComment' | 'transitionToDone' | 'setIssueProperty' | 'deleteIssue' | 'countIssues'
  >;
  confluence: Pick<
    ConfluenceClient,
    'findSpace' | 'createSpace' | 'findPageByTitle' | 'createPage' | 'addPageLabel' | 'createFooterComment' | 'deletePage' | 'countByCql'
  >;
  repo: Pick<
    Repo,
    | 'getSetting'
    | 'setSetting'
    | 'listDemoArtifacts'
    | 'upsertDemoArtifact'
    | 'deleteDemoArtifacts'
    | 'listServiceMappings'
    | 'upsertServiceMapping'
    | 'seedScenarioEvents'
    | 'seedIncidentScenario'
    | 'deleteEventsByRefs'
    | 'deleteJobsForIncident'
    | 'deleteIncident'
    | 'releaseAppLock'
  >;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Epoch ms after which no new step starts (the job ends as partial). */
  deadline: number;
  /** How long to wait for Jira/Confluence search to index the demo data. */
  indexWaitMs: number;
  progress: DemoProgress;
}

export const LOAD_STEPS = 10;
export const INDEX_POLL_MS = 10_000;
export const T0_SETTING = 'demo_t0';
const CLOSED_SUFFIX = ':closed';
export const PAY_SLOT = `container:project-${DEMO.pay.key}`;
export const INC_SLOT = `container:project-${DEMO.inc.key}`;
export const SPACE_SLOT = `container:space-${DEMO.space.key}`;

export interface SeedCounts {
  projects: number;
  spaces: number;
  issues: number;
  comments: number;
  pages: number;
}

const zero = (): SeedCounts => ({ projects: 0, spaces: 0, issues: 0, comments: 0, pages: 0 });
const statusOf = (err: unknown): number | undefined => {
  const s = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
};
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
/** Permission/validation refusals become a SeedError with a manual fallback; 429 and other errors propagate. */
const refused = (err: unknown): boolean => [400, 401, 403, 404].includes(statusOf(err) ?? 0);

class Slots {
  private readonly map: Map<string, DemoArtifact>;
  constructor(
    rows: readonly DemoArtifact[],
    private readonly deps: SeedDeps,
  ) {
    this.map = new Map(rows.map((r) => [r.slot, r]));
  }
  get(slot: string): DemoArtifact | undefined {
    return this.map.get(slot);
  }
  all(): DemoArtifact[] {
    return [...this.map.values()];
  }
  async record(a: DemoArtifactInput): Promise<DemoArtifact> {
    await this.deps.repo.upsertDemoArtifact(a);
    const row: DemoArtifact = {
      slot: a.slot,
      role: a.role,
      source: a.source,
      artifactId: a.artifactId,
      commentId: a.commentId ?? '',
      artifactKey: a.artifactKey ?? null,
      url: a.url ?? null,
      scenarioAt: a.scenarioAt ?? null,
      createdByApp: a.createdByApp,
      createdAt: new Date(this.deps.now()).toISOString(),
    };
    this.map.set(a.slot, row);
    return row;
  }
  async drop(slots: readonly string[]): Promise<void> {
    if (slots.length === 0) return;
    await this.deps.repo.deleteDemoArtifacts(slots);
    for (const s of slots) this.map.delete(s);
  }
}

async function scenarioStart(deps: SeedDeps): Promise<string> {
  const stored = await deps.repo.getSetting<unknown>(T0_SETTING);
  if (typeof stored === 'string' && !Number.isNaN(Date.parse(stored))) return stored;
  const t0 = newScenarioStart(deps.now());
  await deps.repo.setSetting(T0_SETTING, t0);
  return t0;
}

const SPEC_BY_SLOT = new Map(DEMO_ARTIFACTS.map((s) => [s.slot, s]));

function projectOf(spec: DemoSpec): DemoProject | undefined {
  if (spec.kind === 'issue') return spec.project;
  if (spec.kind === 'issue-comment') {
    const parent = SPEC_BY_SLOT.get(spec.parent);
    return parent?.kind === 'issue' ? parent.project : undefined;
  }
  return undefined;
}

const containerSlot = (p: DemoProject) => (p === 'PAY' ? PAY_SLOT : INC_SLOT);

/** Warnings for demo containers the app did not create (an existing project or space is reused, not deleted). */
export function existingContainerWarnings(artifacts: readonly Pick<DemoArtifact, 'slot' | 'artifactKey' | 'createdByApp'>[]): string[] {
  return artifacts.flatMap((a) => {
    if (a.createdByApp) return [];
    const key = a.artifactKey ?? '';
    if (a.slot === PAY_SLOT || a.slot === INC_SLOT) return [`Using existing project ${key}; demo issues will be added to it and removed by Remove demo data.`];
    if (a.slot === SPACE_SLOT) return [`Using existing space ${key}; demo pages will be added to it and removed by Remove demo data.`];
    return [];
  });
}

/**
 * Notes for every demo project/space Hindsight reuses: one it did not create (warning) or one it created on an
 * earlier Load and kept through Remove. Shown on the setup page after the job, whatever its status.
 */
export function containerNotes(artifacts: readonly Pick<DemoArtifact, 'slot' | 'artifactKey' | 'createdByApp'>[]): string[] {
  const warnings = existingContainerWarnings(artifacts);
  const kept = artifacts.flatMap((a) => {
    if (!a.createdByApp) return [];
    const key = a.artifactKey ?? '';
    if (a.slot === PAY_SLOT || a.slot === INC_SLOT) return [`Project ${key} was created by Hindsight for the demo; Remove demo data keeps it.`];
    if (a.slot === SPACE_SLOT) return [`Space ${key} was created by Hindsight for the demo; Remove demo data keeps it.`];
    return [];
  });
  return [...warnings, ...kept];
}

// --- Containers -----------------------------------------------------------------------------------

async function ensureProject(project: DemoProject, accountId: string, slots: Slots, deps: SeedDeps, counts: SeedCounts): Promise<DemoArtifact> {
  const slot = containerSlot(project);
  const known = slots.get(slot);
  if (known) return known;
  const def = project === 'PAY' ? DEMO.pay : DEMO.inc;
  let info = await deps.jira.getProject(def.key);
  let createdByApp = false;
  if (info) {
    console.info('demo: using existing Jira project', { key: def.key, projectTypeKey: info.projectTypeKey });
  } else {
    try {
      await deps.jira.createProject({ ...def, leadAccountId: accountId });
    } catch (err) {
      if (!refused(err)) throw err;
      console.warn('demo: project creation refused', { key: def.key, status: statusOf(err), error: messageOf(err) });
      const manual =
        project === 'INC'
          ? `Create a Jira Service Management project with key ${def.key} (IT service management template), then click Load demo data again.`
          : `Create a Jira software project with key ${def.key}, then click Load demo data again.`;
      throw new SeedError(`${manual} (Jira said: ${messageOf(err)})`);
    }
    info = await deps.jira.getProject(def.key);
    if (!info) throw new SeedError(`Jira project ${def.key} was created but cannot be read yet. Click Load demo data again.`);
    createdByApp = true;
    counts.projects += 1;
    console.info('demo: Jira project created', { key: def.key, projectTypeKey: info.projectTypeKey });
  }
  if (project === 'INC' && info.projectTypeKey !== 'service_desk') {
    console.warn('demo: INC is not a service project; its tickets are collected as Jira, not JSM', { projectTypeKey: info.projectTypeKey });
  }
  return slots.record({
    slot,
    role: 'container',
    source: info.projectTypeKey === 'service_desk' ? 'jsm' : 'jira',
    artifactId: info.id,
    artifactKey: info.key,
    createdByApp,
  });
}

async function ensureSpace(slots: Slots, deps: SeedDeps, counts: SeedCounts): Promise<DemoArtifact> {
  const known = slots.get(SPACE_SLOT);
  if (known) return known;
  const { key, name, description } = DEMO.space;
  let space = await deps.confluence.findSpace(key);
  let createdByApp = false;
  if (space) {
    console.info('demo: using existing Confluence space', { key });
  } else {
    try {
      space = await deps.confluence.createSpace(key, name, description);
    } catch (err) {
      if (!refused(err)) throw err;
      console.warn('demo: space creation refused', { key, status: statusOf(err), error: messageOf(err) });
      throw new SeedError(`Create a Confluence space with key ${key}, then click Load demo data again. (Confluence said: ${messageOf(err)})`);
    }
    createdByApp = true;
    counts.spaces += 1;
    console.info('demo: Confluence space created', { key });
  }
  return slots.record({ slot: SPACE_SLOT, role: 'container', source: 'space', artifactId: space.id, artifactKey: space.key, createdByApp });
}

// --- Issues and comments --------------------------------------------------------------------------

async function typeIdFor(project: DemoArtifact, want: DemoIssueType, deps: SeedDeps, cache: Map<string, { id: string; name: string }[]>): Promise<string> {
  const key = project.artifactKey ?? '';
  let types = cache.get(key);
  if (!types) {
    types = await deps.jira.issueTypes(key);
    cache.set(key, types);
  }
  const pick = pickIssueType(types, want);
  if (!pick) throw new SeedError(`Jira project ${key} has no issue type the app can create.`);
  return pick.id;
}

type IssueSpec = Extract<DemoSpec, { kind: 'issue' }>;

/** Creates the missing issues of one project, per issue type in bulk; rejected elements are retried one by one. */
async function createIssues(project: DemoArtifact, specs: readonly IssueSpec[], t0: string, slots: Slots, deps: SeedDeps, counts: SeedCounts, types: Map<string, { id: string; name: string }[]>): Promise<void> {
  const key = project.artifactKey ?? '';
  const missing = specs.filter((s) => !slots.get(s.slot));
  const byType = new Map<DemoIssueType, IssueSpec[]>();
  for (const s of missing) byType.set(s.issueType, [...(byType.get(s.issueType) ?? []), s]);
  for (const [issueType, group] of byType) {
    const typeId = await typeIdFor(project, issueType, deps, types);
    const items = group.map((s) => ({ summary: s.title, description: adfParagraphs(s.body), labels: [DEMO.label] }));
    let created: ({ id: string; key: string } | undefined)[];
    try {
      created = await deps.jira.bulkCreateIssues(key, typeId, items);
    } catch (err) {
      if (statusOf(err) === 429) throw err;
      console.warn('demo: bulk create failed, falling back to single creates', { project: key, status: statusOf(err), error: messageOf(err) });
      created = group.map(() => undefined);
    }
    const record = async (spec: IssueSpec, issue: { id: string; key: string }) => {
      await slots.record({ slot: spec.slot, role: spec.role, source: project.source, artifactId: issue.id, artifactKey: issue.key, scenarioAt: scenarioAt(t0, spec.minutesBefore), createdByApp: true });
      counts.issues += 1;
    };
    // Record every bulk-created issue first, so a 429 or error during the one-by-one fallback never leaves an
    // unrecorded issue behind (it would be duplicated by the next Load and missed by Remove).
    for (const [i, spec] of group.entries()) {
      const issue = created[i];
      if (issue) await record(spec, issue);
    }
    for (const [i, spec] of group.entries()) {
      if (created[i]) continue;
      await record(spec, await deps.jira.createIssue(key, typeId, items[i]!));
    }
  }
}

async function createIssueComments(project: DemoProject, t0: string, slots: Slots, deps: SeedDeps, counts: SeedCounts): Promise<boolean> {
  for (const spec of DEMO_ARTIFACTS) {
    if (spec.kind !== 'issue-comment' || projectOf(spec) !== project || slots.get(spec.slot)) continue;
    if (deps.now() >= deps.deadline) return false;
    const parent = slots.get(spec.parent);
    if (!parent?.artifactKey) throw new Error(`demo: parent ${spec.parent} of ${spec.slot} is missing`);
    const comment = await deps.jira.addComment(parent.artifactKey, adfParagraphs(spec.body));
    await slots.record({
      slot: spec.slot,
      role: spec.role,
      source: parent.source,
      artifactId: parent.artifactId,
      commentId: comment.id,
      artifactKey: parent.artifactKey,
      scenarioAt: scenarioAt(t0, spec.minutesBefore),
      createdByApp: true,
    });
    counts.comments += 1;
  }
  return true;
}

/** Outcome of closing one demo issue; also part of the Load result and its `demo load` log line. */
export interface CloseOutcome {
  slot: string;
  key: string | null;
  outcome: 'closed' | 'already closed' | 'not closed' | 'missing';
  status?: string;
  resolution?: string | null;
  available?: string[];
}

/** Closes an issue once (Done + resolution); a `<slot>:closed` marker row makes it idempotent. Always logs. */
async function closeOnce(slot: string, resolution: string | undefined, slots: Slots, deps: SeedDeps, preferResolved = false): Promise<CloseOutcome> {
  const issue = slots.get(slot);
  if (!issue?.artifactKey) {
    console.warn('demo: could not close issue, it is missing', { slot });
    return { slot, key: null, outcome: 'missing' };
  }
  const marker = slots.get(`${slot}${CLOSED_SUFFIX}`);
  if (marker) {
    console.info('demo: issue already closed earlier', { slot, key: issue.artifactKey, status: marker.artifactKey });
    return { slot, key: issue.artifactKey, outcome: 'already closed', ...(marker.artifactKey ? { status: marker.artifactKey } : {}) };
  }
  const result = await deps.jira.transitionToDone(issue.artifactKey, resolution, { preferResolved });
  let out: CloseOutcome;
  if (result.closed) {
    console.info('demo: issue closed', { slot, key: issue.artifactKey, status: result.status, resolution: result.resolution, via: result.path });
    out = { slot, key: issue.artifactKey, outcome: 'closed', status: result.status, resolution: result.resolution };
  } else {
    console.warn('demo: could not close issue, no Done transition reachable', { slot, key: issue.artifactKey, via: result.path, available: result.available });
    out = { slot, key: issue.artifactKey, outcome: 'not closed', available: result.available };
  }
  // The marker keeps the status reached in artifact_key, so a later Load can still report it.
  await slots.record({
    slot: `${slot}${CLOSED_SUFFIX}`,
    role: 'context',
    source: issue.source,
    artifactId: issue.artifactId,
    commentId: 'closed',
    artifactKey: result.closed ? result.status.slice(0, 64) : null,
    createdByApp: false,
  });
  return out;
}

// --- Pages ------------------------------------------------------------------------------------------

async function createPages(space: DemoArtifact, t0: string, slots: Slots, deps: SeedDeps, counts: SeedCounts): Promise<boolean> {
  for (const spec of DEMO_ARTIFACTS) {
    if (spec.kind !== 'page' || slots.get(spec.slot)) continue;
    if (deps.now() >= deps.deadline) return false;
    const existing = await deps.confluence.findPageByTitle(space.artifactId, spec.title);
    let page = existing;
    if (existing) {
      console.info('demo: using existing page', { slot: spec.slot, pageId: existing.id });
    } else {
      page = await deps.confluence.createPage(space.artifactId, spec.title, pageStorage(spec));
      await deps.confluence.addPageLabel(page.id, DEMO.label);
      counts.pages += 1;
    }
    await slots.record({
      slot: spec.slot,
      role: spec.role,
      source: 'confluence',
      artifactId: page!.id,
      url: page!.webUrl,
      scenarioAt: scenarioAt(t0, spec.minutesBefore),
      createdByApp: !existing,
    });
  }
  for (const spec of DEMO_ARTIFACTS) {
    if (spec.kind !== 'page-comment' || slots.get(spec.slot)) continue;
    if (deps.now() >= deps.deadline) return false;
    const parent = slots.get(spec.parent);
    if (!parent) throw new Error(`demo: parent ${spec.parent} of ${spec.slot} is missing`);
    const comment = await deps.confluence.createFooterComment(parent.artifactId, storageParagraphs(spec.body));
    console.info('demo: page comment created', { slot: spec.slot, via: comment.via });
    await slots.record({
      slot: spec.slot,
      role: spec.role,
      source: 'confluence',
      artifactId: parent.artifactId,
      commentId: comment.id,
      url: parent.url,
      scenarioAt: scenarioAt(t0, spec.minutesBefore),
      createdByApp: true,
    });
    counts.comments += 1;
  }
  return true;
}

const demoMapping = () => ({
  ...DEMO.mapping,
  jiraProjectKeys: [...DEMO.mapping.jiraProjectKeys],
  jiraComponentNames: [...DEMO.mapping.jiraComponentNames],
  confluenceSpaceKeys: [...DEMO.mapping.confluenceSpaceKeys],
  aliases: [...DEMO.mapping.aliases],
});

/** Creates the `checkout` mapping only when it does not exist yet, so an admin's edits are never overwritten. */
async function ensureDemoMapping(deps: SeedDeps): Promise<boolean> {
  const existing = await deps.repo.listServiceMappings();
  if (existing.some((m) => m.serviceKey === DEMO.mapping.serviceKey)) {
    console.info('demo: service mapping kept as is', { serviceKey: DEMO.mapping.serviceKey });
    return false;
  }
  await deps.repo.upsertServiceMapping(demoMapping());
  console.info('demo: service mapping created', { serviceKey: DEMO.mapping.serviceKey });
  return true;
}

// --- Scenario rows ------------------------------------------------------------------------------------

function titleOf(spec: DemoSpec): string {
  if (spec.kind === 'issue' || spec.kind === 'page') return spec.title;
  const parent = SPEC_BY_SLOT.get(spec.parent);
  return parent && (parent.kind === 'issue' || parent.kind === 'page') ? parent.title : '';
}

/** Scenario `events` rows for every recorded artifact, the incident's scenario times, the mapping and the property. */
async function preseed(slots: Slots, t0: string, deps: SeedDeps): Promise<{ events: number; incidentKey: string | null }> {
  await ensureDemoMapping(deps);
  const nowIso = new Date(deps.now()).toISOString();
  const projectKeys = { PAY: slots.get(PAY_SLOT)?.artifactKey ?? DEMO.pay.key, INC: slots.get(INC_SLOT)?.artifactKey ?? DEMO.inc.key };
  const rows: ScenarioEventInput[] = DEMO_ARTIFACTS.flatMap((spec): ScenarioEventInput[] => {
    const a = slots.get(spec.slot);
    if (!a) return [];
    const project = projectOf(spec);
    const isPage = spec.kind === 'page' || spec.kind === 'page-comment';
    return [
      {
        source: a.source as EventSource,
        kind: spec.kind === 'issue' ? 'issue' : spec.kind === 'page' ? 'page' : 'comment',
        artifactId: a.artifactId,
        commentId: a.commentId,
        artifactKey: a.artifactKey,
        title: titleOf(spec),
        url: a.url,
        projectKey: project ? projectKeys[project] : null,
        spaceKey: isPage ? DEMO.space.key : null,
        occurredAt: a.createdAt || nowIso,
        scenarioAt: scenarioAt(t0, spec.minutesBefore),
      },
    ];
  });
  const events = rows.length > 0 ? await deps.repo.seedScenarioEvents(rows) : 0;
  const incident = slots.get(INCIDENT_SLOT);
  if (!incident?.artifactKey) return { events, incidentKey: null };
  await deps.repo.seedIncidentScenario({
    issueKey: incident.artifactKey,
    issueId: incident.artifactId,
    projectKey: projectKeys.INC,
    summary: DEMO.incident.summary,
    serviceKey: DEMO.serviceKey,
    startedAt: incident.createdAt || nowIso,
    scenarioStartedAt: t0,
    scenarioResolvedAt: new Date(new Date(t0).getTime() + DEMO.incidentDurationMinutes * 60_000).toISOString(),
  });
  await deps.jira.setIssueProperty(incident.artifactKey, ISSUE_PROPERTY, { serviceKey: DEMO.serviceKey, demo: true, scenarioStartedAt: t0 });
  return { events, incidentKey: incident.artifactKey };
}

async function waitForIndex(slots: Slots, deps: SeedDeps): Promise<boolean> {
  const all = slots.all();
  const issues = all.filter((a) => a.commentId === '' && (a.source === 'jira' || a.source === 'jsm') && a.role !== 'container').length;
  const pages = all.filter((a) => a.source === 'confluence' && a.commentId === '' && a.createdByApp).length;
  const keys = [slots.get(PAY_SLOT)?.artifactKey, slots.get(INC_SLOT)?.artifactKey].filter((k): k is string => !!k);
  const jql = `labels = "${DEMO.label}" AND project in (${keys.map((k) => `"${k}"`).join(', ')})`;
  const cql = `label = "${DEMO.label}" AND space = "${DEMO.space.key}" AND type = page`;
  const until = Math.min(deps.deadline, deps.now() + deps.indexWaitMs);
  const polls = Math.max(0, Math.floor((until - deps.now()) / INDEX_POLL_MS));
  let seen = { issues: 0, pages: 0 };
  for (let i = 0; i <= polls; i += 1) {
    if (i > 0) await deps.sleep(INDEX_POLL_MS);
    const [seenIssues, seenPages] = await Promise.all([issues > 0 ? deps.jira.countIssues(jql) : 0, pages > 0 ? deps.confluence.countByCql(cql) : 0]);
    seen = { issues: seenIssues, pages: seenPages };
    if (seenIssues >= issues && seenPages >= pages) return true;
    if (deps.now() >= until) break;
  }
  console.warn('demo: search index still behind', { issues, seenIssues: seen.issues, pages, seenPages: seen.pages });
  return false;
}

// --- Jobs -----------------------------------------------------------------------------------------------

export interface LoadResult extends DemoRunResult {
  created: SeedCounts;
  existing: number;
  indexed: boolean;
  incidentKey: string | null;
  events: number;
  warnings: string[];
  closures: CloseOutcome[];
}

/** Load demo data: 10 steps, each skipped when its slots exist; stops as partial at the deadline. */
export async function loadDemoData(accountId: string, deps: SeedDeps): Promise<LoadResult> {
  const slots = new Slots(await deps.repo.listDemoArtifacts(), deps);
  const existing = slots.all().length;
  const created = zero();
  const types = new Map<string, { id: string; name: string }[]>();
  const t0 = await scenarioStart(deps);
  const warnings = () => existingContainerWarnings(slots.all());
  const closures: CloseOutcome[] = [];
  const partial = (): LoadResult => ({ complete: false, created, existing, indexed: false, incidentKey: slots.get(INCIDENT_SLOT)?.artifactKey ?? null, events: 0, warnings: warnings(), closures });
  /** Shows the reuse warning of a container in the job's progress message. */
  const warnIfExisting = async (n: number, container: DemoArtifact): Promise<void> => {
    const [warning] = existingContainerWarnings([container]);
    if (warning) await deps.progress(n, LOAD_STEPS, warning);
  };
  const step = async (n: number, message: string): Promise<boolean> => {
    if (deps.now() >= deps.deadline) return false;
    await deps.progress(n, LOAD_STEPS, message);
    return true;
  };

  if (!(await step(1, `Preparing Jira project ${DEMO.pay.key}`))) return partial();
  const pay = await ensureProject('PAY', accountId, slots, deps, created);
  await warnIfExisting(1, pay);
  if (!(await step(2, `Preparing service project ${DEMO.inc.key}`))) return partial();
  const inc = await ensureProject('INC', accountId, slots, deps, created);
  await warnIfExisting(2, inc);
  if (!(await step(3, `Preparing Confluence space ${DEMO.space.key}`))) return partial();
  const space = await ensureSpace(slots, deps, created);
  await warnIfExisting(3, space);
  if (!(await step(4, 'Saving the checkout service mapping'))) return partial();
  await ensureDemoMapping(deps);

  const issueSpecs = (p: DemoProject) => DEMO_ARTIFACTS.filter((s): s is IssueSpec => s.kind === 'issue' && s.project === p);
  if (!(await step(5, `Creating ${DEMO.pay.key} work items and comments`))) return partial();
  await createIssues(pay, issueSpecs('PAY'), t0, slots, deps, created, types);
  if (!(await createIssueComments('PAY', t0, slots, deps, created))) return partial();

  if (!(await step(6, `Creating ${DEMO.inc.key} customer tickets`))) return partial();
  await createIssues(inc, issueSpecs('INC'), t0, slots, deps, created, types);
  if (!(await createIssueComments('INC', t0, slots, deps, created))) return partial();
  const toClose = issueSpecs('INC').filter((spec) => spec.closeAsCannotReproduce);
  console.info('demo: closing customer tickets', { slots: toClose.map((spec) => spec.slot) });
  for (const spec of toClose) closures.push(await closeOnce(spec.slot, DEMO.cannotReproduce, slots, deps));

  if (!(await step(7, `Creating ${DEMO.space.key} pages and comments`))) return partial();
  if (!(await createPages(space, t0, slots, deps, created))) return partial();

  // The incident comes last so every other artifact is created before it (JQL `created <=` bound of the analysis).
  if (!(await step(8, 'Creating the incident'))) return partial();
  if (!slots.get(INCIDENT_SLOT)) {
    const typeId = await typeIdFor(inc, 'incident', deps, types);
    const issue = await deps.jira.createIssue(inc.artifactKey ?? DEMO.inc.key, typeId, {
      summary: DEMO.incident.summary,
      description: adfParagraphs(DEMO.incident.description),
      labels: [DEMO.label],
    });
    await slots.record({ slot: INCIDENT_SLOT, role: 'incident', source: inc.source, artifactId: issue.id, artifactKey: issue.key, scenarioAt: t0, createdByApp: true });
    created.issues += 1;
    console.info('demo: incident created', { key: issue.key });
  }
  // The incident is resolved, never cancelled: prefer Resolve/Done/Close over Cancel/Reject.
  closures.push(await closeOnce(INCIDENT_SLOT, undefined, slots, deps, true));

  if (!(await step(9, 'Writing the scenario timeline'))) return partial();
  const { events, incidentKey } = await preseed(slots, t0, deps);

  if (!(await step(10, 'Waiting for Jira and Confluence search to index the demo data'))) return { ...partial(), events, incidentKey };
  const indexed = await waitForIndex(slots, deps);
  return { complete: true, created, existing, indexed, incidentKey, events, warnings: warnings(), closures };
}

/** Reset to showcase: forgets the analyses of the demo incident and re-writes the scenario rows (no artifact is recreated). */
export async function resetShowcase(deps: SeedDeps): Promise<DemoRunResult & { incidentKey: string; events: number }> {
  const slots = new Slots(await deps.repo.listDemoArtifacts(), deps);
  const incident = slots.get(INCIDENT_SLOT);
  if (!incident?.artifactKey) throw new SeedError('There is no demo incident yet. Click Load demo data first.');
  await deps.progress(1, 3, 'Removing previous analyses');
  await deps.repo.deleteJobsForIncident(incident.artifactKey);
  await deps.repo.releaseAppLock(analyzeLock(incident.artifactKey));
  await deps.progress(2, 3, 'Writing the scenario timeline');
  const t0 = await scenarioStart(deps);
  const { events } = await preseed(slots, t0, deps);
  await deps.progress(3, 3, 'Done');
  return { complete: true, incidentKey: incident.artifactKey, events };
}

/**
 * Remove demo data: deletes the issues and pages the app created (their comments go with them), their event rows,
 * the demo incident's analyses and the slot rows. Projects, the space and the service mapping stay.
 */
export async function removeDemoData(deps: SeedDeps): Promise<DemoRunResult & { deletedIssues: number; deletedPages: number; kept: number }> {
  const slots = new Slots(await deps.repo.listDemoArtifacts(), deps);
  const incidentKey = slots.get(INCIDENT_SLOT)?.artifactKey ?? null;
  const ref = (a: DemoArtifact): EventRef => ({ source: a.source, artifactId: a.artifactId, commentId: a.commentId });
  const isMarker = (a: DemoArtifact) => a.slot.endsWith(CLOSED_SUFFIX);
  const parents = slots.all().filter((a) => a.createdByApp && a.role !== 'container' && a.commentId === '');
  let deletedIssues = 0;
  let deletedPages = 0;
  const total = parents.length + 1;
  for (const [i, a] of parents.entries()) {
    if (deps.now() >= deps.deadline) return { complete: false, deletedIssues, deletedPages, kept: 0 };
    await deps.progress(i + 1, total, `Deleting demo artifacts (${i + 1}/${parents.length})`);
    if (a.source === 'confluence') {
      await deps.confluence.deletePage(a.artifactId);
      deletedPages += 1;
    } else {
      await deps.jira.deleteIssue(a.artifactKey ?? a.artifactId);
      deletedIssues += 1;
    }
    const children = slots.all().filter((c) => c.slot !== a.slot && c.source === a.source && c.artifactId === a.artifactId && c.role !== 'container');
    await deps.repo.deleteEventsByRefs([a, ...children.filter((c) => !isMarker(c))].map(ref));
    await slots.drop([a.slot, ...children.map((c) => c.slot)]);
  }
  await deps.progress(total, total, 'Cleaning up');
  const rest = slots.all().filter((a) => a.role !== 'container');
  for (const a of rest) if (a.source === 'confluence' && a.commentId !== '') console.warn('demo remove: comment left on a page the app did not create', { slot: a.slot });
  await deps.repo.deleteEventsByRefs(rest.filter((a) => !isMarker(a)).map(ref));
  await slots.drop(rest.map((a) => a.slot));
  if (incidentKey) {
    await deps.repo.deleteJobsForIncident(incidentKey);
    await deps.repo.deleteIncident(incidentKey);
    await deps.repo.releaseAppLock(analyzeLock(incidentKey));
  }
  await deps.repo.setSetting(T0_SETTING, null);
  return { complete: true, deletedIssues, deletedPages, kept: rest.filter((a) => !a.createdByApp && !isMarker(a)).length };
}
