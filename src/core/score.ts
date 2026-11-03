import type { Message } from '@forge/llm';
import {
  SIGNAL_TYPES,
  type AnalysisJob,
  type Candidate,
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

  while (deps.now() < opts.deadline) {
    const batch = await deps.repo.listKeptCandidates(jobId, batchSize);
    if (batch.length === 0) {
      await save();
      return { status: 'done', progress, job };
    }
    const skip = batch.filter((c) => decided.has(c.eventId)).map((c) => c.id);
    if (skip.length > 0) {
      await deps.repo.markCandidates(jobId, skip, 'scored', null);
      progress.done += skip.length;
    }
    let pending = batch.filter((c) => !decided.has(c.eventId));
    const events = new Map((await deps.repo.getEventsByIds(pending.map((c) => c.eventId))).map((e) => [e.id, e]));
    let batchSignals = 0;
    let batchFailed = 0;
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
        applied = applyScores(pending, parseScoreOutput(args, new Set(pending.map((c) => c.id))), { model, promptVersion });
      } catch (err) {
        if (deps.isRateLimited(err)) {
          await save();
          return { status: 'rate_limited', progress };
        }
        if (err instanceof LlmOutputError) {
          console.warn('score: invalid llm output', { jobId, attempt: attempt + 1, size: pending.length, error: err.message });
          continue;
        }
        throw err;
      }
      if (applied.signals.length > 0) await deps.repo.upsertSignals(applied.signals);
      if (applied.scored.length > 0) await deps.repo.markCandidates(jobId, applied.scored, 'scored', null);
      const notFound = applied.failed.map((f) => f.id);
      if (notFound.length > 0) await deps.repo.markCandidates(jobId, notFound, 'score_failed', 'quote_not_found');
      batchSignals += applied.signals.length;
      batchFailed += notFound.length;
      progress.done += applied.scored.length + notFound.length;
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
  return { status: 'more', progress };
}
