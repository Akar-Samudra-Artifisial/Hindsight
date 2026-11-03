/** One scored early signal: type, timing, confidence, verbatim quote, link to the source and the human decision. */
import { safeUrl } from './url';

export type SignalStatus = 'proposed' | 'confirmed' | 'rejected';
export type Decision = 'confirm' | 'reject' | 'undo';

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

const TYPE: Record<string, { label: string; bg: string; fg: string }> = {
  technical_warning: { label: 'Technical warning', bg: '#fff3eb', fg: '#a54800' },
  customer_complaint: { label: 'Customer complaint', bg: '#ffeceb', fg: '#ae2e24' },
  external_change: { label: 'External change', bg: '#f3f0ff', fg: '#5e4db2' },
  unanswered_question: { label: 'Unanswered question', bg: '#e9f2ff', fg: '#0055cc' },
};

const STATUS: Record<SignalStatus, { label: string; bg: string; fg: string }> = {
  proposed: { label: 'Proposed', bg: '#f1f2f4', fg: '#44546f' },
  confirmed: { label: 'Confirmed', bg: '#dcfff1', fg: '#216e4e' },
  rejected: { label: 'Rejected', bg: '#ffeceb', fg: '#ae2e24' },
};

const SOURCE: Record<string, string> = { jira: 'Jira', jsm: 'Jira', confluence: 'Confluence' };

const pill = (bg: string, fg: string) => ({ background: bg, color: fg, borderRadius: 3, padding: '1px 6px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' as const });
const button = (primary: boolean) => ({
  border: 'none',
  borderRadius: 3,
  padding: '4px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  background: primary ? '#0c66e4' : '#f1f2f4',
  color: primary ? '#ffffff' : '#172b4d',
});

export function SignalCard({ signal, busy, onDecide }: { signal: SignalView; busy: boolean; onDecide: (d: Decision) => void }) {
  const type = TYPE[signal.signalType] ?? { label: signal.signalType.replace(/_/g, ' '), bg: '#f1f2f4', fg: '#44546f' };
  const status = STATUS[signal.status];
  const rejected = signal.status === 'rejected';
  return (
    <article
      style={{
        border: `1px solid ${signal.status === 'confirmed' ? '#4bce97' : '#dcdfe4'}`,
        borderRadius: 6,
        padding: 10,
        margin: '8px 0',
        opacity: rejected ? 0.65 : 1,
        background: '#ffffff',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <span style={pill(type.bg, type.fg)}>{type.label}</span>
        <span style={{ fontWeight: 600 }}>{signal.daysBefore === 1 ? '1 day before' : `${signal.daysBefore} days before`}</span>
        <span style={{ color: '#626f86' }} title="How sure the AI is that this was an early signal">
          {Math.round(signal.confidence * 100)}% confidence
        </span>
        <span style={{ ...pill(status.bg, status.fg), marginLeft: 'auto' }}>{status.label}</span>
      </div>
      <blockquote style={{ margin: '8px 0', padding: '4px 0 4px 10px', borderLeft: `3px solid ${type.fg}`, fontSize: 13, lineHeight: 1.45, color: '#172b4d' }}>
        “{signal.quote}”
      </blockquote>
      <div style={{ fontSize: 12, color: '#44546f', marginBottom: 6 }}>{signal.reason}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span style={{ color: '#626f86', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {signal.artifactKey ? `${signal.artifactKey} · ` : ''}
          {signal.title || 'Untitled'}
        </span>
        {safeUrl(signal.url) && (
          <a href={safeUrl(signal.url)} target="_blank" rel="noreferrer">
            Open in {SOURCE[signal.source] ?? 'source'}
          </a>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        {signal.status === 'proposed' ? (
          <>
            <button type="button" style={button(true)} disabled={busy} onClick={() => onDecide('confirm')}>
              Confirm
            </button>
            <button type="button" style={button(false)} disabled={busy} onClick={() => onDecide('reject')}>
              Reject
            </button>
          </>
        ) : (
          <button type="button" style={button(false)} disabled={busy} onClick={() => onDecide('undo')}>
            Undo
          </button>
        )}
      </div>
    </article>
  );
}
