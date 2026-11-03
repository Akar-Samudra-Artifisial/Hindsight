import { stem, tokenise, type Keyword } from './keywords';
import { excerptAround } from './text';

/** Deterministic candidate filter (pure, no I/O). Week 3 asks the LLM about the kept candidates. */

const DAY_MS = 86_400_000;
export const MIN_FILTER_SCORE = 20;
export const MAX_CANDIDATES = 200;
export const EXCERPT_MAX = 2000;

const POINTS = {
  service: 40,
  component: 20,
  keyword: 10,
  keywordMax: 40,
  risk: 10,
  unanswered: 10,
  jsmDismissed: 10,
} as const;

const RISK_TERMS =
  /\b(deprecat\w*|end[ -]of[ -]life|eol|will break|time ?outs?|timed out|retr(?:y|ies|ied|ying)|risk\w*|tls|certificates?|certs?)\b/i;
const EXTERNAL_CHANGE = /\b(deprecat\w*|vendor\w*|end[ -]of[ -]life|eol|sunset\w*)\b/i;
const JSM_DISMISSED = /(cannot|can't|can not|could not|couldn't) reproduce|won'?t (do|fix)/i;

export type HintType = 'external_change' | 'unanswered_question' | 'customer_complaint' | 'technical_warning';

export interface CollectedEvent {
  eventId: string;
  source: 'jira' | 'jsm' | 'confluence';
  kind: string;
  title: string;
  /** Normalised artifact text (description, comment or page body). */
  text: string;
  projectKey: string | null;
  spaceKey: string | null;
  componentNames: readonly string[];
  labels: readonly string[];
  serviceKey: string | null;
  /** ISO effective time: `scenario_at` when seeded, else the real time. */
  effectiveAt: string;
  replyCount: number | null;
  statusCategory: string | null;
  resolutionName: string | null;
  authorId: string | null;
  /** Comment with no later comment by someone else on the same issue. */
  isLastComment: boolean;
}

export interface IncidentContext {
  serviceKey: string | null;
  componentNames: readonly string[];
  keywords: readonly Keyword[];
  windowFrom: string;
  windowTo: string;
  /** ISO effective incident start (= `windowTo`). */
  effectiveStart: string;
}

export interface CandidateDraft {
  eventId: string;
  filterScore: number;
  reasons: string[];
  matchedKeywords: string[];
  hintType: HintType;
  excerpt: string;
  daysBefore: number;
}

/** Jira/JSM comment ending with a question that nobody else answered afterwards. */
export function isUnansweredQuestion(ev: Pick<CollectedEvent, 'source' | 'kind' | 'text' | 'isLastComment'>): boolean {
  return ev.source !== 'confluence' && ev.kind === 'comment' && ev.isLastComment && ev.text.trimEnd().endsWith('?');
}

export function daysBefore(effectiveStart: string, effectiveAt: string): number {
  return Math.floor((new Date(effectiveStart).getTime() - new Date(effectiveAt).getTime()) / DAY_MS);
}

/** Index of the first token of `text` whose stem is in `stemsToFind`, or -1. */
function firstHit(text: string, stemsToFind: ReadonlySet<string>): number {
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (stemsToFind.has(stem(m[0].toLowerCase()))) return m.index ?? 0;
  }
  return -1;
}

const stemSet = (text: string): Set<string> => new Set(tokenise(text).map(stem));
const lower = (s: string) => s.trim().toLowerCase();

/** Scores one event against the incident; undefined when it does not pass the filter. */
export function filterEvent(ev: CollectedEvent, incident: IncidentContext): CandidateDraft | undefined {
  const at = new Date(ev.effectiveAt).getTime();
  if (!(at >= new Date(incident.windowFrom).getTime() && at < new Date(incident.windowTo).getTime())) return undefined;

  // A comment's title is its issue's summary; counting it would let every comment on a matching issue pass.
  const scoredTitle = ev.kind === 'comment' ? '' : ev.title;
  const titleStems = stemSet(scoredTitle);
  const bodyStems = stemSet(ev.text);
  const reasons: string[] = [];
  let score = 0;

  const serviceMatch = incident.serviceKey !== null && ev.serviceKey === incident.serviceKey;
  if (serviceMatch) {
    score += POINTS.service;
    reasons.push('service_match');
  }
  const incidentComponents = new Set(incident.componentNames.map(lower));
  if (ev.componentNames.some((c) => incidentComponents.has(lower(c)))) {
    score += POINTS.component;
    reasons.push('component_match');
  }

  const matched = incident.keywords.filter((k) => titleStems.has(k.stem) || bodyStems.has(k.stem));
  if (matched.length > 0) {
    const points = matched.reduce((sum, k) => sum + (titleStems.has(k.stem) ? 2 : 1) * POINTS.keyword, 0);
    score += Math.min(POINTS.keywordMax, points);
    reasons.push('keyword_match');
  }

  const fullText = `${scoredTitle}\n${ev.text}`;
  const risk = RISK_TERMS.test(fullText);
  if (risk) {
    score += POINTS.risk;
    reasons.push('risk_term');
  }
  const unanswered = isUnansweredQuestion(ev);
  if (unanswered) {
    score += POINTS.unanswered;
    reasons.push('unanswered_question');
  }
  if (ev.source === 'jsm' && (JSM_DISMISSED.test(ev.resolutionName ?? '') || (ev.statusCategory === 'done' && matched.length > 0))) {
    score += POINTS.jsmDismissed;
    reasons.push('jsm_closed_without_fix');
  }

  if (score < MIN_FILTER_SCORE || !(matched.length > 0 || (serviceMatch && risk))) return undefined;

  const hintType: HintType = EXTERNAL_CHANGE.test(fullText)
    ? 'external_change'
    : unanswered
      ? 'unanswered_question'
      : ev.source === 'jsm'
        ? 'customer_complaint'
        : 'technical_warning';
  const hit = firstHit(ev.text, new Set(matched.map((k) => k.stem)));
  return {
    eventId: ev.eventId,
    filterScore: score,
    reasons,
    matchedKeywords: matched.map((k) => k.stem),
    hintType,
    excerpt: excerptAround(ev.text, hit < 0 ? 0 : hit, EXCERPT_MAX),
    daysBefore: daysBefore(incident.effectiveStart, ev.effectiveAt),
  };
}

export interface Rankable {
  eventId: string;
  filterScore: number;
  daysBefore: number;
}

/**
 * Best first: score DESC, then oldest (days before DESC), then event id; positions ≥ `limit` are truncated
 * (kept in SQL so the count can be shown). Does not mutate the input.
 */
export function rankCandidates<T extends Rankable>(items: readonly T[], limit = MAX_CANDIDATES): { kept: T[]; truncated: T[] } {
  const sorted = [...items].sort(
    (a, b) => b.filterScore - a.filterScore || b.daysBefore - a.daysBefore || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );
  return { kept: sorted.slice(0, limit), truncated: sorted.slice(limit) };
}
