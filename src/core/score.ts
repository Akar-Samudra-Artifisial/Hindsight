import type { Message } from '@forge/llm';
import {
  SIGNAL_TYPES,
  type AnalysisJob,
  type CachedScore,
  type Candidate,
  type ScoreCacheInput,
  type Incident,
  type JobPatch,
  type ScoreError,
  type Signal,
  type SignalInput,
  type SignalType,
  type StoredEvent,
} from '../adapters/repo';
import { LlmOutputError, type Models } from '../llm';
import { buildScoreMessage, PROMPT_VERSION, QUOTE_MAX, REASON_MAX, SCORE_SYSTEM } from '../llm/prompts';

/**
 * Candidate scoring: Forge LLM judges the kept candidates in batches, every quote is verified against the stored
 * excerpt (anti-hallucination), verified relevant candidates become `proposed` signals. Resumable: a candidate stays
 * `kept` until its batch is written, so a re-queued run continues where the last one stopped.
 */

export const SCORE_BATCH_SIZE = 10;
export const QUOTE_MIN = 15;

/** Normalisation shared by the quote check (port of Tripwire `extraction.ts`). */
export function normaliseForQuote(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
}

/** True when `quote` is 15–300 characters and appears in `text` after normalisation. */
export function quoteInText(quote: string, text: string): boolean {
  if (quote.trim().length > QUOTE_MAX) return false;
  const q = normaliseForQuote(quote);
  return q.length >= QUOTE_MIN && normaliseForQuote(text).includes(q);
}

/** Per-character form of `normaliseForQuote` (without the final trims); '' drops the character. */
function normaliseChar(c: string): string {
  if (/[“”„«»]/.test(c)) return '"';
  if (/[‘’‚]/.test(c)) return "'";
  if (/[–—]/.test(c)) return '-';
  if (c === '…') return '';
  return c.toLowerCase();
}

/**
 * The span of `text` that matches `quote` under the quote normalisation, copied from the source (so the stored quote
 * is verbatim, not the model's rendering); undefined when it cannot be located.
 */
export function findVerbatim(quote: string, text: string): string | undefined {
  const q = normaliseForQuote(quote);
  if (q.length < QUOTE_MIN) return undefined;
  const source = text.normalize('NFC');
  let normalised = '';
  // starts[i] / ends[i]: source range of the character that produced normalised[i].
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < source.length; ) {
    const cp = source.codePointAt(i) ?? 0;
    const c = String.fromCodePoint(cp);
    const next = i + c.length;
    const out = /\s/.test(c) ? (normalised === '' || normalised.endsWith(' ') ? '' : ' ') : normaliseChar(c);
    for (const ch of out) {
      normalised += ch;
      starts.push(i);
      ends.push(next);
    }
    i = next;
  }
  const at = normalised.indexOf(q);
  if (at < 0) return undefined;
  const from = starts[at];
  const last = ends[at + q.length - 1];
  if (from === undefined || last === undefined) return undefined;
  // The normalisation drops a trailing full stop; keep the source's when the model quoted it too.
  const to = /\.\s*$/.test(quote) && source[last] === '.' ? last + 1 : last;
  const span = source.slice(from, to).trim();
  return span.length > 0 && span.length <= QUOTE_MAX ? span : undefined;
}

const PERSONAL = [
  /\[~accountid:[^\]]*\]/gi,
  /\b\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b557058:[\w-]+/g,
  /\b[0-9a-f]{24}\b/gi,
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/g,
  /@[\w.-]+/g,
];

/** Blameless reason: account ids, emails and @mentions are replaced by "someone". */
export function sanitiseReason(reason: string): string {
  return PERSONAL.reduce((text, pattern) => text.replace(pattern, 'someone'), reason)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_MAX);
}

export interface ScoreResult {
  candidateId: string;
  relevant: boolean;
  signalType: SignalType | null;
  quote: string;
  reason: string;
  confidence: number;
}

const isSignalType = (v: unknown): v is SignalType => typeof v === 'string' && (SIGNAL_TYPES as readonly string[]).includes(v);

/**
 * Valid results of a `score_candidates` call, keyed by candidate id. Unknown ids and malformed entries are dropped
 * (their candidates count as missing). Throws `LlmOutputError` when there is no `results` array at all.
 */
