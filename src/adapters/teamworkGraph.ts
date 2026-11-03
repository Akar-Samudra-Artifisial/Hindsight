import api from '@forge/api';
import { graph, type types } from '@forge/teamwork-graph';

/**
 * Teamwork Graph (Preview). Reads go through `asUser().requestTeamworkGraph()` with the site query context, so they
 * only run from resolvers. Writes go through the `graph:connector` module and `graph.setObjects`, which needs the
 * `connectionId` Atlassian hands to `onConnectionChange`.
 */

/** Operation names must be `<company>_<operation>`; `first` is at most 25. */
export const USER_TEAMS_QUERY = `query hindsight_userTeams($userId: ID!) {
  atlassianUserInTeams(userId: $userId, first: 25) {
    edges { node { __typename ... on AtlassianTeam { id displayName } } }
  }
}`;

/** Proven in the 3 Nov 2026 spike (HTTP 200, paginated via `hasNextPage`). */
export const USER_WORK_ITEMS_QUERY = `query hindsight_userWorkItems($userId: ID!) {
  atlassianUserAssignedJiraWorkItems(userId: $userId, first: 25) {
    edges { node { __typename ... on JiraWorkItem { key summary webUrl status { name } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const userAri = (accountId: string): string => `ari:cloud:identity::user/${accountId}`;
/** Value of the `X-Query-Context` header; without it the endpoint answers `data: null`. */
export const queryContext = (cloudId: string): string => `ari:cloud:platform::site/${cloudId}`;

/** `ari:cloud:jira::site/<cloudId>` (resolver `installContext`) → cloudId. */
export function cloudIdFromInstallContext(installContext: string | undefined): string | undefined {
  const m = /^ari:cloud:[a-z-]+::site\/([0-9a-f-]{8,64})$/i.exec(installContext ?? '');
  return m?.[1];
}

export type GraphResult = { ok: true; status: number; data: unknown } | { ok: false; status: number; error: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

function graphqlError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first: unknown = errors[0];
  const msg = first && typeof first === 'object' ? (first as { message?: unknown }).message : undefined;
  return typeof msg === 'string' ? msg.slice(0, 300) : `${errors.length} GraphQL error(s)`;
}

/**
 * One query as the current user. Never throws: a non-2xx status, a GraphQL error or `data: null` (missing scope or
 * query context) all come back as `ok: false` with the HTTP status (0 when the request itself failed).
 */
export async function runGraphQuery(cloudId: string, query: string, variables: Record<string, unknown>, operationName: string): Promise<GraphResult> {
  let status = 0;
  try {
    const res = await api.asUser().requestTeamworkGraph(query, variables, operationName, undefined, { 'X-Query-Context': queryContext(cloudId) });
    status = res.status;
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) return { ok: false, status, error: graphqlError(body) ?? `HTTP ${status}` };
    const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
    if (data === null || data === undefined) return { ok: false, status, error: graphqlError(body) ?? 'data is null (missing scope or query context?)' };
    const partial = graphqlError(body);
    return { ok: true, status, data: partial ? { ...(data as object), _firstError: partial } : data };
  } catch (err) {
    return { ok: false, status, error: errorText(err) };
  }
}

export interface SpikeRead {
  cloudId: string;
  teams: GraphResult;
  workItems: GraphResult;
}

/** Spike: both reads for the given user. */
export async function readSpike(cloudId: string, accountId: string): Promise<SpikeRead> {
  const variables = { userId: userAri(accountId) };
  const [teams, workItems] = await Promise.all([
    runGraphQuery(cloudId, USER_TEAMS_QUERY, variables, 'hindsight_userTeams'),
    runGraphQuery(cloudId, USER_WORK_ITEMS_QUERY, variables, 'hindsight_userWorkItems'),
  ]);
  return { cloudId, teams, workItems };
}

export const SPIKE_OBJECT_ID = 'hindsight-spike-1';

/** The one test `atlassian:document` written by the spike; visible to everyone on the site. */
export function spikeDocument(siteUrl: string, now: Date): types.DocumentObject {
  const at = now.toISOString();
  return {
    schemaVersion: '1.0',
    id: SPIKE_OBJECT_ID,
    updateSequenceNumber: now.getTime(),
    displayName: 'Hindsight spike signal',
    description: 'Test object written by the Hindsight Teamwork Graph spike.',
    url: `${siteUrl.replace(/\/+$/, '')}/jira`,
    createdAt: at,
    lastUpdatedAt: at,
    permissions: [{ accessControls: [{ principals: [{ type: 'EVERYONE' }] }] }],
    'atlassian:document': {
      type: { category: 'DOCUMENT', mimeType: 'text/plain' },
      content: { mimeType: 'text/plain', text: 'Hindsight spike: an early signal that was seen before an incident.' },
    },
  };
}

export interface WriteSummary {
  success: boolean;
  accepted: number;
  rejected: number;
  error?: string;
  results?: types.BulkObjectResponse['results'];
}

export function summariseWrite(res: types.BulkObjectResponse): WriteSummary {
  return {
    success: res.success,
    accepted: res.results?.accepted?.length ?? 0,
    rejected: res.results?.rejected?.length ?? 0,
    ...(res.error ? { error: res.error } : {}),
    ...(res.results ? { results: res.results } : {}),
  };
}

/** Writes one incident dossier for the connection; never throws. Queue consumers only (no resolver writes). */
export function writeDossier(connectionId: string, doc: types.DocumentObject): Promise<WriteSummary> {
  return writeObjects(connectionId, [doc]);
}

export interface DeleteSummary {
  success: boolean;
  error?: string;
}

/** Deletes objects of one type by their ids (at most 100) for a connection; never throws. Queue consumers only. */
export async function deleteObjects(connectionId: string, objectType: string, ids: readonly string[]): Promise<DeleteSummary> {
  try {
    const res = await graph.deleteObjectsByExternalId({ objectType, externalIds: [...ids], connectionId });
    return { success: res.success, ...(res.error ? { error: res.error } : {}) };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}

/** Writes `objects` for a connection; never throws. */
export async function writeObjects(connectionId: string, objects: types.Object[]): Promise<WriteSummary> {
  try {
    return summariseWrite(await graph.setObjects({ objects, connectionId }));
  } catch (err) {
    return { success: false, accepted: 0, rejected: 0, error: errorText(err) };
  }
}
