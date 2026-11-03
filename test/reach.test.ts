import { describe, expect, it, vi } from 'vitest';
import type { ReachPathInput } from '../src/adapters/repo';
import { computeMetrics, MAX_TRACE_SIGNALS, stopPointCopy, teamUuid, termsOf, traceReach, type ReachSignal, type TraceDeps, type TraceInput } from '../src/core/reach';

const PLATFORM = 'fa2a7a5c-d603-47c9-aadd-89f6017e48f3';
const PAYMENTS = '855b1079-8375-4d0d-a163-ddc96cdb696f';
const SUPPORT = '492743a3-6188-4b0b-b96b-5d57b66c7a66';
const BAYU = 'acc-bayu';
const LUKAS = 'acc-lukas';

const DEMO_SIGNALS: ReachSignal[] = [
  { signalId: 's1', daysBefore: 12, source: 'confluence', artifactId: '5079131' },
  { signalId: 's2a', daysBefore: 6, source: 'jsm', artifactId: '10046' },
  { signalId: 's2b', daysBefore: 6, source: 'jsm', artifactId: '10047' },
  { signalId: 's3', daysBefore: 3, source: 'jira', artifactId: '10052' },
];

const bayuTeams = [
  { id: 'aaaa0000-0000-0000-0000-000000000001', name: 'Zeta Guild' },
  { id: `ari:cloud:identity::team/${SUPPORT}`, name: 'Arkana Support' },
  { id: PLATFORM, name: 'Arkana Platform' },
  { id: 'aaaa0000-0000-0000-0000-000000000002', name: 'Alpha Chapter' },
];

const input = (over: Partial<TraceInput> = {}): TraceInput => ({
  incidentKey: 'INC-60',
  incidentStartedAt: '2026-11-03T09:12:00.000Z',
  simulated: false,
  responderTeamId: `ari:cloud:identity::team/${PAYMENTS}`,
  signals: DEMO_SIGNALS,
  via: 'resolver',
  deadline: Number.MAX_SAFE_INTEGER,
  relatedTerms: termsOf(['Checkout (Arkana Commerce)', 'payment gateway']),
  ...over,
});

function deps(over: Partial<TraceDeps> = {}): TraceDeps {
  return {
    touchesOf: vi.fn(async (s: ReachSignal) => ({
      ok: true as const,
      touches: [{ accountId: BAYU, role: s.source === 'confluence' ? ('contributor' as const) : ('watcher' as const), at: null }],
    })),
    teamsOf: vi.fn(async (id: string) => ({ ok: true as const, teams: id === BAYU ? bayuTeams : id === LUKAS ? [{ id: PAYMENTS, name: 'Arkana Payments' }] : [] })),
    now: () => 0,
    ...over,
  };
}

describe('teamUuid / termsOf', () => {
  it('normalises team ARIs and bare uuids', () => {
    expect(teamUuid(`ari:cloud:identity::team/${PAYMENTS.toUpperCase()}`)).toBe(PAYMENTS);
    expect(teamUuid(` ${PAYMENTS} `)).toBe(PAYMENTS);
  });
  it('keeps words of 4+ letters', () => {
    expect(termsOf(['Checkout (Arkana Commerce)', 'pay'])).toEqual(['checkout', 'arkana', 'commerce']);
  });
});