export function parseScoreOutput(args: unknown, candidateIds: ReadonlySet<string>): Map<string, ScoreResult> {
  const results = args && typeof args === 'object' ? (args as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) throw new LlmOutputError('score_candidates returned no results array');
  const out = new Map<string, ScoreResult>();
  for (const raw of results) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = r['candidateId'];
    if (typeof id !== 'string' || !candidateIds.has(id) || out.has(id)) continue;
    if (typeof r['relevant'] !== 'boolean') continue;
    if (!r['relevant']) {
      out.set(id, { candidateId: id, relevant: false, signalType: null, quote: '', reason: '', confidence: 0 });
      continue;
    }
    const confidence = typeof r['confidence'] === 'number' && Number.isFinite(r['confidence']) ? Math.min(1, Math.max(0, r['confidence'])) : null;
    if (!isSignalType(r['signalType']) || typeof r['quote'] !== 'string' || typeof r['reason'] !== 'string' || confidence === null) continue;
    out.set(id, {
      candidateId: id,
      relevant: true,
      signalType: r['signalType'],
      quote: r['quote'].trim(),
      reason: sanitiseReason(r['reason']),
      confidence,
    });
  }
  return out;
}

export interface Applied {
  signals: SignalInput[];
  /** Candidates scored without a signal (not relevant) or with a verified signal. */
  scored: string[];
  failed: { id: string; error: ScoreError }[];
  /** Candidates without a valid result. */
  missing: Candidate[];
}

/** Turns parsed results into signals and candidate outcomes; a relevant result whose quote is not found fails. */
export function applyScores(candidates: readonly Candidate[], results: ReadonlyMap<string, ScoreResult>, ctx: { model: string; promptVersion: string }): Applied {
  const applied: Applied = { signals: [], scored: [], failed: [], missing: [] };
  for (const c of candidates) {
    const r = results.get(c.id);
    if (!r) {
      applied.missing.push(c);
      continue;
    }
    if (!r.relevant || !r.signalType) {
      applied.scored.push(c.id);
      continue;
    }
    const excerpt = c.excerpt ?? '';
    if (!quoteInText(r.quote, excerpt)) {
      applied.failed.push({ id: c.id, error: 'quote_not_found' });
      continue;
    }
    const quote = findVerbatim(r.quote, excerpt) ?? r.quote;
    applied.scored.push(c.id);
    applied.signals.push({
      jobId: c.jobId,
      incidentKey: c.incidentKey,
      eventId: c.eventId,
      candidateId: c.id,
      signalType: r.signalType,
      quote,
      reason: r.reason,
      confidence: r.confidence,
      daysBefore: c.daysBefore,
      textHash: c.textHash,
      model: ctx.model,
      promptVersion: ctx.promptVersion,
    });
  }
  return applied;
}

export interface ScoreProgress {
  done: number;
  total: number;
  signals: number;
  failed: number;
}

export interface ScoreDeps {
  repo: {
    getJob(id: string): Promise<AnalysisJob | undefined>;
    updateJob(id: string, patch: JobPatch): Promise<number>;
    getIncident(key: string): Promise<Incident | undefined>;
    listKeptCandidates(jobId: string, limit?: number): Promise<Candidate[]>;
    candidateStatusCounts(jobId: string): Promise<Record<string, number>>;
    getEventsByIds(ids: readonly string[]): Promise<StoredEvent[]>;
    listSignalsForIncident(incidentKey: string): Promise<Signal[]>;
    upsertSignals(signals: readonly SignalInput[]): Promise<number>;
    markCandidates(jobId: string, ids: readonly string[], status: 'scored' | 'score_failed', scoreError: ScoreError | null): Promise<number>;
  };
  pickModels(): Promise<Models>;
  /** One forced tool call; returns the raw tool arguments. */
  callModel(model: string, messages: Message[]): Promise<unknown>;
  isRateLimited(err: unknown): boolean;
  now(): number;
  /**
   * Verdict cache of the incident, or null when it must not be used (only the demo incident has one, so its
   * recordings stay stable; every other incident always asks the model).
   */
  scoreCacheFor?(incidentKey: string): Promise<ScoreCache | null>;
}

export interface ScoreCache {
  /** Cached verdicts keyed `eventId|textHash`. */
  get(promptVersion: string, eventIds: readonly string[]): Promise<Map<string, CachedScore>>;
  put(rows: readonly ScoreCacheInput[]): Promise<number>;
}

