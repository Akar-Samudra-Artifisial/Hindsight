/**
 * Reach map: three deterministic columns (signal artifacts → teams that touched them → responder team). A stop node
 * has a red border; the missing link to the responder is dashed. The same facts are listed as text below the SVG.
 */
import type { ReactElement } from 'react';
import type { SignalView } from './SignalCard';
import { plural, stopCopy, type PathView, type ReachView } from './reach';

const COL_W = 168;
const NODE_H = 36;
const ROW_H = 52;
const X = [8, 216, 424] as const;
const MAX_TEAMS = 5;
const NO_TEAM = '__none__';

const C = {
  text: '#172b4d',
  muted: '#626f86',
  border: '#c1c7d0',
  fill: '#ffffff',
  stop: '#c9372c',
  reached: '#22a06b',
  responderFill: '#e9f2ff',
  edge: '#8590a2',
};

const clip = (text: string, max = 22) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function artifactLabel(sig: SignalView | undefined): string {
  if (!sig) return 'Signal';
  if (sig.artifactKey) return sig.artifactKey;
  return sig.source === 'confluence' ? `Page: ${sig.title}` : sig.title;
}

interface Node {
  id: string;
  label: string;
  sub?: string;
  stop?: boolean;
  reached?: boolean;
}

function Box({ node, x, y, responder }: { node: Node; x: number; y: number; responder?: boolean }) {
  const stroke = node.stop ? C.stop : node.reached ? C.reached : C.border;
  return (
    <g>
      <rect x={x} y={y} width={COL_W} height={NODE_H} rx={6} fill={responder ? C.responderFill : C.fill} stroke={stroke} strokeWidth={node.stop || node.reached ? 2 : 1} />
      <text x={x + 10} y={y + (node.sub ? 15 : 22)} fontSize={12} fontWeight={600} fill={C.text}>
        {clip(node.label)}
      </text>
      {node.sub && (
        <text x={x + 10} y={y + 29} fontSize={10} fill={C.muted}>
          {clip(node.sub, 28)}
        </text>
      )}
    </g>
  );
}

