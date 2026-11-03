import type { AdfDoc } from '../adapters/jira';
import type { Alert, AlertArtifactKind, Route } from '../adapters/repo';
import { stems } from './keywords';
import { escapeXml } from './xml';

/**
 * Sentinel (pure, deterministic, no LLM). When a new issue, comment or page appears in the source of an `active`
 * route and its text contains the route's keywords, the owner team gets one blameless heads-up comment on that
 * artifact. Loop guards: manifest `ignoreSelf` (Jira), `selfGenerated` / known app accounts in the trigger handler,
 * app author in the consumer, lifetime dedup per route and artifact (comment), a weekly cap per team and a daily
 * cap overall.
 */

export const SENTINEL_QUEUE = 'sentinel';
export const SENTINEL_MARKER = '[Hindsight Sentinel]';
export const SENTINEL_WEEKLY_CAP_KEY = 'sentinel_weekly_cap';
export const DEFAULT_WEEKLY_CAP = 50;
export const MAX_WEEKLY_CAP = 1000;
/** Global throttle: alerts (posted or in flight) across all teams per rolling 24 h. */
export const SENTINEL_DAILY_CAP_KEY = 'sentinel_daily_cap';
export const DEFAULT_DAILY_CAP = 200;
export const MAX_DAILY_CAP = 5000;
/** 429: at most this many deliveries, 60 s apart. */
export const MAX_SENTINEL_ATTEMPTS = 3;
/**
 * A Confluence comment the search index does not have yet (v2 comment reads need a scope the app lacks): re-queued
 * after these delays, ~10.5 min in all (indexing was measured at 2–7 min). Delay `i` follows attempt `i + 1`.
 */
export const NOT_INDEXED_DELAYS_SECONDS = [60, 90, 120, 120, 120, 120] as const;
/** Delay before the next delivery of a not-yet-indexed artifact after `attempt`; null once the window is used up. */
export function notIndexedDelay(attempt: number): number | null {
  return NOT_INDEXED_DELAYS_SECONDS[attempt - 1] ?? null;
}
/**
 * One retry chain per artifact: the first delivery (attempt 1) holds this lock until the chain ends, so a second
 * attempt-1 delivery (the provider notice's backup copy, or a repeated product event) does not start a parallel chain.
 * Longer than the whole not-indexed window plus processing.
 */
export const SENTINEL_CHAIN_SECONDS = 15 * 60;
export const sentinelChainLock = (b: Pick<SentinelBody, 'source' | 'artifactId' | 'commentId'>): string =>
  `sentinel-chain:${b.source}.${b.artifactId || '0'}.${b.commentId || '0'}`;
/** A failed post (other than a rate limit, which the queue retries) is retried at most once per hour… */
export const FAILED_BACKOFF_MS = 3600_000;
/** …and at most this many failed posts are recorded per route and artifact (comment). */
export const MAX_FAILED_POSTS = 3;

export type WorkSource = 'jira' | 'confluence';

/** One Jira/Confluence trigger event, reduced to ids and keys (no text, no account ids are queued). */
export interface WorkEvent {
  source: WorkSource;
  kind: AlertArtifactKind;
  /** Issue or page id; '' for a Confluence comment (its page is resolved by the consumer). */
  artifactId: string;
  /** Comment id, '' unless `kind` is `comment`. */
  commentId: string;
  eventType: string;
  projectKey: string | null;
  spaceKey: string | null;
  /** Account that caused the event; only used for the app-account check, never stored or queued. */
  actorId: string | null;
  selfGenerated: boolean;
}

/** Body of a `sentinel` queue event. */
export interface SentinelBody {
  v: 1;
  source: WorkSource;
  kind: AlertArtifactKind;
  artifactId: string;
  commentId: string;
  eventType: string;
  attempt: number;
}

const ID = /^[0-9]{1,18}$/;
const EVENT_TYPE = /^avi:(jira|confluence):[a-z_]+:[a-z_]+$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const idOf = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v : '';
  return ID.test(s) ? s : null;
};
const textOf = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);

