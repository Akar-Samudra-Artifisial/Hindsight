import type { RawIssue } from '../adapters/jira';
import type { AnalysisJob, Incident, IncidentInput, JobInput, JobPatch, JobStatus, ServiceMapping } from '../adapters/repo';
import { buildScope, type Scope } from './scope';
import { adfToText, normaliseText } from './text';
import { InputError } from './validate';

/** Analysis job state machine and the start of a job (shared by the incident panel and, later, the Rovo action). */

export const ANALYZE_LOCK_SECONDS = 20 * 60;
export const ISSUE_PROPERTY = 'hindsight';

const NEXT: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['collecting', 'failed'],
  collecting: ['filtering', 'failed'],
  filtering: ['scoring', 'failed'],
  scoring: ['reaching', 'failed'],
  reaching: ['proposing', 'failed'],
  proposing: ['done', 'failed'],
  done: [],
  failed: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return NEXT[from].includes(to);
}

export const isTerminal = (s: JobStatus): boolean => s === 'done' || s === 'failed';
export const analyzeLock = (incidentKey: string): string => `analyze:${incidentKey}`;

export interface StartDeps {
  getIncidentAsUser(key: string): Promise<RawIssue | undefined>;
  getIssueProperty(key: string, property: string): Promise<unknown>;
  repo: {
    getIncident(key: string): Promise<Incident | undefined>;
    upsertIncident(i: IncidentInput): Promise<void>;
    listServiceMappings(): Promise<ServiceMapping[]>;
    getSetting<T>(k: string): Promise<T | undefined>;
    acquireAppLock(name: string, nowIso: string, seconds: number): Promise<boolean>;
    releaseAppLock(name: string): Promise<void>;
    getActiveJobForIncident(key: string): Promise<AnalysisJob | undefined>;
    createJob(j: JobInput): Promise<string>;
    updateJob(id: string, patch: JobPatch): Promise<number>;
  };
  pushCollect(body: { jobId: string; attempt: number }): Promise<void>;
  now(): number;
}

export type StartResult = { status: 'started'; jobId: string; limited: boolean } | { status: 'running'; jobId: string | null };

const stringList = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []);

/** `{serviceKey}` from the `hindsight` issue property (written by the demo seed). */
export function propertyServiceKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const key = (value as { serviceKey?: unknown }).serviceKey;
  return typeof key === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : null;
}

/**
 * Starts an analysis: the user must see the incident (asUser), the incident is upserted (demo `scenario_*` untouched),
 * a 20-minute `analyze:<key>` lock prevents duplicates (the running job is returned instead), then the job is queued.
 */
export async function startAnalysis(incidentKey: string, windowDays: number, requestedBy: string | null, deps: StartDeps): Promise<StartResult> {
  const issue = await deps.getIncidentAsUser(incidentKey);
  const f = issue?.fields;
  if (!issue || !f?.created) throw new InputError(`Incident ${incidentKey} was not found, or you do not have permission to view it.`);

  const [property, stored, mappings, excludedProjects, excludedSpaces] = await Promise.all([
    deps.getIssueProperty(incidentKey, ISSUE_PROPERTY).catch(() => undefined),
    deps.repo.getIncident(incidentKey),
    deps.repo.listServiceMappings(),
    deps.repo.getSetting<unknown>('excluded_project_keys'),
    deps.repo.getSetting<unknown>('excluded_space_keys'),
  ]);
  const projectKey = f.project?.key ?? incidentKey.split('-')[0] ?? '';
  const startedAt = new Date(f.created).toISOString();
  const scope: Scope = buildScope(
    {
      issueKey: incidentKey,
      projectKey,
      summary: f.summary ?? '',
      description: normaliseText(adfToText(f.description)),
      componentNames: (f.components ?? []).flatMap((c) => (c.name ? [c.name] : [])),
      startedAt,
      scenarioStartedAt: stored?.scenarioStartedAt ?? null,
      propertyServiceKey: propertyServiceKey(property),
      manualServiceKey: stored?.serviceSource === 'manual' || stored?.serviceSource === null ? (stored?.serviceKey ?? null) : null,
    },
    mappings,
    { excludedProjectKeys: stringList(excludedProjects), excludedSpaceKeys: stringList(excludedSpaces) },
    windowDays,
  );

  await deps.repo.upsertIncident({
    issueKey: incidentKey,
    issueId: String(issue.id),
    projectKey,
    summary: f.summary ?? '',
    severity: f.priority?.name ?? null,
    // A manual choice stays as it is; property/component matches are recorded with their source.
    serviceKey: scope.serviceSource && scope.serviceSource !== 'manual' ? scope.serviceKey : null,
    serviceSource: scope.serviceSource && scope.serviceSource !== 'manual' ? scope.serviceSource : null,
    startedAt,
    resolvedAt: f.resolutiondate ? new Date(f.resolutiondate).toISOString() : null,
    keywords: scope.keywords,
  });

  const lock = analyzeLock(incidentKey);
  const nowIso = new Date(deps.now()).toISOString();
  if (!(await deps.repo.acquireAppLock(lock, nowIso, ANALYZE_LOCK_SECONDS))) {
    const active = await deps.repo.getActiveJobForIncident(incidentKey);
    return { status: 'running', jobId: active?.id ?? null };
  }
  let jobId: string | undefined;
  try {
    jobId = await deps.repo.createJob({
      incidentKey,
      windowDays,
      windowFrom: scope.windowFrom,
      windowTo: scope.windowTo,
      scope,
      progress: {},
      requestedBy,
    });
    await deps.pushCollect({ jobId, attempt: 1 });
    return { status: 'started', jobId, limited: scope.limited };
  } catch (err) {
    // A job that was created but never queued would show as running forever.
    if (jobId) {
      const message = `Could not queue the analysis: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1024);
      await deps.repo.updateJob(jobId, { status: 'failed', lastError: message, finishedAt: new Date(deps.now()).toISOString() }).catch(() => 0);
    }
    await deps.repo.releaseAppLock(lock);
    throw err;
  }
}