describe('traceReach', () => {
  it('demo: touched by Platform/Support, never Payments → 0/4 reached, stopped at Arkana Platform', async () => {
    const r = await traceReach(input(), deps());
    expect(r).toMatchObject({ partial: false, traced: 4, reached: 0 });
    for (const p of r.paths) {
      expect(p).toMatchObject({ reached: false, graphState: 'ok', responderTeamId: `ari:cloud:identity::team/${PAYMENTS}`, stopPoint: { teamId: PLATFORM, teamName: 'Arkana Platform', missingLinks: 1 } });
      // Service-related teams first, then by name.
      expect(p.steps.map((x) => x.teamName)).toEqual(['Arkana Platform', 'Arkana Support', 'Alpha Chapter', 'Zeta Guild']);
    }
    const json = JSON.stringify(r.paths);
    expect(json).not.toContain(BAYU);
    const metrics = computeMetrics(
      [
        { id: 's1', status: 'confirmed', daysBefore: 12 },
        { id: 's2a', status: 'confirmed', daysBefore: 6 },
        { id: 's2b', status: 'confirmed', daysBefore: 6 },
        { id: 's3', status: 'confirmed', daysBefore: 3 },
      ],
      r.paths.map((p) => ({ ...p })),
    );
    expect(metrics).toMatchObject({ confirmed: 4, reached: 0, considered: 4, unknown: 0, firstSignalDays: 12, awarenessGapDays: 12, stopPoint: { teamName: 'Arkana Platform', missingLinks: 1, signals: 4 } });
    expect(stopPointCopy(metrics!.stopPoint!, 'Arkana Payments')).toBe('Stopped at Arkana Platform · 1 missing link to Arkana Payments');
  });

  it('a responder member touching before the incident reaches it; a touch after the start does not', async () => {
    const touchesOf = vi.fn(async (s: ReachSignal) => ({
      ok: true as const,
      touches: [{ accountId: LUKAS, role: 'commenter' as const, at: s.signalId === 's1' ? '2026-10-25T10:00:00.000Z' : '2026-11-04T10:00:00.000Z' }],
    }));
    const r = await traceReach(input({ signals: DEMO_SIGNALS.slice(0, 2) }), deps({ touchesOf }));
    expect(r.paths.map((p) => p.reached)).toEqual([true, false]);
    expect(r.paths[0]!.stopPoint).toBeNull();
    // Stored step times are rounded to the day.
    expect(r.paths[0]!.steps.at(-1)).toEqual({ role: 'commenter', teamId: PAYMENTS, teamName: 'Arkana Payments', at: '2026-10-25T00:00:00.000Z' });
    expect(r.paths[1]!.stopPoint).toEqual({ teamId: null, teamName: null, missingLinks: 1 });
  });

  it('demo incident (simulated) skips the time check', async () => {
    const touchesOf = vi.fn(async () => ({ ok: true as const, touches: [{ accountId: LUKAS, role: 'author' as const, at: '2026-11-05T00:00:00.000Z' }] }));
    const r = await traceReach(input({ simulated: true, signals: DEMO_SIGNALS.slice(0, 1) }), deps({ touchesOf }));
    expect(r.paths[0]!.reached).toBe(true);
  });

  it('time unknown: a responder watcher without timestamp counts as reached, labelled time unknown in metrics', async () => {
    const touchesOf = vi.fn(async () => ({ ok: true as const, touches: [{ accountId: LUKAS, role: 'watcher' as const, at: null }] }));
    const r = await traceReach(input({ signals: DEMO_SIGNALS.slice(0, 1) }), deps({ touchesOf }));
    expect(r.paths[0]).toMatchObject({ reached: true, steps: [{ teamId: PAYMENTS, at: null }] });
    const m = computeMetrics([{ id: 's1', status: 'confirmed', daysBefore: 12 }], r.paths);
    expect(m).toMatchObject({ reached: 1, considered: 1, timeUnknown: 1, awarenessGapDays: 0, stopPoint: null });
  });

  it('unknown graph (touches or every team lookup failed) is kept out of the denominator', async () => {
    const touchesOf = vi.fn(async (s: ReachSignal) =>
      s.signalId === 's1' ? { ok: false as const, rateLimited: false } : { ok: true as const, touches: [{ accountId: 'acc-x', role: 'author' as const, at: null }] },
    );
    const teamsOf = vi.fn(async (id: string) => (id === 'acc-x' ? { ok: false as const, rateLimited: false } : { ok: true as const, teams: [] }));
    const r = await traceReach(input({ signals: DEMO_SIGNALS.slice(0, 3) }), deps({ touchesOf, teamsOf }));
    expect(r.paths.map((p) => p.graphState)).toEqual(['unknown', 'unknown', 'unknown']);
    const paths: ReachPathInput[] = [...r.paths.slice(0, 2), { ...r.paths[2]!, graphState: 'ok', reached: false, stopPoint: { teamId: null, teamName: null, missingLinks: 1 } }];
    const m = computeMetrics(
      [
        { id: 's1', status: 'confirmed', daysBefore: 12 },
        { id: 's2a', status: 'confirmed', daysBefore: 6 },
        { id: 's2b', status: 'confirmed', daysBefore: 6 },
        { id: 'x', status: 'proposed', daysBefore: 20 },
      ],
      paths,
    );
    expect(m).toMatchObject({ confirmed: 3, considered: 1, unknown: 2, reached: 0, firstSignalDays: 12 });
  });

  it('no human touch at all → ok, not reached, stopped at no team', async () => {
    const r = await traceReach(input({ signals: DEMO_SIGNALS.slice(0, 1) }), deps({ touchesOf: vi.fn(async () => ({ ok: true as const, touches: [] })) }));
    expect(r.paths[0]).toMatchObject({ graphState: 'ok', reached: false, hopCount: 0, steps: [], stopPoint: { teamName: null } });
  });

  it(`traces at most ${MAX_TRACE_SIGNALS} signals; the rest are pending (partial)`, async () => {
    const many = Array.from({ length: 23 }, (_, i): ReachSignal => ({ signalId: `s${String(i).padStart(2, '0')}`, daysBefore: 30 - i, source: 'jira', artifactId: String(i) }));
    const d = deps();
    const r = await traceReach(input({ signals: many }), d);
    expect(r.traced).toBe(20);
    expect(r.partial).toBe(true);
    expect(r.paths.filter((p) => p.graphState === 'pending').map((p) => p.signalId)).toEqual(['s20', 's21', 's22']);
    expect(d.touchesOf).toHaveBeenCalledTimes(20);
  });

  it('stops at the deadline and on a 429 (rest pending)', async () => {
    // now() is read before each signal and before each team lookup: 0,1 → s1 traced; 2 → stop.
    let t = 0;
    const r1 = await traceReach(input({ deadline: 2 }), deps({ now: () => t++ }));
    expect(r1.paths.map((p) => p.graphState)).toEqual(['ok', 'pending', 'pending', 'pending']);
    // The deadline is also checked inside a signal, between team lookups.
    let u = 0;
    const r3 = await traceReach(input({ deadline: 1, signals: DEMO_SIGNALS.slice(0, 1) }), deps({ now: () => u++ }));
    expect(r3.paths[0]!.graphState).toBe('pending');
    const teamsOf = vi.fn(async () => ({ ok: false as const, rateLimited: true }));
    const r2 = await traceReach(input(), deps({ teamsOf }));
    expect(r2).toMatchObject({ rateLimited: true, partial: true, traced: 0 });
    expect(teamsOf).toHaveBeenCalledTimes(1);
  });
});