export function ReachMap({ reach, signals }: { reach: ReachView; signals: SignalView[] }) {
  const bySignal = new Map(signals.map((sg) => [sg.id, sg]));
  const responder = reach.responderTeamName ?? 'Responder team';
  const paths = reach.paths.filter((p) => bySignal.get(p.signalId)?.status === 'confirmed');
  if (paths.length === 0) return null;

  // Middle column: teams by how many signals they touched, then first appearance; "No team" last.
  const counts = new Map<string, { label: string; n: number; order: number }>();
  let order = 0;
  for (const p of paths) {
    for (const st of p.steps) {
      if (p.reached && reach.responderTeamId !== null && st.teamId === reach.responderTeamId) continue;
      const id = st.teamId ?? NO_TEAM;
      const prev = counts.get(id);
      counts.set(id, { label: st.teamName ?? 'People in no team', n: (prev?.n ?? 0) + 1, order: prev?.order ?? order++ });
    }
  }
  const stopIds = new Set(paths.filter((p) => p.reached === false && p.stopPoint?.teamId).map((p) => p.stopPoint!.teamId!));
  const teams = [...counts.entries()]
    .filter(([id]) => id !== NO_TEAM)
    .sort((a, b) => Number(stopIds.has(b[0])) - Number(stopIds.has(a[0])) || b[1].n - a[1].n || a[1].order - b[1].order)
    .slice(0, MAX_TEAMS)
    .map(([id, v]): Node => ({ id, label: v.label, sub: plural(v.n, 'signal', 'signals'), stop: stopIds.has(id) }));
  if (counts.has(NO_TEAM)) teams.push({ id: NO_TEAM, label: 'People in no team', sub: plural(counts.get(NO_TEAM)!.n, 'signal', 'signals') });

  const artifacts: Node[] = paths.map((p) => {
    const sg = bySignal.get(p.signalId);
    return { id: p.signalId, label: artifactLabel(sg), sub: sg ? `${plural(sg.daysBefore, 'day', 'days')} before` : undefined };
  });
  const anyReached = paths.some((p) => p.reached === true);
  const rows = Math.max(artifacts.length, teams.length, 1);
  const height = rows * ROW_H + 28;
  const yOf = (i: number, n: number) => 24 + ((rows - n) * ROW_H) / 2 + i * ROW_H;
  const teamIndex = new Map(teams.map((t, i) => [t.id, i]));
  const respY = yOf(0, 1);

  const edges: ReactElement[] = [];
  paths.forEach((p: PathView, ai) => {
    const ay = yOf(ai, artifacts.length) + NODE_H / 2;
    if (p.reached) {
      edges.push(<line key={`r-${p.signalId}`} x1={X[0] + COL_W} y1={ay} x2={X[2]} y2={respY + NODE_H / 2} stroke={C.reached} strokeWidth={2} />);
    }
    const seen = new Set<number>();
    for (const st of p.steps) {
      const ti = teamIndex.get(st.teamId ?? NO_TEAM);
      if (ti === undefined || seen.has(ti)) continue;
      seen.add(ti);
      edges.push(<line key={`a-${p.signalId}-${ti}`} x1={X[0] + COL_W} y1={ay} x2={X[1]} y2={yOf(ti, teams.length) + NODE_H / 2} stroke={C.edge} strokeWidth={1} />);
    }
  });
  teams.forEach((t, ti) => {
    if (!t.stop) return;
    edges.push(
      <line key={`m-${t.id}`} x1={X[1] + COL_W} y1={yOf(ti, teams.length) + NODE_H / 2} x2={X[2]} y2={respY + NODE_H / 2} stroke={C.stop} strokeWidth={1.5} strokeDasharray="5 4" />,
    );
  });

  return (
    <figure style={{ margin: '8px 0' }}>
      <svg viewBox={`0 0 600 ${height}`} width="100%" role="img" aria-label={`Reach map: ${plural(paths.length, 'confirmed signal', 'confirmed signals')}, teams that touched them, and ${responder}. The list below describes it.`}>
        <text x={X[0]} y={14} fontSize={11} fill={C.muted}>
          Signals
        </text>
        <text x={X[1]} y={14} fontSize={11} fill={C.muted}>
          Teams that touched them
        </text>
        <text x={X[2]} y={14} fontSize={11} fill={C.muted}>
          Responder team
        </text>
        {edges}
        {artifacts.map((n, i) => (
          <Box key={n.id} node={n} x={X[0]} y={yOf(i, artifacts.length)} />
        ))}
        {teams.map((n, i) => (
          <Box key={n.id} node={n} x={X[1]} y={yOf(i, teams.length)} />
        ))}
        <Box node={{ id: 'responder', label: responder, sub: anyReached ? 'reached' : 'not reached before the incident', reached: anyReached }} x={X[2]} y={respY} responder />
      </svg>
      <figcaption>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.text }}>
          {paths.map((p) => {
            const sg = bySignal.get(p.signalId);
            const touched = p.steps.map((st) => st.teamName ?? 'people in no team');
            const head = `${artifactLabel(sg)}${sg ? ` · ${plural(sg.daysBefore, 'day', 'days')} before` : ''}`;
            const body =
              p.graphState === 'pending'
                ? 'not traced yet'
                : p.graphState === 'unknown'
                  ? 'graph context not available'
                  : p.reached
                    ? `reached ${responder}${p.timeUnknown ? ' (time unknown)' : ''}`
                    : `${touched.length ? `touched by ${touched.join(', ')}` : 'no person in a team touched it'} · ${p.stopPoint ? stopCopy(p.stopPoint, responder) : ''}`;
            return (
              <li key={p.signalId}>
                <strong>{head}</strong>: {body}
              </li>
            );
          })}
        </ul>
      </figcaption>
    </figure>
  );
}
