import type { DecisionKind, Signal, SignalDecisionInput, SignalStatus, StoredEvent } from '../adapters/repo';
import { filterVisible, type AccessDeps } from './access';
import { InputError } from './validate';

/**
 * Human decisions on signals, shared by the incident panel (`decideSignal` resolver) and the Rovo action
 * `confirm-signal`, plus the signal list both show. Every call runs as the current user: the incident and the
 * signal's artifact must be visible to them. `decided_by` is stored for audit and never returned.
 */

export type DecisionErrorCode = 'forbidden' | 'not_found' | 'invalid_transition' | 'conflict';

export class DecisionError extends InputError {
  constructor(
    readonly code: DecisionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** proposed → confirmed | rejected; confirmed | rejected → proposed (undo). Anything else is null. */
export function nextStatus(from: SignalStatus, decision: DecisionKind): SignalStatus | null {
  if (from === 'proposed' && decision === 'confirm') return 'confirmed';
  if (from === 'proposed' && decision === 'reject') return 'rejected';
  if ((from === 'confirmed' || from === 'rejected') && decision === 'undo') return 'proposed';
  return null;
}

export interface SignalView {
  id: string;
  signalType: string;
  status: SignalStatus;
  quote: string;
  reason: string;
  confidence: number;
  daysBefore: number;
  title: string;
  source: string;
  kind: string;
  artifactKey: string | null;
  url: string | null;
}

const STATUS_ORDER: Record<SignalStatus, number> = { confirmed: 0, proposed: 1, rejected: 2 };

/** Confirmed first, then proposed, then rejected; earliest (most days before) first within a status. */
export function sortSignals<T extends { status: SignalStatus; daysBefore: number; id: string }>(signals: readonly T[]): T[] {
  return [...signals].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.daysBefore - a.daysBefore || a.id.localeCompare(b.id));
}

export interface SignalReadDeps extends AccessDeps {
  repo: {
    listSignalsForIncident(incidentKey: string): Promise<Signal[]>;
    getEventsByIds(ids: readonly string[]): Promise<StoredEvent[]>;
  };
}

function toView(s: Signal, e: StoredEvent): SignalView {
  return {
    id: s.id,
    signalType: s.signalType,
    status: s.status,
    quote: s.quote,
    reason: s.reason,
    confidence: s.confidence,
    daysBefore: s.daysBefore,
    title: e.title,
    source: e.source,
    kind: e.kind,
    artifactKey: e.artifactKey,
    url: e.url,
  };
}

/** Signals of the incident whose artifact the current user can view (sorted); the others are only counted. */
export async function listVisibleSignals(incidentKey: string, deps: SignalReadDeps): Promise<{ signals: SignalView[]; hiddenCount: number }> {
  const signals = await deps.repo.listSignalsForIncident(incidentKey);
  if (signals.length === 0) return { signals: [], hiddenCount: 0 };
  const events = new Map((await deps.repo.getEventsByIds([...new Set(signals.map((s) => s.eventId))])).map((e) => [e.id, e]));
  const { visible, hiddenCount } = await filterVisible(
    signals.map((s) => ({ signal: s, event: events.get(s.eventId) })),
    deps,
  );
  const views = visible.flatMap(({ signal, event }) => (event ? [toView(signal, event)] : []));
  return { signals: sortSignals(views), hiddenCount };
}

export interface DecideDeps extends AccessDeps {
  getIncidentAsUser(key: string): Promise<unknown>;
  repo: {
    getSignal(id: string): Promise<Signal | undefined>;
    getEventsByIds(ids: readonly string[]): Promise<StoredEvent[]>;
    updateSignalStatus(id: string, from: SignalStatus, to: SignalStatus): Promise<number>;
    insertDecision(d: SignalDecisionInput): Promise<void>;
  };
}

export interface DecideInput {
  incidentKey: string;
  signalId: string;
  decision: DecisionKind;
  accountId: string;
}

const ALREADY: Record<SignalStatus, string> = {
  proposed: 'This signal has no decision to undo.',
  confirmed: 'This signal is already confirmed. Undo it first.',
  rejected: 'This signal is already rejected. Undo it first.',
};

/** Applies one decision as the current user; returns the signal's new status. */
export async function decideSignal(input: DecideInput, deps: DecideDeps): Promise<{ id: string; status: SignalStatus; previousStatus: SignalStatus }> {
  if (!(await deps.getIncidentAsUser(input.incidentKey))) {
    throw new DecisionError('forbidden', `Incident ${input.incidentKey} was not found, or you do not have permission to view it.`);
  }
  const notFound = new DecisionError('not_found', `Signal ${input.signalId} was not found on ${input.incidentKey}.`);
  const signal = await deps.repo.getSignal(input.signalId);
  if (!signal || signal.incidentKey !== input.incidentKey) throw notFound;
  const [event] = await deps.repo.getEventsByIds([signal.eventId]);
  const { visible } = await filterVisible([{ event }], deps);
  // A signal on an artifact the user cannot view is reported as missing, so its existence does not leak.
  if (visible.length === 0) throw notFound;
  const to = nextStatus(signal.status, input.decision);
  if (!to) throw new DecisionError('invalid_transition', ALREADY[signal.status]);
  if ((await deps.repo.updateSignalStatus(signal.id, signal.status, to)) !== 1) {
    throw new DecisionError('conflict', 'This signal was changed by someone else. Refresh and try again.');
  }
  await deps.repo.insertDecision({ signalId: signal.id, incidentKey: input.incidentKey, decision: input.decision, decidedBy: input.accountId });
  return { id: signal.id, status: to, previousStatus: signal.status };
}
