import { invoke } from '@forge/bridge';
import { useCallback, useEffect, useState } from 'react';
import { mount } from './mount';
import { ReachMap } from './ReachMap';
import { RoutesList } from './RoutesList';
import { SignalCard, type Decision, type SignalView } from './SignalCard';
import { stopCopy, type ReachView } from './reach';

/** Incident panel: Analyze, job status + funnel, and the scored early signals with Confirm / Reject / Undo. */

interface Funnel {
  scanned: number;
  stored: number;
  candidates: number;
  truncated: number;
}

interface JobView {
  id: string;
  status: string;
  lastError: string | null;
  limited: boolean;
  serviceKey: string | null;
  windowDays: number;
  progress: {
    collect?: { phase?: string; pages?: number; processed?: number };
    score?: { done?: number; total?: number; signals?: number; failed?: number };
  } | null;
}

interface AnalysisReply {
  ready: true;
  incidentKey: string;
  simulated: boolean;
  scenarioStartedAt: string | null;
  job: JobView | null;
  funnel: Funnel | null;
  signals: SignalView[];
  hiddenCount: number;
  scoreFailedCount: number;
  scoreFailed: { quoteNotFound: number; invalidOutput: number };
  reach: ReachView;
}

type Tab = 'signals' | 'reach' | 'routes';
const TABS: [Tab, string][] = [
  ['signals', 'Signals'],
  ['reach', 'Reach map'],
  ['routes', 'Routes'],
];

const NO_GRAPH: Record<string, string> = {
  no_responder_team: 'Graph context not available: this incident has no responder team. An admin can set the owner team id of its service on the Hindsight setup page.',
  no_site_id: 'Graph context not available: Hindsight could not tell which site this is.',
};

const ROUTES_NOTE: Record<string, string> = {
  none_needed: 'No routes needed: every confirmed signal with graph context reached the responder team.',
  no_graph: 'No routes yet: trace reach first. Routes are proposed from confirmed signals that did not reach the responder team.',
  no_source: 'No routes: the signals that did not reach the responder team have no space, project, component or label to route from.',
};

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 110, background: '#f7f8f9', borderRadius: 6, padding: '8px 10px' }}>
      <div style={{ fontSize: 11, color: '#626f86', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#172b4d' }}>{value}</div>
      {note && <div style={{ fontSize: 11, color: '#626f86' }}>{note}</div>}
    </div>
  );
}

