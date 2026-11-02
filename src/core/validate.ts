/** Jira issue key, e.g. INC-1. Project keys start with a letter; Jira allows letters, digits and underscores. */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9][0-9]*$/;

export class InputError extends Error {}

/** Normalises and validates an incident issue key from an action, MCP tool or UI call. */
export function parseIncidentKey(value: unknown): string {
  if (typeof value !== 'string') throw new InputError('incidentKey must be a string, for example INC-1.');
  const key = value.trim().toUpperCase();
  if (!ISSUE_KEY.test(key)) throw new InputError(`incidentKey "${value}" is not a Jira issue key, for example INC-1.`);
  return key;
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
