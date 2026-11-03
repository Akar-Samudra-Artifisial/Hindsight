/**
 * Scaffold handlers for triggers, queue consumers and the scheduled trigger.
 * Each one only logs for now; the pipeline (collect → score → reach → propose, Sentinel, migrations) comes next.
 */
import api, { route } from '@forge/api';
import { spikeDocument, writeObjects } from '../adapters/teamworkGraph';

type ForgeEvent = Record<string, unknown> | undefined;

const CONNECTION_ACTIONS = new Set(['CREATED', 'UPDATED', 'DELETED']);

export interface ConnectionChange {
  action: 'CREATED' | 'UPDATED' | 'DELETED';
  connectionId: string;
}

/** `onConnectionChange` request (passed directly, not under `payload`) → action + connectionId, or undefined. */
export function parseConnectionChange(event: ForgeEvent): ConnectionChange | undefined {
  const action = typeof event?.['action'] === 'string' ? event['action'].toUpperCase() : '';
  const connectionId = event?.['connectionId'];
  if (!CONNECTION_ACTIONS.has(action) || typeof connectionId !== 'string' || connectionId === '') return undefined;
  return { action: action as ConnectionChange['action'], connectionId };
}

/** Site base URL from Jira `serverInfo`; never throws. */
async function siteBaseUrl(): Promise<string | undefined> {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/serverInfo`);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { baseUrl?: unknown };
    return typeof body.baseUrl === 'string' ? body.baseUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Teamwork Graph spike: logs the connection change (keys only for config, never values) and, when a connection is
 * created or updated, writes one test `atlassian:document` and logs the full result.
 */
export const onConnectionChange = async (event: ForgeEvent): Promise<{ success: boolean; message?: string }> => {
  const change = parseConnectionChange(event);
  const config = event?.['configProperties'];
  console.info('onConnectionChange', {
    keys: Object.keys(event ?? {}),
    action: event?.['action'],
    connectionId: event?.['connectionId'],
    configKeys: config && typeof config === 'object' ? Object.keys(config) : [],
  });
  if (!change) return { success: false, message: 'Unrecognised connection change.' };
  if (change.action === 'DELETED') return { success: true };
  const siteUrl = await siteBaseUrl();
  if (!siteUrl) {
    console.error('onConnectionChange: site URL unavailable, spike object not written');
    return { success: true };
  }
  const result = await writeObjects(change.connectionId, [spikeDocument(siteUrl, new Date())]);
  console.info('onConnectionChange setObjects', JSON.stringify(result));
  return { success: true };
};

const stub = (name: string) => async (event: ForgeEvent): Promise<void> => {
  console.info(`${name}: not implemented yet`, { keys: Object.keys(event ?? {}) });
};

export const onWorkEvent = stub('onWorkEvent');
export const onAppLifecycle = stub('onAppLifecycle');
export const collectEvents = stub('collectEvents');
export const scoreCandidates = stub('scoreCandidates');
export const traceReach = stub('traceReach');
export const proposeRoutesJob = stub('proposeRoutesJob');
export const checkSentinel = stub('checkSentinel');
export const migrateSchema = stub('migrateSchema');
export const demoJob = stub('demoJob');
export const purgeExpired = stub('purgeExpired');