function MetricsStrip({ reach }: { reach: ReachView }) {
  if (!reach.graphAvailable) return <p style={s.muted}>{NO_GRAPH[reach.reason ?? 'no_responder_team']}</p>;
  const m = reach.metrics;
  if (!m) return <p style={s.muted}>Confirm a signal to compute reach.</p>;
  const responder = reach.responderTeamName ?? 'the responder team';
  return (
    <section aria-label="Reach metrics">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
        <Metric label="First signal" value={`${m.firstSignalDays} d`} note="before the incident" />
        <Metric label="Awareness gap" value={`${m.awarenessGapDays} d`} note={m.reached > 0 ? `until a signal reached ${responder}` : `no signal reached ${responder}`} />
        <Metric
          label="Reach"
          value={m.considered > 0 ? `${m.reached}/${m.considered}` : '–'}
          note={`confirmed signals${m.unknown > 0 ? ` · ${m.unknown} without graph context` : ''}${m.timeUnknown > 0 ? ` · ${m.timeUnknown} time unknown` : ''}`}
        />
      </div>
      {m.stopPoint && m.reached < m.considered && <p style={{ margin: '4px 0', fontSize: 13, fontWeight: 600, color: '#ae2e24' }}>{stopCopy(m.stopPoint, responder)}</p>}
    </section>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Reply = AnalysisReply | { error: string } | { ready: false; applied: number; total: number };

const RUNNING = new Set(['queued', 'collecting', 'filtering', 'scoring']);
const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  collecting: 'Collecting Jira and Confluence activity',
  filtering: 'Filtering candidates',
  scoring: 'Scoring candidates with AI',
  done: 'Analysis complete',
  failed: 'Analysis failed',
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const s = {
  main: { fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 14, color: '#172b4d', padding: '4px 0' },
  muted: { color: '#626f86', fontSize: 12 },
  warn: { background: '#fff7d6', padding: '6px 8px', borderRadius: 4, fontSize: 12, margin: '8px 0' },
  danger: { background: '#ffeceb', color: '#ae2e24', padding: '6px 8px', borderRadius: 4, fontSize: 12, margin: '8px 0' },
  badge: { display: 'inline-block', background: '#e9f2ff', color: '#0055cc', borderRadius: 3, padding: '1px 6px', fontSize: 11, fontWeight: 600, marginLeft: 8 },
  link: { background: 'none', border: 'none', color: '#0c66e4', padding: 0, marginLeft: 6, cursor: 'pointer', fontSize: 12 },
} as const;

function statusLine(job: JobView): string {
  const label = STATUS_LABEL[job.status] ?? job.status;
  const score = job.progress?.score;
  if (job.status === 'scoring' && score?.total) return `${label} (${score.done ?? 0}/${score.total})`;
  const collect = job.progress?.collect;
  if ((job.status === 'collecting' || job.status === 'filtering') && collect) return `${label} · ${collect.processed ?? 0} items, ${collect.pages ?? 0} pages`;
  return label;
}

function App() {
  const [reply, setReply] = useState<Reply | null>(null);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('signals');
  const [tracing, setTracing] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke('getAnalysis', {})
      .then((r) => {
        setReply(r as Reply);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(load, [load]);

  const job = reply && 'job' in reply ? reply.job : null;
  const running = job !== null && RUNNING.has(job.status);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const analyze = () => {
    setBusy(true);
    invoke('startAnalysis', {})
      .then((r) => {
        const res = r as Reply;
        if ('error' in res) setError(res.error);
        load();
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const decide = (signalId: string, decision: Decision) => {
    setDeciding(signalId);
    invoke('decideSignal', { signalId, decision })
      .then((r) => {
        const res = r as { error?: string };
        if (res.error) setError(res.error);
        load();
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setDeciding(null));
  };

  const trace = () => {
    setTracing(true);
    invoke('traceReach', {})
      .then((r) => {
        const res = r as { error?: string };
        if (res.error) setError(res.error);
        else setError(null);
        load();
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setTracing(false));
  };

  const approve = (routeId: string) => {
    setApproving(routeId);
    invoke('decideRoute', { routeId })
      .then((r) => {
        const res = r as { error?: string };
        if (res.error) setError(res.error);
        load();
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setApproving(null));
  };

  if (reply && 'ready' in reply && !reply.ready) {
    return <main style={s.main}>Hindsight is setting up its database ({reply.applied}/{reply.total}). Try again in a minute.</main>;
  }
  const analysis = reply && 'job' in reply ? reply : null;
  const signals = analysis?.signals ?? [];
  const confirmed = signals.filter((x) => x.status === 'confirmed').length;

  return (
    <main style={s.main}>
      <button type="button" onClick={analyze} disabled={busy || running}>
        {running ? 'Analyzing…' : job ? 'Analyze again' : 'Analyze'}
      </button>
      {analysis?.simulated && (
        <span
          style={s.badge}
          title={`Demo data: dates are simulated relative to an incident start of ${analysis.scenarioStartedAt ? new Date(analysis.scenarioStartedAt).toLocaleString() : 'the scenario'}.`}
        >
          Simulated history
        </span>
      )}
      {error && <p style={s.danger}>{error}</p>}
      {reply && 'error' in reply && <p style={s.danger}>{reply.error}</p>}
      {!reply && !error && <p style={s.muted}>Loading…</p>}
      {analysis && !job && <p style={s.muted}>No analysis yet. Analyze looks back 30 days for early signals of this incident.</p>}
      {job && (
        <section>
          <p>
            <strong>{statusLine(job)}</strong>
          </p>
          {job.status === 'failed' && (
            <p style={s.danger}>
              {job.lastError ?? 'The analysis stopped.'}
              <button type="button" style={s.link} onClick={analyze} disabled={busy}>
                Retry
              </button>
            </p>
          )}
          {job.limited && <p style={s.warn}>Limited scope: this incident is not mapped to a service, so every mapped project and space was searched.</p>}
          {analysis?.funnel && (
            <p style={s.muted}>
              {analysis.funnel.scanned} scanned → {analysis.funnel.stored} in the {job.windowDays}-day window → {analysis.funnel.candidates} candidates
              {job.status === 'done' ? ` → ${signals.length} signals` : ''}
              {confirmed > 0 ? ` (${confirmed} confirmed)` : ''}
            </p>
          )}
          {analysis && analysis.scoreFailedCount > 0 && job.status === 'done' && (
            <p style={s.warn}>
              {[
                analysis.scoreFailed.quoteNotFound > 0
                  ? `${plural(analysis.scoreFailed.quoteNotFound, 'candidate was', 'candidates were')} left out because the AI quote was not found word for word in the source.`
                  : '',
                analysis.scoreFailed.invalidOutput > 0
                  ? `${plural(analysis.scoreFailed.invalidOutput, 'candidate', 'candidates')} could not be scored because the AI returned an unusable answer.`
                  : '',
              ]
                .filter((t) => t !== '')
                .join(' ') || `${plural(analysis.scoreFailedCount, 'candidate', 'candidates')} could not be scored.`}
              <button type="button" style={s.link} onClick={analyze} disabled={busy}>
                Retry
              </button>
            </p>
          )}
          {analysis && analysis.hiddenCount > 0 && <p style={s.muted}>{analysis.hiddenCount} signals are in places you cannot view.</p>}
          {job.status === 'done' && signals.length === 0 && <p style={s.muted}>No early signals found in the lookback window.</p>}
        </section>
      )}
      {analysis && signals.length > 0 && (
        <>
          <MetricsStrip reach={analysis.reach} />
          <div role="tablist" aria-label="Analysis views" style={{ display: 'flex', gap: 4, borderBottom: '2px solid #dcdfe4', margin: '10px 0 4px' }}>
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`panel-${key}`}
                onClick={() => setTab(key)}
                style={{
                  border: 'none',
                  background: 'none',
                  padding: '6px 10px',
                  marginBottom: -2,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  color: tab === key ? '#0c66e4' : '#44546f',
                  borderBottom: `2px solid ${tab === key ? '#0c66e4' : 'transparent'}`,
                }}
              >
                {label}
                {key === 'routes' && analysis.reach.routes.length > 0 ? ` (${analysis.reach.routes.length})` : ''}
              </button>
            ))}
          </div>
          <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'signals' &&
              signals.map((sig) => <SignalCard key={sig.id} signal={sig} busy={deciding !== null} onDecide={(d) => decide(sig.id, d)} />)}
            {tab !== 'signals' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
                <button type="button" onClick={trace} disabled={tracing || confirmed === 0 || !analysis.reach.graphAvailable}>
                  {tracing ? 'Tracing…' : analysis.reach.paths.length > 0 ? 'Trace again' : 'Trace reach'}
                </button>
                {analysis.reach.metrics && analysis.reach.metrics.pending > 0 && (
                  <span style={s.warn}>
                    Partial: {plural(analysis.reach.metrics.pending, 'signal was', 'signals were')} not traced yet.
                    <button type="button" style={s.link} onClick={trace} disabled={tracing}>
                      Trace remaining
                    </button>
                  </span>
                )}
                {analysis.reach.simulated && <span style={s.muted}>Simulated history: touch times are not compared with the incident start.</span>}
              </div>
            )}
            {tab === 'reach' &&
              (analysis.reach.paths.length > 0 ? (
                <ReachMap reach={analysis.reach} signals={signals} />
              ) : (
                <p style={s.muted}>{confirmed === 0 ? 'Confirm a signal, then trace where it travelled.' : 'Not traced yet. Trace reach shows which teams saw each confirmed signal.'}</p>
              ))}
            {tab === 'routes' &&
              (analysis.reach.routes.length > 0 ? (
                <RoutesList routes={analysis.reach.routes} responder={analysis.reach.responderTeamName ?? 'the responder team'} busy={approving} onApprove={approve} />
              ) : (
                <p style={s.muted}>{ROUTES_NOTE[analysis.reach.routesNote ?? 'no_graph']}</p>
              ))}
          </section>
        </>
      )}
    </main>
  );
}

mount(<App />);
