import { describe, expect, it, vi } from 'vitest';
import type { Signal } from '../src/adapters/repo';
import { decideSignal, DecisionError, listVisibleSignals, nextStatus, sortSignals, type DecideDeps } from '../src/core/decisions';

const ID = '7d1c2f6e-4b7a-4c51-9a55-8f1d3c2a1e00';
const signal = (over: Partial<Signal> = {}): Signal => ({
  id: ID,
  jobId: 'j',
  incidentKey: 'INC-1',
  eventId: 'e1',
  candidateId: 'c',
  signalType: 'technical_warning',
  quote: 'q',
  reason: 'r',
  confidence: 0.8,
  status: 'proposed',
  daysBefore: 9,
  textHash: null,
  model: 'm',
  promptVersion: 'p',
  createdAt: '',
  updatedAt: '',
  ...over,
});
const event = { id: 'e1', source: 'jira', artifactId: '100', kind: 'comment', title: 'PAY-1', artifactKey: 'PAY-1', url: 'https://x/browse/PAY-1' } as never;

function deps(over: Partial<DecideDeps['repo']> = {}, visible = true) {
  const repo = {
    getSignal: vi.fn(async () => signal()),
    getEventsByIds: vi.fn(async () => [event]),
    updateSignalStatus: vi.fn(async () => 1),
    insertDecision: vi.fn(async () => undefined),
    ...over,
  };
  const d: DecideDeps = {
    getIncidentAsUser: vi.fn(async () => ({ id: '1' })),
    visibleIssueIds: vi.fn(async () => new Set(visible ? ['100'] : [])),
    visiblePageIds: vi.fn(async () => new Set<string>()),
    repo,
  };
  return { d, repo };
}

const input = { incidentKey: 'INC-1', signalId: ID, decision: 'confirm' as const, accountId: 'acc-1' };

describe('nextStatus', () => {
  it('allows confirm/reject from proposed and undo back to proposed only', () => {
    expect(nextStatus('proposed', 'confirm')).toBe('confirmed');
    expect(nextStatus('proposed', 'reject')).toBe('rejected');
    expect(nextStatus('confirmed', 'undo')).toBe('proposed');
    expect(nextStatus('rejected', 'undo')).toBe('proposed');
    expect(nextStatus('confirmed', 'reject')).toBeNull();
    expect(nextStatus('proposed', 'undo')).toBeNull();
  });
});

describe('decideSignal', () => {
  it('confirms with a compare-and-set and records the decider for audit', async () => {
    const { d, repo } = deps();
    expect(await decideSignal(input, d)).toEqual({ id: ID, status: 'confirmed', previousStatus: 'proposed' });
    expect(repo.updateSignalStatus).toHaveBeenCalledWith(ID, 'proposed', 'confirmed');
    expect(repo.insertDecision).toHaveBeenCalledWith({ signalId: ID, incidentKey: 'INC-1', decision: 'confirm', decidedBy: 'acc-1' });
  });

  it('refuses an incident the user cannot view (forbidden)', async () => {
    const { d, repo } = deps();
    d.getIncidentAsUser = vi.fn(async () => undefined);
    await expect(decideSignal(input, d)).rejects.toMatchObject({ code: 'forbidden' });
    expect(repo.updateSignalStatus).not.toHaveBeenCalled();
  });

  it('reports a signal of another incident or on a hidden artifact as not found', async () => {
    const other = deps({ getSignal: vi.fn(async () => signal({ incidentKey: 'INC-2' })) });
    await expect(decideSignal(input, other.d)).rejects.toMatchObject({ code: 'not_found' });
    const hidden = deps({}, false);
    await expect(decideSignal(input, hidden.d)).rejects.toMatchObject({ code: 'not_found' });
    expect(hidden.repo.updateSignalStatus).not.toHaveBeenCalled();
  });

  it('rejects an invalid transition and a concurrent change', async () => {
    const done = deps({ getSignal: vi.fn(async () => signal({ status: 'confirmed' })) });
    await expect(decideSignal(input, done.d)).rejects.toMatchObject({ code: 'invalid_transition', message: 'This signal is already confirmed. Undo it first.' });
    const raced = deps({ updateSignalStatus: vi.fn(async () => 0) });
    const err = await decideSignal(input, raced.d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err).toMatchObject({ code: 'conflict' });
    expect(raced.repo.insertDecision).not.toHaveBeenCalled();
  });
});

describe('listVisibleSignals', () => {
  it('returns visible signals sorted confirmed → proposed → rejected, never the decider, and counts the hidden ones', async () => {
    const signals = [
      signal({ id: 'a', status: 'rejected', daysBefore: 20 }),
      signal({ id: 'b', status: 'proposed', daysBefore: 3 }),
      signal({ id: 'c', status: 'confirmed', daysBefore: 1 }),
      signal({ id: 'd', status: 'proposed', daysBefore: 12 }),
      signal({ id: 'h', eventId: 'e2' }),
    ];
    const out = await listVisibleSignals('INC-1', {
      repo: { listSignalsForIncident: async () => signals, getEventsByIds: async () => [event, { ...(event as object), id: 'e2', artifactId: '200' } as never] },
      visibleIssueIds: async () => new Set(['100']),
      visiblePageIds: async () => new Set(),
    });
    expect(out.signals.map((s) => s.id)).toEqual(['c', 'd', 'b', 'a']);
    expect(out.hiddenCount).toBe(1);
    expect(out.signals[0]).toMatchObject({ title: 'PAY-1', url: 'https://x/browse/PAY-1', source: 'jira' });
    expect(JSON.stringify(out)).not.toMatch(/decided|accountId/);
  });

  it('sortSignals does not mutate its input', () => {
    const list = [signal({ id: 'x', status: 'rejected' }), signal({ id: 'y', status: 'confirmed' })];
    expect(sortSignals(list).map((s) => s.id)).toEqual(['y', 'x']);
    expect(list.map((s) => s.id)).toEqual(['x', 'y']);
  });
});
