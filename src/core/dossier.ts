import type { types } from '@forge/teamwork-graph';

/**
 * Teamwork Graph dossier of an analysed incident (pure). One `atlassian:document` per incident with a stable id, so
 * every analysis replaces the previous one. Privacy: only counts and the incident key — no artifact titles, quotes
 * or incident summary — because the object is visible to everyone on the site (the only permission model proven).
 */

/** `settings` key holding the outcome of the last dossier write, shown on the setup page. */
export const DOSSIER_STATUS_KEY = 'dossier_last';
/**
 * Opt-in (default false, no UI yet): write dossiers for every analysed incident, not only the demo incident. The
 * dossier is visible to EVERYONE on the site, so this stays an explicit admin choice (setup UI in week 6).
 */
export const DOSSIER_ALL_INCIDENTS_KEY = 'dossier_all_incidents';
/** `settings` key holding the ids of the demo dossiers written to Teamwork Graph, so Remove demo data can delete them. */
export const DOSSIER_IDS_KEY = 'dossier_ids';
/** Teamwork Graph deletes at most 100 objects per request. */
export const MAX_TRACKED_DOSSIERS = 100;
/** Object type of every dossier (`deleteObjectsByExternalId` needs it). */
export const DOSSIER_OBJECT_TYPE = 'atlassian:document';

/** The tracked id list from `settings` (anything that is not a list of strings counts as empty). */
export function parseDossierIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

/** `ids` plus `id`, without duplicates; the oldest are dropped beyond {@link MAX_TRACKED_DOSSIERS}. */
export function withDossierId(ids: readonly string[], id: string): string[] {
  return [...ids.filter((v) => v !== id), id].slice(-MAX_TRACKED_DOSSIERS);
}

export interface DossierStatus {
  incidentKey: string;
  at: string;
  accepted?: number;
  rejected?: number;
  skipped?: string;
  error?: string;
}

export interface DossierInput {
  incidentKey: string;
  siteUrl: string;
  windowDays: number;
  candidateCount: number;
  /** Days before the incident of the earliest signal (or candidate, before scoring); null when there is none. */
  earliestDaysBefore: number | null;
  /** Scored signals that are not rejected; undefined before scoring finished. */
  signalCount?: number;
  now: Date;
}

export const dossierId = (incidentKey: string): string => `dossier-${incidentKey.toLowerCase()}`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function dossierText(i: Pick<DossierInput, 'incidentKey' | 'windowDays' | 'candidateCount' | 'earliestDaysBefore' | 'signalCount'>): string {
  const window = `in the ${i.windowDays} days before the incident`;
  if (i.signalCount !== undefined) {
    const among = `among ${plural(i.candidateCount, 'candidate', 'candidates')}`;
    if (i.signalCount === 0) return `Hindsight analysed ${i.incidentKey}: no early signals found ${among} ${window}.`;
    const earliestSignal = i.earliestDaysBefore === null ? '' : `; the earliest ${plural(i.earliestDaysBefore, 'day', 'days')} before`;
    return `Hindsight analysed ${i.incidentKey}: ${plural(i.signalCount, 'early signal', 'early signals')} found ${among} ${window}${earliestSignal}. Open the Hindsight panel on ${i.incidentKey} to review them.`;
  }
  if (i.candidateCount === 0) return `Hindsight analysed ${i.incidentKey}: no candidate early signals ${window}.`;
  const earliest = i.earliestDaysBefore === null ? '' : `; the earliest ${plural(i.earliestDaysBefore, 'day', 'days')} before`;
  return `Hindsight analysed ${i.incidentKey}: ${plural(i.candidateCount, 'candidate early signal', 'candidate early signals')} ${window}${earliest}. Open the Hindsight panel on ${i.incidentKey} to review them.`;
}

export function buildDossier(i: DossierInput): types.DocumentObject {
  const at = i.now.toISOString();
  const text = dossierText(i);
  return {
    schemaVersion: '1.0',
    id: dossierId(i.incidentKey),
    updateSequenceNumber: i.now.getTime(),
    displayName: `Early signals for ${i.incidentKey}`,
    description: text,
    url: `${i.siteUrl.replace(/\/+$/, '')}/browse/${i.incidentKey}`,
    createdAt: at,
    lastUpdatedAt: at,
    permissions: [{ accessControls: [{ principals: [{ type: 'EVERYONE' }] }] }],
    'atlassian:document': {
      type: { category: 'DOCUMENT', mimeType: 'text/plain' },
      content: { mimeType: 'text/plain', text },
    },
  };
}
