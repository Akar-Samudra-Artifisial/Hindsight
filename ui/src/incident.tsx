import { invoke } from '@forge/bridge';
import { useCallback, useEffect, useState } from 'react';
import { mount } from './mount';
import { SignalCard, type Decision, type SignalView } from './SignalCard';

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
      {signals.map((sig) => (
        <SignalCard key={sig.id} signal={sig} busy={deciding !== null} onDecide={(d) => decide(sig.id, d)} />
      ))}
    </main>
  );
}

mount(<App />);
