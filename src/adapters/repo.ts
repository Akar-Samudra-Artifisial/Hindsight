import { randomUUID } from 'node:crypto';
import { execute, query } from './sql';

// --- Column helpers -------------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Forge SQL may return JSON columns as a string or as an already-parsed value. */
export function parseJsonColumn<T>(raw: unknown): T {
  if (typeof raw === 'string') return JSON.parse(raw) as T;
  return raw as T;
}

/** ISO timestamp → MySQL `YYYY-MM-DD HH:MM:SS` (UTC). */
export function toSqlTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${iso}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** MySQL TIMESTAMP (string or Date, UTC) → ISO string; null/undefined stay null. */
export function fromSqlTs(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString();
  const text = String(raw);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? text : d.toISOString();
}

/**
 * Integer for inline `LIMIT`/`OFFSET`: Forge SQL (TiDB) rejects bound LIMIT parameters with `ER_WRONG_ARGUMENTS`.
 * Truncates and clamps to [min, max]; throws on non-finite input so only a number ever reaches the SQL text.
 */
export function sqlInt(n: number, min: number, max: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`sqlInt: expected a finite number, got ${String(n)}`);
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const str = (raw: unknown): string | null => (raw === null || raw === undefined ? null : String(raw));
const int = (raw: unknown): number => (raw === null || raw === undefined ? 0 : Number(raw));
const intOrNull = (raw: unknown): number | null => (raw === null || raw === undefined ? null : Number(raw));
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const tsOrNull = (iso: string | null | undefined): string | null => (iso ? toSqlTs(iso) : null);
const jsonOrNull = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));
const requiredTs = (raw: unknown): string => fromSqlTs(raw) ?? '';

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Max rows per multi-row INSERT. */
export const BATCH_ROWS = 50;
/** Upper bound of candidates read back for ranking. */
export const MAX_RANKED_CANDIDATES = 20_000;

export interface EventRef {
  source: string;
  artifactId: string;
  commentId: string;
}

export const eventRefKey = (r: EventRef): string => `${r.source}|${r.artifactId}|${r.commentId}`;

/** Settings keys are fixed identifiers chosen by the app, never user input. */
export function settingKey(k: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(k)) throw new Error(`Invalid setting key: ${k}`);
  return k;
}

/** Lock names: `<kind>` or `<kind>:<id>`, e.g. `demo`, `job:<uuid>`, `analyze:INC-12`. */
export function lockName(name: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9_.-]{1,95})?$/.test(name)) throw new Error(`Invalid lock name: ${name}`);
  return name;
}

// --- Types ----------------------------------------------------------------------------------------

export type ConnectionAction = 'CREATED' | 'UPDATED' | 'DELETED';
export type ConnectionStatus = 'active' | 'deleted';

export interface GraphConnectionInput {
  connectionId: string;
  name?: string;
  connectorName?: string;
  flowName?: string;
  lastAction: ConnectionAction;
  status: ConnectionStatus;
}

