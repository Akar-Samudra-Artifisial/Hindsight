import { invoke } from '@forge/bridge';
import { useCallback, useEffect, useState } from 'react';
import { mount } from './mount';

/** Temporary incident panel (polished in week 3): Analyze, job status + funnel, and the kept candidates. */

interface Funnel {
  scanned: number;
  stored: number;
  candidates: number;
  truncated: number;
}

interface CandidateView {
  id: string;
  title: string;
  source: string;
  kind: string;
  artifactKey: string | null;
  url: string | null;
  daysBefore: number;
  score: number;
  hintType: string | null;
  excerpt: string | null;
}

interface JobView {
  id: string;
  status: string;
  lastError: string | null;
  limited: boolean;
  serviceKey: string | null;
  windowDays: number;
  progress: { collect?: { phase?: string; pages?: number; processed?: number } } | null;
}

interface AnalysisReply {
  ready: true;
  incidentKey: string;
  simulated: boolean;
  scenarioStartedAt: string | null;
  job: JobView | null;
  funnel: Funnel | null;
  candidates: CandidateView[];
  hiddenCount: number;
}

type Reply = AnalysisReply | { error: string } | { ready: false; applied: number; total: number };

const RUNNING = new Set(['queued', 'collecting', 'filtering']);
const SOURCE_LABEL: Record<string, string> = { jira: 'Jira', jsm: 'Service desk', confluence: 'Confluence' };
const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  collecting: 'Collecting Jira and Confluence activity',
  filtering: 'Filtering candidates',
  scoring: 'Candidates ready (AI scoring comes next)',
  done: 'Done',
  failed: 'Failed',
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const s = {
  main: { fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 14, color: '#172b4d', padding: '4px 0' },
  muted: { color: '#626f86', fontSize: 12 },
  warn: { background: '#fff7d6', padding: '6px 8px', borderRadius: 4, fontSize: 12, margin: '8px 0' },
  item: { borderTop: '1px solid #dcdfe4', padding: '8px 0' },
  badge: { display: 'inline-block', background: '#e9f2ff', color: '#0055cc', borderRadius: 3, padding: '1px 6px', fontSize: 11, fontWeight: 600, marginLeft: 8 },
} as const;

function App() {
  const [reply, setReply] = useState<Reply | null>(null);
  const [busy, setBusy] = useState(false);
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

  if (reply && 'ready' in reply && !reply.ready) {
    return <main style={s.main}>Hindsight is setting up its database ({reply.applied}/{reply.total}). Try again in a minute.</main>;
  }
  const analysis = reply && 'job' in reply ? reply : null;
  const collect = job?.progress?.collect;

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
      {error && <p style={{ color: '#ae2e24' }}>{error}</p>}
      {reply && 'error' in reply && <p style={{ color: '#ae2e24' }}>{reply.error}</p>}
      {!reply && !error && <p style={s.muted}>Loading…</p>}
      {analysis && !job && <p style={s.muted}>No analysis yet. Analyze looks back 30 days for early signals of this incident.</p>}
      {job && (
        <section>
          <p>
            <strong>{STATUS_LABEL[job.status] ?? job.status}</strong>
            {running && collect ? ` · ${collect.processed ?? 0} items, ${collect.pages ?? 0} pages` : ''}
          </p>
          {job.lastError && <p style={{ color: '#ae2e24', fontSize: 12 }}>{job.lastError}</p>}
          {job.limited && <p style={s.warn}>Limited scope: this incident is not mapped to a service, so every mapped project and space was searched.</p>}
          {analysis?.funnel && (
            <p style={s.muted}>
              {analysis.funnel.scanned} scanned → {analysis.funnel.stored} in the {job.windowDays}-day window → {analysis.funnel.candidates} candidates
              {analysis.funnel.truncated > 0 ? ` (${analysis.funnel.truncated} lower-ranked not shown)` : ''}
            </p>
          )}
          {analysis && analysis.hiddenCount > 0 && <p style={s.muted}>{analysis.hiddenCount} candidates are in places you cannot view.</p>}
          {analysis?.candidates.map((c) => (
            <article key={c.id} style={s.item}>
              <div>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.title || c.artifactKey || 'Untitled'}
                  </a>
                ) : (
                  c.title || 'Untitled'
                )}
              </div>
              <div style={s.muted}>
                {SOURCE_LABEL[c.source] ?? c.source} {c.kind} · {c.daysBefore} days before · score {c.score}
                {c.hintType ? ` · ${c.hintType.replace(/_/g, ' ')}` : ''}
              </div>
              {c.excerpt && <div style={{ fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' }}>{c.excerpt.slice(0, 240)}</div>}
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

mount(<App />);
