/** Jira issue key, e.g. INC-1. Project keys start with a letter; Jira allows letters, digits and underscores. */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9][0-9]*$/;
/** Jira project key; whitelisted before it is quoted into JQL. */
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,254}$/;
/** Confluence space key (personal spaces start with `~`); whitelisted before it is quoted into CQL. */
export const SPACE_KEY = /^~?[A-Za-z0-9_-]{1,255}$/;
/** Service key of a mapping (also accepted from the `hindsight` issue property). */
export const SERVICE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

export class InputError extends Error {}

/** Normalises and validates an incident issue key from an action, MCP tool or UI call. */
export function parseIncidentKey(value: unknown): string {
  if (typeof value !== 'string') throw new InputError('incidentKey must be a string, for example INC-1.');
  const key = value.trim().toUpperCase();
  if (!ISSUE_KEY.test(key)) throw new InputError(`incidentKey "${value}" is not a Jira issue key, for example INC-1.`);
  return key;
}

const SIGNAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Signal id from the panel or a Rovo action. */
export function parseSignalId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!SIGNAL_ID.test(id)) throw new InputError('signalId must be a signal id returned by Find prior signals.');
  return id.toLowerCase();
}

/** Route id from the panel or a Rovo action. */
export function parseRouteId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!SIGNAL_ID.test(id)) throw new InputError('routeId must be a route id returned by Propose routes.');
  return id.toLowerCase();
}

/** Sentinel alert id from the Routes tab. */
export function parseAlertId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!SIGNAL_ID.test(id)) throw new InputError('alertId must be an alert id shown on the Routes tab.');
  return id.toLowerCase();
}

/** `useful` or `not_useful`. */
export function parseAlertFeedback(value: unknown): 'useful' | 'not_useful' {
  if (value === 'useful' || value === 'not_useful') return value;
  throw new InputError('feedback must be useful or not_useful.');
}

/** Target of a route decision from the panel: `active` (approve or resume) or `paused`; absent means `active`. */
export function parseRouteTarget(value: unknown): 'active' | 'paused' {
  if (value === undefined || value === null || value === '' || value === 'active') return 'active';
  if (value === 'paused') return 'paused';
  throw new InputError('status must be active or paused.');
}

/** Sentinel weekly cap per team from the setup page: a whole number in [1, max]. */
export function parseWeeklyCapInput(value: unknown, max: number): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9]+$/.test(text)) throw new InputError('The weekly cap must be a whole number.');
  const n = Number(text);
  if (n < 1 || n > max) throw new InputError(`The weekly cap must be between 1 and ${max}.`);
  return n;
}

/** Optional signal id: absent or empty → undefined. */
export function parseOptionalSignalId(value: unknown): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  return parseSignalId(value);
}

/** `confirm`, `reject` or `undo` (case-insensitive). */
export function parseDecision(value: unknown): 'confirm' | 'reject' | 'undo' {
  const d = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (d === 'confirm' || d === 'reject' || d === 'undo') return d;
  throw new InputError('decision must be confirm, reject or undo.');
}

export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 180;

/** Rovo passes numbers as strings. Returns an integer in [1, MAX_WINDOW_DAYS]; missing means the default. */
export function parseWindowDays(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_WINDOW_DAYS;
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9]+$/.test(text)) throw new InputError(`windowDays "${String(value)}" must be a whole number of days.`);
  const days = Number(text);
  if (days < 1 || days > MAX_WINDOW_DAYS) throw new InputError(`windowDays must be between 1 and ${MAX_WINDOW_DAYS}.`);
  return days;
}

export const MAX_SERVICE_MAPPINGS = 50;
export const MAX_MAPPING_LIST_ITEMS = 20;
const MAX_NAME = 255;
const MAX_ALIAS = 64;

export interface ParsedServiceMapping {
  serviceKey: string;
  displayName: string;
  jiraProjectKeys: string[];
  jiraComponentNames: string[];
  confluenceSpaceKeys: string[];
  aliases: string[];
  ownerTeamName: string | null;
  ownerTeamId: string | null;
}

export function parseServiceKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!SERVICE_KEY.test(key)) throw new InputError('Service key must be 1–64 letters, digits, ".", "_" or "-".');
  return key;
}

/** A list from an array of strings or one comma-separated string; trimmed, empty items dropped, duplicates removed. */
function textList(value: unknown, field: string): string[] {
  if (value === undefined || value === null || value === '') return [];
  const raw = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : null;
  if (!raw || !raw.every((v) => typeof v === 'string')) throw new InputError(`${field} must be a list of text values.`);
  const items = [...new Set((raw as string[]).map((v) => v.trim()).filter((v) => v !== ''))];
  if (items.length > MAX_MAPPING_LIST_ITEMS) throw new InputError(`${field} accepts at most ${MAX_MAPPING_LIST_ITEMS} values.`);
  return items;
}

function optionalName(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InputError(`${field} must be text.`);
  const text = value.trim();
  if (text.length > MAX_NAME) throw new InputError(`${field} must be at most ${MAX_NAME} characters.`);
  return text === '' ? null : text;
}

/** Validates a service mapping sent by the setup page. Project keys are upper-cased; every list is capped. */
export function parseServiceMapping(raw: unknown): ParsedServiceMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('Service mapping must be an object.');
  const m = raw as Record<string, unknown>;
  const serviceKey = parseServiceKey(m['serviceKey']);
  const displayName = typeof m['displayName'] === 'string' ? m['displayName'].trim() : '';
  if (displayName === '' || displayName.length > MAX_NAME) throw new InputError(`Display name is required (at most ${MAX_NAME} characters).`);
  const jiraProjectKeys = [...new Set(textList(m['jiraProjectKeys'], 'Jira project keys').map((k) => k.toUpperCase()))];
  const badProject = jiraProjectKeys.find((k) => !PROJECT_KEY.test(k));
  if (badProject) throw new InputError(`"${badProject}" is not a Jira project key.`);
  const confluenceSpaceKeys = textList(m['confluenceSpaceKeys'], 'Confluence space keys');
  const badSpace = confluenceSpaceKeys.find((k) => !SPACE_KEY.test(k));
  if (badSpace) throw new InputError(`"${badSpace}" is not a Confluence space key.`);
  const jiraComponentNames = textList(m['jiraComponentNames'], 'Jira component names');
  if (jiraComponentNames.some((c) => c.length > MAX_NAME)) throw new InputError(`Component names must be at most ${MAX_NAME} characters.`);
  const aliases = textList(m['aliases'], 'Aliases');
  if (aliases.some((a) => a.length > MAX_ALIAS)) throw new InputError(`Aliases must be at most ${MAX_ALIAS} characters.`);
  return {
    serviceKey,
    displayName,
    jiraProjectKeys,
    jiraComponentNames,
    confluenceSpaceKeys,
    aliases,
    ownerTeamName: optionalName(m['ownerTeamName'], 'Owner team name'),
    // [VERIFY] format of a team id (ARI or UUID); only length-checked for now.
    ownerTeamId: optionalName(m['ownerTeamId'], 'Owner team id'),
  };
}

export type DemoKind = 'load' | 'reset' | 'remove';
const DEMO_KINDS: readonly DemoKind[] = ['load', 'reset', 'remove'];

export function parseDemoKind(value: unknown): DemoKind {
  if (typeof value === 'string' && (DEMO_KINDS as readonly string[]).includes(value)) return value as DemoKind;
  throw new InputError('kind must be load, reset or remove.');
}
