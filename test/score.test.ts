import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/llm', () => ({ chat: vi.fn(), list: vi.fn() }));

const { applyScores, findVerbatim, normaliseForQuote, parseScoreOutput, quoteInText, runScoring, sanitiseReason } = await import('../src/core/score');
const { LlmOutputError } = await import('../src/llm');
type Candidate = import('../src/adapters/repo').Candidate;
type ScoreDeps = import('../src/core/score').ScoreDeps;

const TEXT = 'We saw “timeouts” from the provider — again.\nThe retry   loop has no backoff and could flood the gateway.';
const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  jobId: 'j1',
  incidentKey: 'INC-1',
  eventId: `e-${id}`,
  filterScore: 40,
  reasons: [],
  matchedKeywords: [],
  hintType: null,
  excerpt: TEXT,
  textHash: 'h',
  daysBefore: 5,
  status: 'kept',
  ...over,
});

describe('quote verification', () => {
  it('normalises case, curly quotes, dashes, ellipsis, whitespace and a trailing full stop', () => {
    expect(normaliseForQuote('  “Hello” – World…  ok. ')).toBe('"hello" - world ok');
  });

  it('accepts a verbatim quote despite formatting differences', () => {
    expect(quoteInText('We saw "timeouts" from the provider - again.', TEXT)).toBe(true);
    expect(quoteInText('the retry loop has no backoff and could flood the gateway', TEXT)).toBe(true);
  });

  it('rejects paraphrases, too short and too long quotes', () => {
    expect(quoteInText('The retry loop lacks backoff.', TEXT)).toBe(false);
    expect(quoteInText('no backoff', TEXT)).toBe(false);
    expect(quoteInText('x'.repeat(301), 'x'.repeat(400))).toBe(false);
    expect(quoteInText('', TEXT)).toBe(false);
  });
});

describe('findVerbatim', () => {
  it('returns the matching span of the source, with its own quotes, dashes, case and spacing', () => {
    expect(findVerbatim('we saw "timeouts" from the provider - again.', TEXT)).toBe('We saw “timeouts” from the provider — again.');
    expect(findVerbatim('The retry loop has no backoff', TEXT)).toBe('The retry   loop has no backoff');
    expect(findVerbatim('again. The retry loop', TEXT)).toBe('again.\nThe retry   loop');
  });

  it('is undefined when the quote is not in the source or too short', () => {
    expect(findVerbatim('The retry loop lacks backoff entirely', TEXT)).toBeUndefined();
    expect(findVerbatim('no backoff', TEXT)).toBeUndefined();
  });
});

describe('sanitiseReason', () => {
  it('replaces account ids, emails and @mentions', () => {
    expect(sanitiseReason('Raised by 557058:0a1b2c3d-1111-2222-3333-444455556666 and [~accountid:5b10ac8d82e05b22cc7d4ef5].')).toBe('Raised by someone and someone.');
    expect(sanitiseReason('Mail ana.lee@arkana.io or ping @ana before release')).toBe('Mail someone or ping someone before release');
    expect(sanitiseReason('Owner 5b10ac8d82e05b22cc7d4ef5 knew the retry risk')).toBe('Owner someone knew the retry risk');
    expect(sanitiseReason('The retry loop has no backoff.')).toBe('The retry loop has no backoff.');
  });

  it('is applied to parsed reasons', () => {
    const out = parseScoreOutput({ results: [{ candidateId: 'c1', relevant: true, signalType: 'technical_warning', quote: 'q', reason: 'Flagged by @bob', confidence: 0.5 }] }, new Set(['c1']));
    expect(out.get('c1')!.reason).toBe('Flagged by someone');
  });
});

describe('parseScoreOutput', () => {
  const ids = new Set(['c1', 'c2', 'c3', 'c4']);

  it('keeps valid entries, drops unknown ids, duplicates and malformed entries', () => {
    const out = parseScoreOutput(
      {
        results: [
          { candidateId: 'c1', relevant: true, signalType: 'external_change', quote: ' q ', reason: 'r'.repeat(300), confidence: 1.7 },
          { candidateId: 'c1', relevant: false },
          { candidateId: 'zz', relevant: false },
          { candidateId: 'c2', relevant: false, signalType: 'whatever' },
          { candidateId: 'c3', relevant: true, signalType: 'warning', quote: 'q', reason: 'r', confidence: 0.5 },
          { candidateId: 'c4', relevant: 'yes' },
          null,
        ],
      },
      ids,
    );
    expect([...out.keys()]).toEqual(['c1', 'c2']);
    expect(out.get('c1')).toMatchObject({ quote: 'q', confidence: 1, signalType: 'external_change' });
    expect(out.get('c1')!.reason).toHaveLength(200);
    expect(out.get('c2')).toMatchObject({ relevant: false, signalType: null });
  });

  it('throws LlmOutputError without a results array', () => {
    expect(() => parseScoreOutput({}, ids)).toThrow(LlmOutputError);
    expect(() => parseScoreOutput(null, ids)).toThrow(LlmOutputError);
  });
});

