/**
 * Routes, best first: source, counterfactual lead time (with its assumption), reason, Approve / Pause / Resume and,
 * for approved routes, what Sentinel did last (alert, matched keywords, time) with Useful / Not useful.
 */
import { daysSavedCopy, plural, sourceLabel, type AlertsByRoute, type AlertView, type RouteView } from './reach';
import { safeUrl } from './url';

const STATUS: Record<RouteView['status'], { label: string; bg: string; fg: string }> = {
  proposed: { label: 'Proposed', bg: '#f1f2f4', fg: '#44546f' },
  active: { label: 'Active', bg: '#dcfff1', fg: '#216e4e' },
  paused: { label: 'Paused', bg: '#fff7d6', fg: '#7f5f01' },
  dismissed: { label: 'Dismissed', bg: '#ffeceb', fg: '#ae2e24' },
};

const REASON: Record<string, string> = {
  weekly_cap: 'skipped: weekly alert cap reached for this team',
  rate_limited: 'not posted: Atlassian rate limit, retries ran out',
  api_error: 'not posted: the comment could not be written',
  posting: 'not posted: the comment did not complete',
};

const pill = (bg: string, fg: string) => ({ background: bg, color: fg, borderRadius: 3, padding: '1px 6px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' as const });
const button = (primary: boolean) => ({
  border: primary ? 'none' : '1px solid #dcdfe4',
  borderRadius: 3,
  padding: '4px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  background: primary ? '#0c66e4' : '#ffffff',
  color: primary ? '#ffffff' : '#44546f',
});
const muted = { margin: 0, fontSize: 11, color: '#626f86' };

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function LastAlert({ entry, busy, onFeedback }: { entry: { postedCount: number; last: AlertView }; busy: string | null; onFeedback: (alertId: string, feedback: 'useful' | 'not_useful') => void }) {
  const a = entry.last;
  const href = safeUrl(a.url);
  const title = a.title ?? 'a place you cannot view';
  return (
    <div style={{ marginTop: 8, padding: 8, background: '#f7f8f9', borderRadius: 4 }} aria-label="Latest Sentinel alert">
      <p style={{ margin: 0, fontSize: 12 }}>
        <strong>Sentinel</strong> · {plural(entry.postedCount, 'alert posted', 'alerts posted')}
      </p>
      <p style={{ margin: '4px 0 2px', fontSize: 12 }}>
        Last {a.status === 'posted' ? 'alert' : 'match'} on{' '}
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {title}
          </a>
        ) : (
          title
        )}
        {a.status !== 'posted' && <span style={{ color: '#7f5f01' }}> ({REASON[a.reason ?? ''] ?? 'not posted'})</span>}
      </p>
      <p style={muted}>
        {a.matchedKeywords.length > 0 ? `Matched: ${a.matchedKeywords.join(', ')} · ` : ''}
        {when(a.createdAt)}
      </p>
      {a.status === 'posted' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
          <span style={muted}>Was this alert useful?</span>
          {(['useful', 'not_useful'] as const).map((f) => (
            <button
              key={f}
              type="button"
              disabled={busy !== null}
              aria-pressed={a.feedback === f}
              onClick={() => onFeedback(a.alertId, f)}
              style={{ ...button(a.feedback === f), padding: '2px 8px', fontSize: 11 }}
            >
              {f === 'useful' ? 'Useful' : 'Not useful'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function RoutesList({
  routes,
  responder,
  alerts,
  note,
  busy,
  onDecide,
  onFeedback,
}: {
  routes: RouteView[];
  responder: string;
  alerts: AlertsByRoute;
  /** Message for one route, e.g. why Pause/Resume was refused. */
  note: { routeId: string; text: string } | null;
  busy: string | null;
  onDecide: (routeId: string, status: 'active' | 'paused') => void;
  onFeedback: (alertId: string, feedback: 'useful' | 'not_useful') => void;
}) {
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
      {routes.map((r) => {
        const st = STATUS[r.status];
        const entry = alerts[r.routeId];
        return (
          <li
            key={r.routeId}
            style={{ border: `1px solid ${r.status === 'active' ? '#4bce97' : r.status === 'paused' ? '#f5cd47' : '#dcdfe4'}`, borderRadius: 6, padding: 10, margin: '8px 0' }}
            aria-label={`Route ${r.rank}: ${sourceLabel(r.sourceType, r.sourceKey)}`}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, color: '#626f86' }}>#{r.rank}</span>
              <strong>
                {sourceLabel(r.sourceType, r.sourceKey)} → mention {responder}
              </strong>
              <span style={pill(st.bg, st.fg)}>{st.label}</span>
            </div>
            <p style={{ margin: '6px 0 2px', fontSize: 16, fontWeight: 700, color: '#0055cc' }}>{daysSavedCopy(r.estimatedDaysSaved, r.maxDaysBefore)}</p>
            <p style={muted}>Assumes the mention is read and acted on.</p>
            <p style={{ margin: '6px 0', fontSize: 12 }}>{r.reason}</p>
            {r.keywords.length > 0 && <p style={{ ...muted, marginBottom: 6 }}>Matches: {r.keywords.join(', ')}</p>}
            {r.status === 'active' && <p style={{ ...muted, marginBottom: 6 }}>Sentinel is watching new comments and pages here and alerts {responder} on a match.</p>}
            {r.status === 'paused' && <p style={{ ...muted, marginBottom: 6 }}>Paused: Sentinel posts no alerts for this route until it is resumed.</p>}
            {r.status === 'proposed' && (
              <button type="button" disabled={busy !== null} onClick={() => onDecide(r.routeId, 'active')} style={button(true)}>
                {busy === r.routeId ? 'Approving…' : 'Approve'}
              </button>
            )}
            {r.status === 'active' && (
              <button type="button" disabled={busy !== null} onClick={() => onDecide(r.routeId, 'paused')} style={button(false)}>
                {busy === r.routeId ? 'Pausing…' : 'Pause'}
              </button>
            )}
            {r.status === 'paused' && (
              <button type="button" disabled={busy !== null} onClick={() => onDecide(r.routeId, 'active')} style={button(true)}>
                {busy === r.routeId ? 'Resuming…' : 'Resume'}
              </button>
            )}
            {note?.routeId === r.routeId && (
              <p role="alert" style={{ margin: '6px 0 0', fontSize: 12, color: '#ae2e24' }}>
                {note.text}
              </p>
            )}
            {(r.status === 'active' || r.status === 'paused') && <p style={{ ...muted, marginTop: 4 }}>Pause and Resume are for Jira administrators.</p>}
            {entry && (r.status === 'active' || r.status === 'paused') && <LastAlert entry={entry} busy={busy} onFeedback={onFeedback} />}
          </li>
        );
      })}
    </ol>
  );
}