export interface GraphConnection {
  connectionId: string;
  name: string | null;
  connectorName: string | null;
  flowName: string | null;
  lastAction: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceMapping {
  id: string;
  serviceKey: string;
  displayName: string;
  jiraProjectKeys: string[];
  jiraComponentNames: string[];
  confluenceSpaceKeys: string[];
  aliases: string[];
  ownerTeamId: string | null;
  ownerTeamName: string | null;
}

export type ServiceMappingInput = Omit<ServiceMapping, 'id' | 'ownerTeamId' | 'ownerTeamName'> & {
  id?: string;
  ownerTeamId?: string | null;
  ownerTeamName?: string | null;
};

/** Incident as read from Jira; demo-only `scenario_*` columns are never written from here. */
export interface IncidentInput {
  issueKey: string;
  issueId: string;
  projectKey: string;
  summary: string;
  severity?: string | null;
  serviceKey?: string | null;
  serviceSource?: string | null;
  responderTeamId?: string | null;
  responderTeamName?: string | null;
  startedAt: string;
  resolvedAt?: string | null;
  keywords?: unknown;
}

export interface Incident {
  issueKey: string;
  issueId: string;
  projectKey: string;
  summary: string;
  severity: string | null;
  serviceKey: string | null;
  serviceSource: string | null;
  responderTeamId: string | null;
  responderTeamName: string | null;
  startedAt: string;
  resolvedAt: string | null;
  scenarioStartedAt: string | null;
  scenarioResolvedAt: string | null;
  keywords: unknown;
}

export type EventSource = 'jira' | 'jsm' | 'confluence';

/** Collected artifact reference (no artifact text). `scenarioAt` is owned by the demo seed and never written here. */
export interface EventInput {
  id?: string;
  source: EventSource;
  kind: string;
  artifactId: string;
  commentId?: string;
  artifactKey?: string | null;
  title: string;
  url?: string | null;
  projectKey?: string | null;
  spaceKey?: string | null;
  componentNames?: string[] | null;
  labels?: string[] | null;
  serviceKey?: string | null;
  authorAccountId?: string | null;
  occurredAt: string;
  sourceUpdatedAt?: string | null;
  textHash?: string | null;
  textLength?: number;
  replyCount?: number | null;
  statusCategory?: string | null;
  resolutionName?: string | null;
}

export interface StoredEvent {
  id: string;
  source: string;
  kind: string;
  artifactId: string;
  commentId: string;
  artifactKey: string | null;
  title: string;
  url: string | null;
  projectKey: string | null;
  spaceKey: string | null;
  componentNames: string[];
  labels: string[];
  serviceKey: string | null;
  authorAccountId: string | null;
  occurredAt: string;
  sourceUpdatedAt: string | null;
  scenarioAt: string | null;
  textHash: string | null;
  textLength: number;
  replyCount: number | null;
  statusCategory: string | null;
  resolutionName: string | null;
}

export type JobStatus = 'queued' | 'collecting' | 'filtering' | 'scoring' | 'reaching' | 'proposing' | 'done' | 'failed';

export interface JobInput {
  incidentKey: string;
  windowDays: number;
  windowFrom: string;
  windowTo: string;
  scope: unknown;
  progress?: unknown;
  requestedBy?: string | null;
}

export interface AnalysisJob {
  id: string;
  incidentKey: string;
  status: JobStatus;
  windowDays: number;
  windowFrom: string;
  windowTo: string;
  scope: unknown;
  cursor: unknown;
  progress: unknown;
  scannedCount: number;
  storedCount: number;
  candidateCount: number;
  truncatedCount: number;
  attempt: number;
  lastError: string | null;
  requestedBy: string | null;
  modelFast: string | null;
  modelStrong: string | null;
  promptVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobPatch {
  modelFast?: string | null;
  modelStrong?: string | null;
  promptVersion?: string | null;
  status?: JobStatus;
  cursor?: unknown;
  progress?: unknown;
  scannedCount?: number;
  storedCount?: number;
  candidateCount?: number;
  truncatedCount?: number;
  attempt?: number;
  lastError?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export type CandidateStatus = 'kept' | 'truncated' | 'scored' | 'score_failed';

export interface CandidateInput {
  jobId: string;
  incidentKey: string;
  eventId: string;
  filterScore: number;
  reasons: string[];
  matchedKeywords: string[];
  hintType?: string | null;
  excerpt?: string | null;
  textHash?: string | null;
  daysBefore: number;
  status?: CandidateStatus;
}

export interface Candidate {
  id: string;
  jobId: string;
  incidentKey: string;
  eventId: string;
  filterScore: number;
  reasons: string[];
  matchedKeywords: string[];
  hintType: string | null;
  excerpt: string | null;
  textHash: string | null;
  daysBefore: number;
  status: string;
}

export type ScoreError = 'quote_not_found' | 'llm_invalid_output';

export const SIGNAL_TYPES = ['technical_warning', 'customer_complaint', 'external_change', 'unanswered_question'] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];
export type SignalStatus = 'proposed' | 'confirmed' | 'rejected';
export type DecisionKind = 'confirm' | 'reject' | 'undo';

/** A verified signal proposed by scoring; stored with status `proposed`. */
export interface SignalInput {
  jobId: string;
  incidentKey: string;
  eventId: string;
  candidateId: string;
  signalType: SignalType;
  quote: string;
  reason: string;
  confidence: number;
  daysBefore: number;
  textHash: string | null;
  model: string;
  promptVersion: string;
}

export interface Signal extends SignalInput {
  id: string;
  status: SignalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SignalDecisionInput {
  signalId: string;
  incidentKey: string;
  decision: DecisionKind;
  /** accountId of the person who decided; audit only, never returned to the UI or Rovo. */
  decidedBy: string;
  reason?: string | null;
}

export type DemoRole = 'container' | 'incident' | 'signal' | 'context' | 'distractor';

/** One demo artifact slot. Comment rows carry the parent issue/page id in `artifactId` and their own id in `commentId`. */
export interface DemoArtifactInput {
  slot: string;
  role: DemoRole;
  /** Event source of the artifact (`jira`/`jsm`/`confluence`), or `project`/`space` for containers. */
  source: string;
  artifactId: string;
  commentId?: string;
  artifactKey?: string | null;
  url?: string | null;
  scenarioAt?: string | null;
  createdByApp: boolean;
}

export interface DemoArtifact {
  slot: string;
  role: DemoRole;
  source: string;
  artifactId: string;
  commentId: string;
  artifactKey: string | null;
  url: string | null;
  scenarioAt: string | null;
  createdByApp: boolean;
  createdAt: string;
}

/** Pre-seeded event row: the reference columns plus the demo scenario time. */
export interface ScenarioEventInput {
  source: EventSource;
  kind: string;
  artifactId: string;
  commentId: string;
  artifactKey: string | null;
  title: string;
  url: string | null;
  projectKey: string | null;
  spaceKey: string | null;
  occurredAt: string;
  scenarioAt: string;
}

export interface IncidentScenarioInput {
  issueKey: string;
  issueId: string;
  projectKey: string;
  summary: string;
  serviceKey: string;
  startedAt: string;
  scenarioStartedAt: string;
  scenarioResolvedAt: string;
}

// --- Row mappers ----------------------------------------------------------------------------------

const GRAPH_CONNECTION_COLS = 'connection_id, name, connector_name, flow_name, last_action, status, created_at, updated_at';
const SERVICE_MAPPING_COLS =
  'id, service_key, display_name, jira_project_keys, jira_component_names, confluence_space_keys, aliases, owner_team_id, owner_team_name';
const INCIDENT_COLS =
  'issue_key, issue_id, project_key, summary, severity, service_key, service_source, responder_team_id, responder_team_name, started_at, resolved_at, scenario_started_at, scenario_resolved_at, keywords';
/** Event columns written by collect: everything except `scenario_at` and the seen-at defaults. */
const EVENT_WRITE_COLS = [
  'id',
  'source',
  'kind',
  'artifact_id',
  'comment_id',
  'artifact_key',
  'title',
  'url',
  'project_key',
  'space_key',
  'component_names',
  'labels',
  'service_key',
  'author_account_id',
  'occurred_at',
  'source_updated_at',
  'text_hash',
  'text_length',
  'reply_count',
  'status_category',
  'resolution_name',
] as const;
const EVENT_READ_COLS = [...EVENT_WRITE_COLS, 'scenario_at'].join(', ');
const JOB_COLS =
  'id, incident_key, status, window_days, window_from, window_to, scope_json, cursor_json, progress_json, scanned_count, stored_count, candidate_count, truncated_count, attempt, last_error, requested_by, model_fast, model_strong, prompt_version, started_at, finished_at, created_at, updated_at';
const SIGNAL_COLS =
  'id, job_id, incident_key, event_id, candidate_id, signal_type, quote, reason, confidence, status, days_before, text_hash, model, prompt_version, created_at, updated_at';
/** Columns a re-analysis may refresh; only while the signal is still `proposed`. */
const SIGNAL_REFRESH_COLS = ['job_id', 'candidate_id', 'signal_type', 'quote', 'reason', 'confidence', 'days_before', 'text_hash', 'model', 'prompt_version'] as const;
export const MAX_SIGNALS = 500;
const CANDIDATE_COLS =
  'id, job_id, incident_key, event_id, filter_score, reasons, matched_keywords, hint_type, excerpt, text_hash, days_before, status';
const CANDIDATE_WRITE_COLS = CANDIDATE_COLS.split(', ');
const DEMO_ARTIFACT_COLS = 'slot, role, source, artifact_id, comment_id, artifact_key, url, scenario_at, created_by_app, created_at';
const SCENARIO_EVENT_COLS =
  'id, source, kind, artifact_id, comment_id, artifact_key, title, url, project_key, space_key, occurred_at, scenario_at';
export const MAX_DEMO_ARTIFACTS = 500;

function toDemoArtifact(r: Row): DemoArtifact {
  return {
    slot: String(r.slot),
    role: String(r.role) as DemoRole,
    source: String(r.source),
    artifactId: String(r.artifact_id),
    commentId: String(r.comment_id ?? ''),
    artifactKey: str(r.artifact_key),
    url: str(r.url),
    scenarioAt: fromSqlTs(r.scenario_at),
    createdByApp: int(r.created_by_app) === 1,
    createdAt: requiredTs(r.created_at),
  };
}

function toGraphConnection(r: Row): GraphConnection {
  return {
    connectionId: String(r.connection_id),
    name: str(r.name),
    connectorName: str(r.connector_name),
    flowName: str(r.flow_name),
    lastAction: String(r.last_action),
    status: String(r.status),
    createdAt: requiredTs(r.created_at),
    updatedAt: requiredTs(r.updated_at),
  };
}

function toServiceMapping(r: Row): ServiceMapping {
  return {
    id: String(r.id),
    serviceKey: String(r.service_key),
    displayName: String(r.display_name),
    jiraProjectKeys: parseJsonColumn<string[]>(r.jira_project_keys) ?? [],
    jiraComponentNames: parseJsonColumn<string[]>(r.jira_component_names) ?? [],
    confluenceSpaceKeys: parseJsonColumn<string[]>(r.confluence_space_keys) ?? [],
    aliases: parseJsonColumn<string[]>(r.aliases) ?? [],
    ownerTeamId: str(r.owner_team_id),
    ownerTeamName: str(r.owner_team_name),
  };
}

function toIncident(r: Row): Incident {
  return {
    issueKey: String(r.issue_key),
    issueId: String(r.issue_id),
    projectKey: String(r.project_key),
    summary: String(r.summary),
    severity: str(r.severity),
    serviceKey: str(r.service_key),
    serviceSource: str(r.service_source),
    responderTeamId: str(r.responder_team_id),
    responderTeamName: str(r.responder_team_name),
    startedAt: requiredTs(r.started_at),
    resolvedAt: fromSqlTs(r.resolved_at),
    scenarioStartedAt: fromSqlTs(r.scenario_started_at),
    scenarioResolvedAt: fromSqlTs(r.scenario_resolved_at),
    keywords: r.keywords === null || r.keywords === undefined ? null : parseJsonColumn<unknown>(r.keywords),
  };
}

function toEvent(r: Row): StoredEvent {
  return {
    id: String(r.id),
    source: String(r.source),
    kind: String(r.kind),
    artifactId: String(r.artifact_id),
    commentId: String(r.comment_id ?? ''),
    artifactKey: str(r.artifact_key),
    title: String(r.title ?? ''),
    url: str(r.url),
    projectKey: str(r.project_key),
    spaceKey: str(r.space_key),
    componentNames: r.component_names ? parseJsonColumn<string[]>(r.component_names) : [],
    labels: r.labels ? parseJsonColumn<string[]>(r.labels) : [],
    serviceKey: str(r.service_key),
    authorAccountId: str(r.author_account_id),
    occurredAt: requiredTs(r.occurred_at),
    sourceUpdatedAt: fromSqlTs(r.source_updated_at),
    scenarioAt: fromSqlTs(r.scenario_at),
    textHash: str(r.text_hash),
    textLength: int(r.text_length),
    replyCount: intOrNull(r.reply_count),
    statusCategory: str(r.status_category),
    resolutionName: str(r.resolution_name),
  };
}

function toJob(r: Row): AnalysisJob {
  return {
    id: String(r.id),
    incidentKey: String(r.incident_key),
    status: String(r.status) as JobStatus,
    windowDays: int(r.window_days),
    windowFrom: requiredTs(r.window_from),
    windowTo: requiredTs(r.window_to),
    scope: parseJsonColumn<unknown>(r.scope_json),
    cursor: r.cursor_json === null || r.cursor_json === undefined ? null : parseJsonColumn<unknown>(r.cursor_json),
    progress: parseJsonColumn<unknown>(r.progress_json),
    scannedCount: int(r.scanned_count),
    storedCount: int(r.stored_count),
    candidateCount: int(r.candidate_count),
    truncatedCount: int(r.truncated_count),
    attempt: int(r.attempt),
    lastError: str(r.last_error),
    requestedBy: str(r.requested_by),
    modelFast: str(r.model_fast),
    modelStrong: str(r.model_strong),
    promptVersion: str(r.prompt_version),
    startedAt: fromSqlTs(r.started_at),
    finishedAt: fromSqlTs(r.finished_at),
    createdAt: requiredTs(r.created_at),
    updatedAt: requiredTs(r.updated_at),
  };
}

function toCandidate(r: Row): Candidate {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    incidentKey: String(r.incident_key),
    eventId: String(r.event_id),
    filterScore: int(r.filter_score),
    reasons: parseJsonColumn<string[]>(r.reasons) ?? [],
    matchedKeywords: parseJsonColumn<string[]>(r.matched_keywords) ?? [],
    hintType: str(r.hint_type),
    excerpt: str(r.excerpt),
    textHash: str(r.text_hash),
    daysBefore: int(r.days_before),
    status: String(r.status),
  };
}

function toSignal(r: Row): Signal {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    incidentKey: String(r.incident_key),
    eventId: String(r.event_id),
    candidateId: String(r.candidate_id),
    signalType: String(r.signal_type) as SignalType,
    quote: String(r.quote ?? ''),
    reason: String(r.reason ?? ''),
    confidence: Number(r.confidence ?? 0),
    status: String(r.status) as SignalStatus,
    daysBefore: int(r.days_before),
    textHash: str(r.text_hash),
    model: String(r.model ?? ''),
    promptVersion: String(r.prompt_version ?? ''),
    createdAt: requiredTs(r.created_at),
    updatedAt: requiredTs(r.updated_at),
  };
}

function eventParams(e: EventInput): unknown[] {
  return [
    e.id ?? randomUUID(),
    e.source,
    e.kind,
    e.artifactId,
    e.commentId ?? '',
    e.artifactKey ?? null,
    e.title.slice(0, 512),
    e.url ?? null,
    e.projectKey ?? null,
    e.spaceKey ?? null,
    jsonOrNull(e.componentNames),
    jsonOrNull(e.labels),
    e.serviceKey ?? null,
    e.authorAccountId ?? null,
    toSqlTs(e.occurredAt),
    tsOrNull(e.sourceUpdatedAt),
    e.textHash ?? null,
    e.textLength ?? 0,
    e.replyCount ?? null,
    e.statusCategory ?? null,
    e.resolutionName ?? null,
  ];
}

function candidateParams(c: CandidateInput): unknown[] {
  return [
    randomUUID(),
    c.jobId,
    c.incidentKey,
    c.eventId,
    Math.trunc(c.filterScore),
    JSON.stringify(c.reasons),
    JSON.stringify(c.matchedKeywords),
    c.hintType ?? null,
    c.excerpt ? c.excerpt.slice(0, 2000) : null,
    c.textHash ?? null,
    Math.trunc(c.daysBefore),
    c.status ?? 'kept',
  ];
}

/** Job patch field → column + SQL value; only these columns can be updated. */
const JOB_PATCH_COLUMNS: { [K in keyof JobPatch]-?: [column: string, toSql: (v: JobPatch[K]) => unknown] } = {
  modelFast: ['model_fast', (v) => (v ? v.slice(0, 64) : null)],
  modelStrong: ['model_strong', (v) => (v ? v.slice(0, 64) : null)],
  promptVersion: ['prompt_version', (v) => (v ? v.slice(0, 32) : null)],
  status: ['status', (v) => v],
  cursor: ['cursor_json', (v) => jsonOrNull(v)],
  progress: ['progress_json', (v) => JSON.stringify(v ?? {})],
  scannedCount: ['scanned_count', (v) => v],
  storedCount: ['stored_count', (v) => v],
  candidateCount: ['candidate_count', (v) => v],
  truncatedCount: ['truncated_count', (v) => v],
  attempt: ['attempt', (v) => v],
  lastError: ['last_error', (v) => (v ? v.slice(0, 1024) : null)],
  startedAt: ['started_at', (v) => tsOrNull(v)],
  finishedAt: ['finished_at', (v) => tsOrNull(v)],
};

const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['done', 'failed'];
/** Job statuses after a finished collect: its candidates are final. */
export const COLLECTED_JOB_STATUSES: readonly JobStatus[] = ['scoring', 'reaching', 'proposing', 'done'];

// --- Repository -----------------------------------------------------------------------------------

export const repo = {
  // Settings
  async getSetting<T>(k: string): Promise<T | undefined> {
    const rows = await query<Row>('SELECT v FROM settings WHERE k = ?', settingKey(k));
    return rows[0] ? parseJsonColumn<T>(rows[0].v) : undefined;
  },

  async setSetting(k: string, value: unknown): Promise<void> {
    await execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', settingKey(k), JSON.stringify(value));
  },

  // Locks
  /** Takes the named lock for `seconds` when it is free or expired; true when this caller holds it. */
  async acquireAppLock(name: string, nowIso: string, seconds: number): Promise<boolean> {
    const key = lockName(name);
    await execute('INSERT INTO app_locks (name, until_at) VALUES (?, NULL) ON DUPLICATE KEY UPDATE name = name', key);
    const until = toSqlTs(new Date(new Date(nowIso).getTime() + seconds * 1000).toISOString());
    const affected = await execute(
      'UPDATE app_locks SET until_at = ? WHERE name = ? AND (until_at IS NULL OR until_at <= ?)',
      until,
      key,
      toSqlTs(nowIso),
    );
    return affected === 1;
  },

  /** Moves an existing lock's expiry to now + `seconds`; does nothing when the lock row does not exist. */
  async extendAppLock(name: string, nowIso: string, seconds: number): Promise<void> {
    const until = toSqlTs(new Date(new Date(nowIso).getTime() + seconds * 1000).toISOString());
    await execute('UPDATE app_locks SET until_at = ? WHERE name = ?', until, lockName(name));
  },

  async releaseAppLock(name: string): Promise<void> {
    await execute('UPDATE app_locks SET until_at = NULL WHERE name = ?', lockName(name));
  },

  // Teamwork Graph connection
  /** Upserts a connector connection; rows are never deleted (DELETED → status 'deleted') so there is a trail. */
  async saveGraphConnection(c: GraphConnectionInput): Promise<void> {
    await execute(
      `INSERT INTO graph_connection (connection_id, name, connector_name, flow_name, last_action, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name), connector_name = COALESCE(VALUES(connector_name), connector_name),
         flow_name = COALESCE(VALUES(flow_name), flow_name), last_action = VALUES(last_action), status = VALUES(status),
         updated_at = CURRENT_TIMESTAMP`,
      c.connectionId,
      c.name ?? null,
      c.connectorName ?? null,
      c.flowName ?? null,
      c.lastAction,
      c.status,
    );
  },

  async getActiveGraphConnection(): Promise<GraphConnection | undefined> {
    const rows = await query<Row>(
      `SELECT ${GRAPH_CONNECTION_COLS} FROM graph_connection WHERE status = 'active' ORDER BY updated_at DESC, connection_id ASC LIMIT 1`,
    );
    return rows[0] ? toGraphConnection(rows[0]) : undefined;
  },

  // Service mappings
  async listServiceMappings(): Promise<ServiceMapping[]> {
    const rows = await query<Row>(`SELECT ${SERVICE_MAPPING_COLS} FROM service_mappings ORDER BY service_key ASC`);
    return rows.map(toServiceMapping);
  },

  /** Inserts or updates by `service_key`; returns the id of the stored row. */
  async upsertServiceMapping(m: ServiceMappingInput): Promise<string> {
    const id = m.id ?? randomUUID();
    await execute(
      `INSERT INTO service_mappings (${SERVICE_MAPPING_COLS}) VALUES (${placeholders(9)})
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), jira_project_keys = VALUES(jira_project_keys),
         jira_component_names = VALUES(jira_component_names), confluence_space_keys = VALUES(confluence_space_keys),
         aliases = VALUES(aliases), owner_team_id = VALUES(owner_team_id), owner_team_name = VALUES(owner_team_name)`,
      id,
      m.serviceKey,
      m.displayName,
      JSON.stringify(m.jiraProjectKeys),
      JSON.stringify(m.jiraComponentNames),
      JSON.stringify(m.confluenceSpaceKeys),
      JSON.stringify(m.aliases),
      m.ownerTeamId ?? null,
      m.ownerTeamName ?? null,
    );
    const rows = await query<Row>('SELECT id FROM service_mappings WHERE service_key = ?', m.serviceKey);
    return rows[0] ? String(rows[0].id) : id;
  },

  /** Returns affected rows (0 when the service key does not exist). */
  async deleteServiceMapping(serviceKey: string): Promise<number> {
    return execute('DELETE FROM service_mappings WHERE service_key = ?', serviceKey);
  },

  // Demo seed
  async listDemoArtifacts(): Promise<DemoArtifact[]> {
    const rows = await query<Row>(
      `SELECT ${DEMO_ARTIFACT_COLS} FROM demo_artifacts ORDER BY created_at ASC, slot ASC LIMIT ${sqlInt(MAX_DEMO_ARTIFACTS, 1, MAX_DEMO_ARTIFACTS)}`,
    );
    return rows.map(toDemoArtifact);
  },

  async upsertDemoArtifact(a: DemoArtifactInput): Promise<void> {
    await execute(
      `INSERT INTO demo_artifacts (slot, role, source, artifact_id, comment_id, artifact_key, url, scenario_at, created_by_app)
       VALUES (${placeholders(9)})
       ON DUPLICATE KEY UPDATE role = VALUES(role), source = VALUES(source), artifact_id = VALUES(artifact_id),
         comment_id = VALUES(comment_id), artifact_key = VALUES(artifact_key), url = VALUES(url), scenario_at = VALUES(scenario_at),
         created_by_app = VALUES(created_by_app)`,
      a.slot,
      a.role,
      a.source,
      a.artifactId,
      a.commentId ?? '',
      a.artifactKey ?? null,
      a.url ?? null,
      tsOrNull(a.scenarioAt),
      a.createdByApp ? 1 : 0,
    );
  },

  async deleteDemoArtifacts(slots: readonly string[]): Promise<number> {
    let affected = 0;
    for (const batch of chunk(slots, 100)) {
      affected += await execute(`DELETE FROM demo_artifacts WHERE slot IN (${placeholders(batch.length)})`, ...batch);
    }
    return affected;
  },

  /**
   * Inserts demo event rows with their scenario time. An existing row (already collected) only gets `scenario_at`
   * updated; collect fills in the remaining columns later.
   */
  async seedScenarioEvents(rows: readonly ScenarioEventInput[]): Promise<number> {
    const rowPlaceholder = `(${placeholders(12)})`;
    let affected = 0;
    for (const batch of chunk(rows, BATCH_ROWS)) {
      affected += await execute(
        `INSERT INTO events (${SCENARIO_EVENT_COLS}) VALUES ${batch.map(() => rowPlaceholder).join(', ')}
         ON DUPLICATE KEY UPDATE scenario_at = VALUES(scenario_at)`,
        ...batch.flatMap((e) => [
          randomUUID(),
          e.source,
          e.kind,
          e.artifactId,
          e.commentId,
          e.artifactKey,
          e.title.slice(0, 512),
          e.url,
          e.projectKey,
          e.spaceKey,
          toSqlTs(e.occurredAt),
          toSqlTs(e.scenarioAt),
        ]),
      );
    }
    return affected;
  },

  async deleteEventsByRefs(refs: readonly EventRef[]): Promise<number> {
    let affected = 0;
    for (const r of refs) {
      affected += await execute('DELETE FROM events WHERE source = ? AND artifact_id = ? AND comment_id = ?', r.source, r.artifactId, r.commentId);
    }
    return affected;
  },

  /** Inserts the demo incident row (Jira columns + scenario times); on a re-run only the scenario and service change. */
  async seedIncidentScenario(i: IncidentScenarioInput): Promise<void> {
    await execute(
      `INSERT INTO incidents (issue_key, issue_id, project_key, summary, service_key, service_source, started_at, scenario_started_at, scenario_resolved_at)
       VALUES (?, ?, ?, ?, ?, 'property', ?, ?, ?)
       ON DUPLICATE KEY UPDATE service_key = VALUES(service_key), service_source = VALUES(service_source),
         scenario_started_at = VALUES(scenario_started_at), scenario_resolved_at = VALUES(scenario_resolved_at)`,
      i.issueKey,
      i.issueId,
      i.projectKey,
      i.summary.slice(0, 512),
      i.serviceKey,
      toSqlTs(i.startedAt),
      toSqlTs(i.scenarioStartedAt),
      toSqlTs(i.scenarioResolvedAt),
    );
  },

  async deleteIncident(issueKey: string): Promise<number> {
    return execute('DELETE FROM incidents WHERE issue_key = ?', issueKey);
  },

  /**
   * Removes every analysis job of the incident with its candidates, signals and signal decisions (one statement per
   * table). Used by Reset / Remove demo data, so confirmed and rejected decisions go too.
   */
  async deleteJobsForIncident(incidentKey: string): Promise<number> {
    await execute('DELETE FROM signal_decisions WHERE incident_key = ?', incidentKey);
    await execute('DELETE FROM signals WHERE incident_key = ?', incidentKey);
    await execute('DELETE FROM signal_candidates WHERE incident_key = ?', incidentKey);
    return execute('DELETE FROM analysis_jobs WHERE incident_key = ?', incidentKey);
  },

  // Incidents
  /** Upsert from Jira. Never touches `scenario_*`; a missing service/keywords does not erase a stored one. */
  async upsertIncident(i: IncidentInput): Promise<void> {
    await execute(
      `INSERT INTO incidents (issue_key, issue_id, project_key, summary, severity, service_key, service_source,
         responder_team_id, responder_team_name, started_at, resolved_at, keywords)
       VALUES (${placeholders(12)})
       ON DUPLICATE KEY UPDATE issue_id = VALUES(issue_id), project_key = VALUES(project_key), summary = VALUES(summary),
         severity = VALUES(severity), service_key = COALESCE(VALUES(service_key), service_key),
         service_source = COALESCE(VALUES(service_source), service_source), responder_team_id = VALUES(responder_team_id),
         responder_team_name = VALUES(responder_team_name), started_at = VALUES(started_at), resolved_at = VALUES(resolved_at),
         keywords = COALESCE(VALUES(keywords), keywords)`,
      i.issueKey,
      i.issueId,
      i.projectKey,
      i.summary.slice(0, 512),
      i.severity ?? null,
      i.serviceKey ?? null,
      i.serviceSource ?? null,
      i.responderTeamId ?? null,
      i.responderTeamName ?? null,
      toSqlTs(i.startedAt),
      tsOrNull(i.resolvedAt),
      jsonOrNull(i.keywords),
    );
  },

  async getIncident(issueKey: string): Promise<Incident | undefined> {
    const rows = await query<Row>(`SELECT ${INCIDENT_COLS} FROM incidents WHERE issue_key = ?`, issueKey);
    return rows[0] ? toIncident(rows[0]) : undefined;
  },

  // Events
  /**
   * Upserts events in batches of `BATCH_ROWS` on `(source, artifact_id, comment_id)`. Updates every column except
   * `id` and `scenario_at`, so a row pre-seeded by the demo keeps its scenario time. Returns affected rows.
   */
  async upsertEvents(events: readonly EventInput[]): Promise<number> {
    const updates = EVENT_WRITE_COLS.filter((c) => c !== 'id')
      .map((c) => `${c} = VALUES(${c})`)
      .join(', ');
    const rowPlaceholder = `(${placeholders(EVENT_WRITE_COLS.length)})`;
    let affected = 0;
    for (const batch of chunk(events, BATCH_ROWS)) {
      affected += await execute(
        `INSERT INTO events (${EVENT_WRITE_COLS.join(', ')}) VALUES ${batch.map(() => rowPlaceholder).join(', ')} ON DUPLICATE KEY UPDATE ${updates}`,
        ...batch.flatMap(eventParams),
      );
    }
    return affected;
  },

  /**
   * Stored id and demo `scenario_at` per `(source, artifact_id, comment_id)` among `refs`, keyed by `eventRefKey`.
   * Collect reuses the id (candidates point at it) and the scenario time (window check).
   */
  async findEventsByRefs(refs: readonly EventRef[]): Promise<Map<string, { id: string; scenarioAt: string | null }>> {
    const wanted = new Set(refs.map(eventRefKey));
    const found = new Map<string, { id: string; scenarioAt: string | null }>();
    const bySource = new Map<string, string[]>();
    for (const r of refs) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r.artifactId]);
    for (const [source, artifactIds] of bySource) {
      for (const batch of chunk([...new Set(artifactIds)], 100)) {
        const rows = await query<Row>(
          `SELECT id, source, artifact_id, comment_id, scenario_at FROM events WHERE source = ? AND artifact_id IN (${placeholders(batch.length)})`,
          source,
          ...batch,
        );
        for (const r of rows) {
          const key = eventRefKey({ source: String(r.source), artifactId: String(r.artifact_id), commentId: String(r.comment_id ?? '') });
          if (wanted.has(key)) found.set(key, { id: String(r.id), scenarioAt: fromSqlTs(r.scenario_at) });
        }
      }
    }
    return found;
  },

  async getEventsByIds(ids: readonly string[]): Promise<StoredEvent[]> {
    const out: StoredEvent[] = [];
    for (const batch of chunk(ids, 100)) {
      const rows = await query<Row>(`SELECT ${EVENT_READ_COLS} FROM events WHERE id IN (${placeholders(batch.length)})`, ...batch);
      out.push(...rows.map(toEvent));
    }
    return out;
  },

  // Analysis jobs
  async createJob(j: JobInput): Promise<string> {
    const id = randomUUID();
    await execute(
      `INSERT INTO analysis_jobs (id, incident_key, status, window_days, window_from, window_to, scope_json, progress_json, requested_by)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      id,
      j.incidentKey,
      Math.trunc(j.windowDays),
      toSqlTs(j.windowFrom),
      toSqlTs(j.windowTo),
      JSON.stringify(j.scope),
      JSON.stringify(j.progress ?? {}),
      j.requestedBy ?? null,
    );
    return id;
  },

  async getJob(id: string): Promise<AnalysisJob | undefined> {
    const rows = await query<Row>(`SELECT ${JOB_COLS} FROM analysis_jobs WHERE id = ?`, id);
    return rows[0] ? toJob(rows[0]) : undefined;
  },

  /** Updates only the fields present in `patch`; returns affected rows. */
  async updateJob(id: string, patch: JobPatch): Promise<number> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const field of Object.keys(JOB_PATCH_COLUMNS) as (keyof JobPatch)[]) {
      if (!(field in patch)) continue;
      const [column, toSql] = JOB_PATCH_COLUMNS[field] as [string, (v: unknown) => unknown];
      sets.push(`${column} = ?`);
      params.push(toSql(patch[field]));
    }
    if (sets.length === 0) return 0;
    return execute(`UPDATE analysis_jobs SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  },

  async getActiveJobForIncident(incidentKey: string): Promise<AnalysisJob | undefined> {
    const rows = await query<Row>(
      `SELECT ${JOB_COLS} FROM analysis_jobs WHERE incident_key = ? AND status NOT IN (${placeholders(TERMINAL_JOB_STATUSES.length)})
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      incidentKey,
      ...TERMINAL_JOB_STATUSES,
    );
    return rows[0] ? toJob(rows[0]) : undefined;
  },

  /** Most recent job of an incident, whatever its status. */
  async getLatestJobForIncident(incidentKey: string): Promise<AnalysisJob | undefined> {
    const rows = await query<Row>(`SELECT ${JOB_COLS} FROM analysis_jobs WHERE incident_key = ? ORDER BY created_at DESC, id DESC LIMIT 1`, incidentKey);
    return rows[0] ? toJob(rows[0]) : undefined;
  },

  /** Most recent job of an incident whose collect finished (scoring or later); undefined when none. */
  async getLatestCollectedJobForIncident(incidentKey: string): Promise<AnalysisJob | undefined> {
    const rows = await query<Row>(
      `SELECT ${JOB_COLS} FROM analysis_jobs WHERE incident_key = ? AND status IN (${placeholders(COLLECTED_JOB_STATUSES.length)})
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      incidentKey,
      ...COLLECTED_JOB_STATUSES,
    );
    return rows[0] ? toJob(rows[0]) : undefined;
  },

  // Signal candidates
  /** Inserts candidates in batches; a duplicate `(job_id, event_id)` keeps the first row. Returns affected rows. */
  async insertCandidates(candidates: readonly CandidateInput[]): Promise<number> {
    const rowPlaceholder = `(${placeholders(CANDIDATE_WRITE_COLS.length)})`;
    let affected = 0;
    for (const batch of chunk(candidates, BATCH_ROWS)) {
      affected += await execute(
        `INSERT INTO signal_candidates (${CANDIDATE_COLS}) VALUES ${batch.map(() => rowPlaceholder).join(', ')} ON DUPLICATE KEY UPDATE id = id`,
        ...batch.flatMap(candidateParams),
      );
    }
    return affected;
  },

  /** Kept candidates of a job, best first (score, then oldest, then event id for a stable order). */
  async listKeptCandidates(jobId: string, limit = 200): Promise<Candidate[]> {
    const rows = await query<Row>(
      `SELECT ${CANDIDATE_COLS} FROM signal_candidates WHERE job_id = ? AND status = 'kept'
       ORDER BY filter_score DESC, days_before DESC, event_id ASC LIMIT ${sqlInt(limit, 1, 500)}`,
      jobId,
    );
    return rows.map(toCandidate);
  },

  /** Ranking fields of every candidate of a job (for the final top-N cut); capped at `MAX_RANKED_CANDIDATES`. */
  async listCandidateRanks(jobId: string): Promise<{ id: string; eventId: string; filterScore: number; daysBefore: number }[]> {
    const rows = await query<Row>(
      `SELECT id, event_id, filter_score, days_before FROM signal_candidates WHERE job_id = ?
       ORDER BY filter_score DESC, days_before DESC, event_id ASC LIMIT ${sqlInt(MAX_RANKED_CANDIDATES, 1, MAX_RANKED_CANDIDATES)}`,
      jobId,
    );
    return rows.map((r) => ({ id: String(r.id), eventId: String(r.event_id), filterScore: int(r.filter_score), daysBefore: int(r.days_before) }));
  },

  async countCandidates(jobId: string): Promise<number> {
    const rows = await query<Row>('SELECT COUNT(*) AS n FROM signal_candidates WHERE job_id = ?', jobId);
    return rows[0] ? int(rows[0].n) : 0;
  },

  /** Number of candidates of a job per status (`kept`, `truncated`, `scored`, `score_failed`). */
  async candidateStatusCounts(jobId: string): Promise<Record<string, number>> {
    const rows = await query<Row>('SELECT status, COUNT(*) AS n FROM signal_candidates WHERE job_id = ? GROUP BY status', jobId);
    return Object.fromEntries(rows.map((r) => [String(r.status), int(r.n)]));
  },

  /** Sets the scoring outcome of candidates of a job (`scored`, or `score_failed` with its reason). */
  async markCandidates(jobId: string, ids: readonly string[], status: 'scored' | 'score_failed', scoreError: ScoreError | null): Promise<number> {
    let affected = 0;
    for (const batch of chunk(ids, 100)) {
      affected += await execute(
        `UPDATE signal_candidates SET status = ?, score_error = ? WHERE job_id = ? AND id IN (${placeholders(batch.length)})`,
        status,
        scoreError,
        jobId,
        ...batch,
      );
    }
    return affected;
  },

  // Signals
  /**
   * Inserts signals on `(incident_key, event_id)`. A duplicate is refreshed only while it is `proposed`: a confirmed
   * or rejected signal keeps its quote, type and status. Returns affected rows.
   */
  async upsertSignals(signals: readonly SignalInput[]): Promise<number> {
    const updates = SIGNAL_REFRESH_COLS.map((c) => `${c} = IF(status = 'proposed', VALUES(${c}), ${c})`).join(', ');
    const rowPlaceholder = `(${placeholders(14)})`;
    let affected = 0;
    for (const batch of chunk(signals, BATCH_ROWS)) {
      affected += await execute(
        `INSERT INTO signals (id, job_id, incident_key, event_id, candidate_id, signal_type, quote, reason, confidence, status, days_before, text_hash, model, prompt_version)
         VALUES ${batch.map(() => rowPlaceholder).join(', ')} ON DUPLICATE KEY UPDATE ${updates}`,
        ...batch.flatMap((s) => [
          randomUUID(),
          s.jobId,
          s.incidentKey,
          s.eventId,
          s.candidateId,
          s.signalType,
          s.quote.slice(0, 300),
          s.reason.slice(0, 255),
          Math.min(1, Math.max(0, s.confidence)),
          'proposed',
          Math.trunc(s.daysBefore),
          s.textHash,
          s.model.slice(0, 64),
          s.promptVersion.slice(0, 32),
        ]),
      );
    }
    return affected;
  },

  /** Signals of an incident (every status), earliest first; capped at `MAX_SIGNALS`. */
  async listSignalsForIncident(incidentKey: string, limit = MAX_SIGNALS): Promise<Signal[]> {
    const rows = await query<Row>(
      `SELECT ${SIGNAL_COLS} FROM signals WHERE incident_key = ? ORDER BY days_before DESC, id ASC LIMIT ${sqlInt(limit, 1, MAX_SIGNALS)}`,
      incidentKey,
    );
    return rows.map(toSignal);
  },

  async getSignal(id: string): Promise<Signal | undefined> {
    const rows = await query<Row>(`SELECT ${SIGNAL_COLS} FROM signals WHERE id = ?`, id);
    return rows[0] ? toSignal(rows[0]) : undefined;
  },

  /** Compare-and-set status change; returns 1 when the signal was still `from`, else 0. */
  async updateSignalStatus(id: string, from: SignalStatus, to: SignalStatus): Promise<number> {
    return execute('UPDATE signals SET status = ? WHERE id = ? AND status = ?', to, id, from);
  },

  /**
   * Drops proposed signals that `job` did not propose again, with their decision history. Only signals of jobs created
   * strictly before `job` qualify (a newer, parallel analysis is never touched), and an event whose candidate failed
   * scoring in `job` keeps its earlier signal. Decisions first, then signals; returns the deleted signals.
   */
  async deleteStaleProposedSignals(incidentKey: string, job: { id: string; createdAt: string }): Promise<number> {
    const where = `incident_key = ? AND status = 'proposed' AND job_id <> ?
      AND job_id IN (SELECT id FROM analysis_jobs WHERE incident_key = ? AND created_at < ?)
      AND event_id NOT IN (SELECT event_id FROM signal_candidates WHERE job_id = ? AND status = 'score_failed')`;
    const params = [incidentKey, job.id, incidentKey, toSqlTs(job.createdAt), job.id];
    await execute(`DELETE FROM signal_decisions WHERE incident_key = ? AND signal_id IN (SELECT id FROM signals WHERE ${where})`, incidentKey, ...params);
    return execute(`DELETE FROM signals WHERE ${where}`, ...params);
  },

  /** Failed candidates of a job per `score_error` (`quote_not_found`, `llm_invalid_output`). */
  async scoreErrorCounts(jobId: string): Promise<Record<string, number>> {
    const rows = await query<Row>(
      "SELECT score_error, COUNT(*) AS n FROM signal_candidates WHERE job_id = ? AND status = 'score_failed' GROUP BY score_error",
      jobId,
    );
    return Object.fromEntries(rows.map((r) => [String(r.score_error ?? 'unknown'), int(r.n)]));
  },

  async insertDecision(d: SignalDecisionInput): Promise<void> {
    await execute(
      'INSERT INTO signal_decisions (id, signal_id, incident_key, decision, decided_by, reason) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(),
      d.signalId,
      d.incidentKey,
      d.decision,
      d.decidedBy.slice(0, 128),
      d.reason ? d.reason.slice(0, 255) : null,
    );
  },

  async markCandidatesTruncated(jobId: string, ids: readonly string[]): Promise<number> {
    let affected = 0;
    for (const batch of chunk(ids, 100)) {
      affected += await execute(
        `UPDATE signal_candidates SET status = 'truncated' WHERE job_id = ? AND id IN (${placeholders(batch.length)})`,
        jobId,
        ...batch,
      );
    }
    return affected;
  },
};

export type Repo = typeof repo;
