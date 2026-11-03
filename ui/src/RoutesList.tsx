/** Proposed routes, best first: source, counterfactual lead time (with its assumption), reason and Approve. */
import { daysSavedCopy, sourceLabel, type RouteView } from './reach';

const STATUS: Record<RouteView['status'], { label: string; bg: string; fg: string }> = {
  proposed: { label: 'Proposed', bg: '#f1f2f4', fg: '#44546f' },
  active: { label: 'Active', bg: '#dcfff1', fg: '#216e4e' },
  dismissed: { label: 'Dismissed', bg: '#ffeceb', fg: '#ae2e24' },
};

const pill = (bg: string, fg: string) => ({ background: bg, color: fg, borderRadius: 3, padding: '1px 6px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' as const });

export function RoutesList({ routes, responder, busy, onApprove }: { routes: RouteView[]; responder: string; busy: string | null; onApprove: (routeId: string) => void }) {
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
      {routes.map((r) => {
        const st = STATUS[r.status];
        return (
          <li
            key={r.routeId}
            style={{ border: `1px solid ${r.status === 'active' ? '#4bce97' : '#dcdfe4'}`, borderRadius: 6, padding: 10, margin: '8px 0' }}
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
            <p style={{ margin: 0, fontSize: 11, color: '#626f86' }}>Assumes the mention is read and acted on.</p>
            <p style={{ margin: '6px 0', fontSize: 12 }}>{r.reason}</p>
            {r.keywords.length > 0 && <p style={{ margin: '0 0 6px', fontSize: 11, color: '#626f86' }}>Matches: {r.keywords.join(', ')}</p>}
            {r.status === 'proposed' && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => onApprove(r.routeId)}
                style={{ border: 'none', borderRadius: 3, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: '#0c66e4', color: '#ffffff' }}
              >
                {busy === r.routeId ? 'Approving…' : 'Approve'}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