/** Forge product event → `WorkEvent`; undefined for an event Sentinel does not handle. */
export function parseWorkEvent(event: unknown): WorkEvent | undefined {
  const e = obj(event);
  const eventType = typeof e?.['eventType'] === 'string' ? e['eventType'] : '';
  if (!e || !EVENT_TYPE.test(eventType)) return undefined;
  const actorId = textOf(e['atlassianId'], 128);
  const selfGenerated = e['selfGenerated'] === true;
  if (eventType === 'avi:jira:created:issue' || eventType === 'avi:jira:commented:issue') {
    const issue = obj(e['issue']);
    const issueId = idOf(issue?.['id']);
    if (!issueId) return undefined;
    const projectKey = textOf(obj(obj(issue?.['fields'])?.['project'])?.['key'], 255);
    if (eventType === 'avi:jira:created:issue') {
      return { source: 'jira', kind: 'issue', artifactId: issueId, commentId: '', eventType, projectKey, spaceKey: null, actorId, selfGenerated };
    }
    const commentId = idOf(obj(e['comment'])?.['id']);
    if (!commentId) return undefined;
    return { source: 'jira', kind: 'comment', artifactId: issueId, commentId, eventType, projectKey, spaceKey: null, actorId, selfGenerated };
  }
  if (eventType === 'avi:confluence:created:page' || eventType === 'avi:confluence:updated:page' || eventType === 'avi:confluence:created:comment') {
    const content = obj(e['content']);
    const contentId = idOf(content?.['id']);
    if (!contentId) return undefined;
    const spaceKey = textOf(obj(content?.['space'])?.['key'], 255);
    if (eventType === 'avi:confluence:created:comment') {
      return { source: 'confluence', kind: 'comment', artifactId: '', commentId: contentId, eventType, projectKey: null, spaceKey, actorId, selfGenerated };
    }
    return { source: 'confluence', kind: 'page', artifactId: contentId, commentId: '', eventType, projectKey: null, spaceKey, actorId, selfGenerated };
  }
  return undefined;
}

export function sentinelBody(e: WorkEvent, attempt = 1): SentinelBody {
  return { v: 1, source: e.source, kind: e.kind, artifactId: e.artifactId, commentId: e.commentId, eventType: e.eventType, attempt };
}

/** Validates a queued body; throws on anything that was not produced by `sentinelBody`. */
export function parseSentinelBody(raw: unknown): SentinelBody {
  const b = obj(raw);
  const source = b?.['source'];
  const kind = b?.['kind'];
  const artifactId = b?.['artifactId'];
  const commentId = b?.['commentId'];
  const eventType = b?.['eventType'];
  if (b?.['v'] !== 1 || (source !== 'jira' && source !== 'confluence')) throw new Error('sentinel event body has no valid source');
  if (kind !== 'issue' && kind !== 'comment' && kind !== 'page') throw new Error('sentinel event body has no valid kind');
  if (typeof artifactId !== 'string' || (artifactId !== '' && !ID.test(artifactId))) throw new Error('sentinel event body.artifactId must be a numeric id');
  if (typeof commentId !== 'string' || (commentId !== '' && !ID.test(commentId))) throw new Error('sentinel event body.commentId must be a numeric id');
  if ((kind === 'comment') !== (commentId !== '')) throw new Error('sentinel event body.commentId is required for comments only');
  if (artifactId === '' && !(source === 'confluence' && kind === 'comment')) throw new Error('sentinel event body.artifactId is required');
  if (typeof eventType !== 'string' || !EVENT_TYPE.test(eventType)) throw new Error('sentinel event body.eventType is invalid');
  const a = b['attempt'];
  const attempt = typeof a === 'number' && Number.isInteger(a) && a > 0 ? a : 1;
  return { v: 1, source, kind, artifactId, commentId, eventType, attempt };
}