describe('applyScores', () => {
  it('verified relevant → signal, unverified → quote_not_found, irrelevant → scored, missing → retry', () => {
    const results = parseScoreOutput(
      {
        results: [
          { candidateId: 'c1', relevant: true, signalType: 'technical_warning', quote: 'The retry loop has no backoff and could flood the gateway.', reason: 'r', confidence: 0.8 },
          { candidateId: 'c2', relevant: true, signalType: 'technical_warning', quote: 'The database is running out of disk space.', reason: 'r', confidence: 0.8 },
          { candidateId: 'c3', relevant: false },
        ],
      },
      new Set(['c1', 'c2', 'c3', 'c4']),
    );
    const applied = applyScores([cand('c1', { daysBefore: 9 }), cand('c2'), cand('c3'), cand('c4')], results, { model: 'm', promptVersion: 'score-v1' });
    expect(applied.signals).toEqual([
      expect.objectContaining({ candidateId: 'c1', eventId: 'e-c1', daysBefore: 9, signalType: 'technical_warning', model: 'm', promptVersion: 'score-v1', textHash: 'h' }),
    ]);
    expect(applied.scored).toEqual(['c1', 'c3']);
    expect(applied.failed).toEqual([{ id: 'c2', error: 'quote_not_found' }]);
    expect(applied.missing.map((c) => c.id)).toEqual(['c4']);
  });
});

function fakeDeps(kept: Candidate[][], over: Partial<ScoreDeps> = {}) {
  const repo = {
    getJob: vi.fn(async () => ({ id: 'j1', incidentKey: 'INC-1', status: 'scoring', modelFast: 'm', promptVersion: 'score-v1', progress: {}, scope: {} }) as never),
    updateJob: vi.fn(async () => 1),
    getIncident: vi.fn(async () => undefined),
    listKeptCandidates: vi.fn(async () => kept.shift() ?? []),
    candidateStatusCounts: vi.fn(async () => ({ kept: 4 })),
    getEventsByIds: vi.fn(async () => []),
    listSignalsForIncident: vi.fn(async () => [{ eventId: 'e-c2', status: 'confirmed' }] as never),
    upsertSignals: vi.fn(async () => 1),
    markCandidates: vi.fn(async () => 1),
  };
  let t = 0;
  const deps: ScoreDeps = {
    repo,
    pickModels: vi.fn(async () => ({ fast: 'm', strong: 's' })),
    callModel: vi.fn(async () => ({ results: [] })),
    isRateLimited: () => false,
    now: () => t++,
    ...over,
  };
  return { deps, repo };
}

describe('runScoring', () => {
  it('skips candidates whose signal a person already decided, and retries missing entries once', async () => {
    const callModel = vi.fn(async () => ({ results: [{ candidateId: 'c1', relevant: false }] }));
    const { deps, repo } = fakeDeps([[cand('c1'), cand('c2'), cand('c3')]], { callModel });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const result = await runScoring('j1', deps, { deadline: 100 });
    expect(result).toMatchObject({ status: 'done', progress: { done: 3, total: 4, signals: 0, failed: 1 } });
    expect(repo.markCandidates).toHaveBeenCalledWith('j1', ['c2'], 'scored', null);
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(repo.markCandidates).toHaveBeenCalledWith('j1', ['c3'], 'score_failed', 'llm_invalid_output');
  });

  it('stops at the deadline with "more" and leaves the rest kept', async () => {
    const { deps } = fakeDeps([[cand('c1')], [cand('c4')]], { now: () => 50 });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(await runScoring('j1', deps, { deadline: 10 })).toMatchObject({ status: 'more' });
  });

  it('skips a job that is not scoring', async () => {
    const { deps, repo } = fakeDeps([]);
    repo.getJob.mockResolvedValue({ id: 'j1', status: 'done' } as never);
    expect(await runScoring('j1', deps, { deadline: 10 })).toEqual({ status: 'skipped', reason: 'job is done' });
  });
});