const cacheKey = (c: Pick<Candidate, 'eventId' | 'textHash'>): string | null => (c.textHash ? `${c.eventId}|${c.textHash}` : null);

/** Applies cached verdicts (grouped by the model that gave them, so each signal keeps its model). */
function applyCached(candidates: readonly Candidate[], cached: ReadonlyMap<string, CachedScore>, promptVersion: string): Applied {
  const byModel = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const model = cached.get(cacheKey(c) ?? '')?.model ?? '';
    byModel.set(model, [...(byModel.get(model) ?? []), c]);
  }
  const total: Applied = { signals: [], scored: [], failed: [], missing: [] };
  for (const [model, group] of byModel) {
    const results = new Map<string, ScoreResult>();
    for (const c of group) {
      const v = cached.get(cacheKey(c) ?? '');
      if (v) results.set(c.id, { candidateId: c.id, relevant: v.relevant, signalType: v.signalType, quote: v.quote, reason: v.reason, confidence: v.confidence });
    }
    const a = applyScores(group, results, { model, promptVersion });
    total.signals.push(...a.signals);
    total.scored.push(...a.scored);
    total.failed.push(...a.failed);
    total.missing.push(...a.missing);
  }
  return total;
}

export type ScoreRunResult =
  | { status: 'more'; progress: ScoreProgress }
  | { status: 'done'; progress: ScoreProgress; job: AnalysisJob }
  | { status: 'rate_limited'; progress: ScoreProgress }
  | { status: 'skipped'; reason: string };

function readProgress(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function keywordsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string').slice(0, 30) : [];
}