/** Lock name of one artifact (comment) for the consumer. */
export const sentinelLock = (b: Pick<SentinelBody, 'source' | 'artifactId' | 'commentId'>): string =>
  `sentinel:${b.source}.${b.artifactId || '0'}.${b.commentId || '0'}`;

/** Where an artifact lives, for matching against a route source. */
export interface ArtifactPlace {
  source: WorkSource;
  projectKey: string | null;
  spaceKey: string | null;
  componentNames: readonly string[];
  labels: readonly string[];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function routeMatchesSource(route: Pick<Route, 'sourceType' | 'sourceKey'>, place: ArtifactPlace): boolean {
  switch (route.sourceType) {
    case 'confluence_space':
      return place.source === 'confluence' && place.spaceKey !== null && place.spaceKey === route.sourceKey;
    case 'jira_project':
      return place.source === 'jira' && place.projectKey !== null && place.projectKey === route.sourceKey;
    case 'jira_component':
      return place.source === 'jira' && place.componentNames.some((c) => same(c, route.sourceKey));
    case 'jira_label':
      return place.source === 'jira' && place.labels.some((l) => same(l, route.sourceKey));
  }
}

/**
 * Handler pre-filter on the keys the event payload carries: could any active route cover this event? Component and
 * label routes are not in the payload, so a Jira event passes when such a route exists; a missing key passes too.
 */
export function prefilter(e: Pick<WorkEvent, 'source' | 'projectKey' | 'spaceKey'>, routes: readonly Pick<Route, 'sourceType' | 'sourceKey'>[]): boolean {
  return routes.some((r) => {
    if (e.source === 'confluence') return r.sourceType === 'confluence_space' && (e.spaceKey === null || e.spaceKey === r.sourceKey);
    if (r.sourceType === 'jira_component' || r.sourceType === 'jira_label') return true;
    return r.sourceType === 'jira_project' && (e.projectKey === null || e.projectKey === r.sourceKey);
  });
}

export interface RouteMatch {
  route: Route;
  /** Route keywords found in the text, in route order. */
  matched: string[];
}

/** A keyword is found when every stem of it occurs in the text's stems; a keyword without stems never matches. */
export function matchedKeywords(keywords: readonly string[], text: string): string[] {
  const have = new Set(stems(text));
  return keywords.filter((k) => {
    const need = stems(k);
    return need.length > 0 && need.every((s) => have.has(s));
  });
}

/** Active routes whose source covers the artifact and at least one of whose keywords occurs in its text. */
export function matchRoutes(routes: readonly Route[], place: ArtifactPlace, text: string): RouteMatch[] {
  return routes.flatMap((route) => {
    if (route.status !== 'active' || !routeMatchesSource(route, place)) return [];
    const matched = matchedKeywords(route.spec.keywords, text);
    return matched.length > 0 ? [{ route, matched }] : [];
  });
}

/**
 * True when the artifact was written by an app (Hindsight or another). The Sentinel marker alone does not make an
 * artifact "self" when the author is known to be a person (they could type it); it only counts when the account type
 * is unknown (Confluence v2 reads carry only an author id).
 */
export function isSelfArtifact(author: { accountId?: string | null; accountType?: string | null } | null | undefined, appAccounts: readonly string[], text: string): boolean {
  if (author?.accountType === 'app') return true;
  if (author?.accountId && appAccounts.includes(author.accountId)) return true;
  return !author?.accountType && text.includes(SENTINEL_MARKER);
}

function parseCap(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
}

/** `settings.sentinel_weekly_cap` → integer in [1, MAX_WEEKLY_CAP]; anything else is the default. */
export const parseWeeklyCap = (raw: unknown): number => parseCap(raw, DEFAULT_WEEKLY_CAP, MAX_WEEKLY_CAP);

/** `settings.sentinel_daily_cap` → integer in [1, MAX_DAILY_CAP]; anything else is the default. */
export const parseDailyCap = (raw: unknown): number => parseCap(raw, DEFAULT_DAILY_CAP, MAX_DAILY_CAP);

export type AlertGate = { go: true } | { go: false; reason: 'dedup' | 'in_flight' | 'already_skipped' | 'gave_up' | 'backoff' };

/**
 * May Sentinel try to alert this route about this artifact (comment), given every earlier alert row for the same
 * (route, artifact id, comment id)? Lifetime dedup: a posted alert, an unfinished post (`failed`/`posting`, maybe
 * posted before a crash) or a cap skip blocks for good, so page edits never re-alert. Failed posts are bounded:
 * at most `MAX_FAILED_POSTS`, and an API error waits `FAILED_BACKOFF_MS` (rate limits are retried by the queue).
 */
export function alertGate(history: readonly Pick<Alert, 'status' | 'reason' | 'createdAt'>[], nowMs: number): AlertGate {
  if (history.some((h) => h.status === 'posted')) return { go: false, reason: 'dedup' };
  if (history.some((h) => h.status === 'failed' && h.reason === 'posting')) return { go: false, reason: 'in_flight' };
  if (history.some((h) => h.status === 'skipped')) return { go: false, reason: 'already_skipped' };
  const failed = history.filter((h) => h.status === 'failed');
  if (failed.length >= MAX_FAILED_POSTS) return { go: false, reason: 'gave_up' };
  const recentError = failed.some((h) => h.reason !== 'rate_limited' && nowMs - Date.parse(h.createdAt) < FAILED_BACKOFF_MS);
  return recentError ? { go: false, reason: 'backoff' } : { go: true };
}

export interface AlertCommentInput {
  teamName: string;
  incidentKey: string;
  /** Link to the incident (where the Hindsight panel is); null when the site URL is unknown (key without link). */
  incidentUrl: string | null;
}

/**
 * The heads-up comment, as Jira ADF and Confluence storage. Blameless, assignment-free and deliberately neutral: it
 * names only the owner team (bold text, no account mentions) and the past incident with a link to its panel. It
 * never repeats the matched keywords or the route source, so a reader learns nothing about the incident's content.
 */
export function buildAlertComment(input: AlertCommentInput): { adf: AdfDoc; storage: string; text: string } {
  const lead = ' Heads-up for ';
  const middle = ': this item may relate to a past incident in this area (';
  const after = '). No action is assigned. The team can review it, and give feedback on this alert in the Hindsight panel of that incident.';
  const text = `${SENTINEL_MARKER}${lead}${input.teamName}${middle}${input.incidentKey}${after}`;

  const key = input.incidentUrl ? { type: 'text', text: input.incidentKey, marks: [{ type: 'link', attrs: { href: input.incidentUrl } }] } : { type: 'text', text: input.incidentKey };
  const adf: AdfDoc = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: SENTINEL_MARKER, marks: [{ type: 'strong' }] },
          { type: 'text', text: lead },
          { type: 'text', text: input.teamName, marks: [{ type: 'strong' }] },
          { type: 'text', text: middle },
          key,
          { type: 'text', text: after },
        ],
      },
    ],
  };

  const keyHtml = input.incidentUrl ? `<a href="${escapeXml(input.incidentUrl)}">${escapeXml(input.incidentKey)}</a>` : escapeXml(input.incidentKey);
  const storage = `<p><strong>${escapeXml(SENTINEL_MARKER)}</strong>${escapeXml(lead)}<strong>${escapeXml(input.teamName)}</strong>${escapeXml(middle)}${keyHtml}${escapeXml(after)}</p>`;
  return { adf, storage, text };
}

/** Demo "provider notice" comment text: numbered, containing the route keywords verbatim so the route matches. */
export function noticeText(n: number, keywords: readonly string[]): string {
  const words = keywords.length > 0 ? keywords.join(', ') : 'upstream change';
  return `Provider notice #${n}: our upstream provider announced a change that touches ${words}. Sharing it here in case it affects the next release.`;
}