describe('computeMetrics', () => {
  it('is null without confirmed signals', () => {
    expect(computeMetrics([{ id: 'a', status: 'proposed', daysBefore: 3 }], [])).toBeNull();
  });
  it('gap = first − latest reached; untraced confirmed signals count as unknown', () => {
    const ok = (signalId: string, reached: boolean) => ({ signalId, reached, graphState: 'ok' as const, steps: [], stopPoint: reached ? null : { teamId: 't', teamName: 'T', missingLinks: 1 }, responderTeamId: PAYMENTS });
    const m = computeMetrics(
      [
        { id: 'a', status: 'confirmed', daysBefore: 12 },
        { id: 'b', status: 'confirmed', daysBefore: 5 },
        { id: 'c', status: 'confirmed', daysBefore: 2 },
      ],
      [ok('a', false), ok('b', true)],
    );
    expect(m).toMatchObject({ firstSignalDays: 12, awarenessGapDays: 7, reached: 1, considered: 2, unknown: 1 });
  });
});

describe('traceReach fixes', () => {
  it('traces signals without a known path first ("Trace remaining" moves forward)', async () => {
    const d = deps();
    const r = await traceReach(input({ maxSignals: 2, alreadyOk: new Set(['s1', 's2a']) }), d);
    expect((d.touchesOf as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as ReachSignal).signalId)).toEqual(['s2b', 's3']);
    expect(r.paths.filter((p) => p.graphState === 'pending').map((p) => p.signalId).sort()).toEqual(['s1', 's2a']);
  });

  it('an invalid incident start never throws; responder touches count as time unknown', async () => {
    const touchesOf = vi.fn(async () => ({ ok: true as const, touches: [{ accountId: LUKAS, role: 'author' as const, at: '2026-10-01T00:00:00.000Z' }, { accountId: BAYU, role: 'author' as const, at: 'not a date' }] }));
    const r = await traceReach(input({ incidentStartedAt: 'garbage', signals: DEMO_SIGNALS.slice(0, 1) }), deps({ touchesOf }));
    expect(r.paths[0]).toMatchObject({ graphState: 'ok', reached: true });
    expect(computeMetrics([{ id: 's1', status: 'confirmed', daysBefore: 12 }], r.paths)).toMatchObject({ timeUnknown: 1 });
  });

  it('stop point is the team that touched last; people in no team carry neither role nor time', async () => {
    const OTHER = 'acc-other';
    const NOBODY = 'acc-nobody';
    const touchesOf = vi.fn(async () => ({
      ok: true as const,
      touches: [
        { accountId: BAYU, role: 'contributor' as const, at: '2026-10-20T08:00:00.000Z' },
        { accountId: OTHER, role: 'commenter' as const, at: '2026-10-28T08:00:00.000Z' },
        { accountId: NOBODY, role: 'commenter' as const, at: '2026-10-29T08:00:00.000Z' },
      ],
    }));
    const teamsOf = vi.fn(async (id: string) => ({
      ok: true as const,
      teams: id === BAYU ? [{ id: PLATFORM, name: 'Arkana Platform' }] : id === OTHER ? [{ id: 'bbbb0000-0000-0000-0000-000000000009', name: 'Zeta Guild' }] : [],
    }));
    const r = await traceReach(input({ signals: DEMO_SIGNALS.slice(0, 1) }), deps({ touchesOf, teamsOf }));
    expect(r.paths[0]!.stopPoint).toMatchObject({ teamName: 'Zeta Guild' });
    expect(r.paths[0]!.steps).toContainEqual({ role: '', teamId: null, teamName: null, at: null });
  });
});