/** Runs scoring batches of a `scoring` job until no kept candidate is left (`done`) or the deadline passes (`more`). */
export async function runScoring(jobId: string, deps: ScoreDeps, opts: { deadline: number; batchSize?: number }): Promise<ScoreRunResult> {
  const batchSize = opts.batchSize ?? SCORE_BATCH_SIZE;
  const job = await deps.repo.getJob(jobId);
  if (!job) return { status: 'skipped', reason: 'job not found' };
  if (job.status !== 'scoring') return { status: 'skipped', reason: `job is ${job.status}` };

  let model = job.modelFast;
  if (!model) {
    const models = await deps.pickModels();
    model = models.fast;
    await deps.repo.updateJob(jobId, { modelFast: models.fast, modelStrong: models.strong, promptVersion: PROMPT_VERSION });
    console.info('llm models', { jobId, fast: models.fast, strong: models.strong });
  }
  const promptVersion = job.promptVersion ?? PROMPT_VERSION;

  const [incident, existing, counts] = await Promise.all([
    deps.repo.getIncident(job.incidentKey),
    deps.repo.listSignalsForIncident(job.incidentKey),
    deps.repo.candidateStatusCounts(jobId),
  ]);
  // Signals a person already decided are not scored again.
  const decided = new Set(existing.filter((s) => s.status !== 'proposed').map((s) => s.eventId));
  const scope = readProgress(job.scope);
  const subject = { key: job.incidentKey, summary: incident?.summary ?? job.incidentKey, keywords: keywordsOf(incident?.keywords ?? scope['keywords']) };
  const baseProgress = readProgress(job.progress);
  const previous = readProgress(baseProgress['score']);
  const scored = counts['scored'] ?? 0;
  const failedCount = counts['score_failed'] ?? 0;
  const progress: ScoreProgress = {
    done: scored + failedCount,
    total: (counts['kept'] ?? 0) + scored + failedCount,
    signals: typeof previous['signals'] === 'number' ? previous['signals'] : 0,
    failed: failedCount,
  };
  const save = () => deps.repo.updateJob(jobId, { progress: { ...baseProgress, score: { ...progress } } });
  const cache = deps.scoreCacheFor ? await deps.scoreCacheFor(job.incidentKey) : null;
  const cacheStats = { hits: 0, misses: 0 };
  const logCache = () => {
    if (cache) console.info('score cache', { jobId, incidentKey: job.incidentKey, ...cacheStats });
  };
  /** Stores signals and candidate outcomes of one applied result set. */
  const persist = async (applied: Applied): Promise<{ signals: number; failed: number }> => {
    if (applied.signals.length > 0) await deps.repo.upsertSignals(applied.signals);
    if (applied.scored.length > 0) await deps.repo.markCandidates(jobId, applied.scored, 'scored', null);
    const notFound = applied.failed.map((f) => f.id);
    if (notFound.length > 0) await deps.repo.markCandidates(jobId, notFound, 'score_failed', 'quote_not_found');
    progress.done += applied.scored.length + notFound.length;
    return { signals: applied.signals.length, failed: notFound.length };
  };

  while (deps.now() < opts.deadline) {
    const batch = await deps.repo.listKeptCandidates(jobId, batchSize);
    if (batch.length === 0) {
      await save();
      logCache();
      return { status: 'done', progress, job };
    }
    const skip = batch.filter((c) => decided.has(c.eventId)).map((c) => c.id);
    if (skip.length > 0) {
      await deps.repo.markCandidates(jobId, skip, 'scored', null);
      progress.done += skip.length;
    }
    let pending = batch.filter((c) => !decided.has(c.eventId));
    let batchSignals = 0;
    let batchFailed = 0;
    if (cache && pending.length > 0) {
      // Replay earlier verdicts for the same text; only new or changed candidates go to the model.
      const cached = await cache.get(promptVersion, pending.map((c) => c.eventId));
      const hits = pending.filter((c) => {
        const key = cacheKey(c);
        return key !== null && cached.has(key);
      });
      if (hits.length > 0) {
        const out = await persist(applyCached(hits, cached, promptVersion));
        batchSignals += out.signals;
        batchFailed += out.failed;
        const hitIds = new Set(hits.map((c) => c.id));
        pending = pending.filter((c) => !hitIds.has(c.id));
      }
      cacheStats.hits += hits.length;
      cacheStats.misses += pending.length;
    }
    const events = new Map((pending.length > 0 ? await deps.repo.getEventsByIds(pending.map((c) => c.eventId)) : []).map((e) => [e.id, e]));
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
      const message = buildScoreMessage(
        subject,
        pending.map((c) => {
          const e = events.get(c.eventId);
          return { id: c.id, source: e?.source ?? 'jira', daysBefore: c.daysBefore, title: e?.title ?? '', text: c.excerpt ?? '' };
        }),
      );
      let applied: Applied;
      try {
        const args = await deps.callModel(model, [
          { role: 'system', content: SCORE_SYSTEM },
          { role: 'user', content: message },
        ]);
        const parsed = parseScoreOutput(args, new Set(pending.map((c) => c.id)));
        applied = applyScores(pending, parsed, { model, promptVersion });
        if (cache) await cache.put(cacheRows(pending, parsed, { incidentKey: job.incidentKey, model, promptVersion }));
      } catch (err) {
        if (deps.isRateLimited(err)) {
          await save();
          logCache();
          return { status: 'rate_limited', progress };
        }
        if (err instanceof LlmOutputError) {
          console.warn('score: invalid llm output', { jobId, attempt: attempt + 1, size: pending.length, error: err.message });
          continue;
        }
        throw err;
      }
      const out = await persist(applied);
      batchSignals += out.signals;
      batchFailed += out.failed;
      pending = applied.missing;
    }
    if (pending.length > 0) {
      await deps.repo.markCandidates(
        jobId,
        pending.map((c) => c.id),
        'score_failed',
        'llm_invalid_output',
      );
      batchFailed += pending.length;
      progress.done += pending.length;
    }
    progress.signals += batchSignals;
    progress.failed += batchFailed;
    await save();
    console.info('score batch', { jobId, size: batch.length, signals: batchSignals, failed: batchFailed, done: progress.done, total: progress.total });
  }
  logCache();
  return { status: 'more', progress };
}

/** Cache rows for every candidate the model gave a valid verdict on (relevant or not); no text hash → not cached. */
export function cacheRows(candidates: readonly Candidate[], parsed: ReadonlyMap<string, ScoreResult>, ctx: { incidentKey: string; model: string; promptVersion: string }): ScoreCacheInput[] {
  return candidates.flatMap((c) => {
    const r = parsed.get(c.id);
    if (!r || !c.textHash) return [];
    return [{ incidentKey: ctx.incidentKey, eventId: c.eventId, textHash: c.textHash, promptVersion: ctx.promptVersion, relevant: r.relevant, signalType: r.signalType, quote: r.quote, reason: r.reason, confidence: r.confidence, model: ctx.model }];
  });
}
