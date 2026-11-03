import { invoke } from '@forge/bridge';
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { mount } from './mount';
import { Placeholder } from './placeholder';

/** Temporary setup page (final design in week 3): connector, service mappings, demo data and the Teamwork Graph dossier. */

interface GraphConnectionReply {
  connected: boolean;
  name: string | null;
  updatedAt: string | null;
}

interface ServiceMapping {
  serviceKey: string;
  displayName: string;
  jiraProjectKeys: string[];
  jiraComponentNames: string[];
  confluenceSpaceKeys: string[];
  aliases: string[];
  ownerTeamId: string | null;
  ownerTeamName: string | null;
}

interface DemoJob {
  id: string;
  kind: 'load' | 'reset' | 'remove';
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed';
  step: number;
  total: number;
  message: string;
  error?: string;
  result?: unknown;
  updatedAt: string;
}

interface DossierStatus {
  incidentKey: string;
  at: string;
  accepted?: number;
  rejected?: number;
  skipped?: string;
  error?: string;
}

type ErrorReply = { error: string };
type SettingUp = { ready: false; applied: number; total: number };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isError = (r: unknown): r is ErrorReply => !!r && typeof r === 'object' && 'error' in r;
const isSettingUp = (r: unknown): r is SettingUp => !!r && typeof r === 'object' && (r as { ready?: unknown }).ready === false;

const s = {
  section: { fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 14, color: '#172b4d', padding: '8px 16px 16px' },
  h2: { fontSize: 16, margin: '16px 0 8px' },
  muted: { color: '#626f86', fontSize: 12 },
  error: { color: '#ae2e24', fontSize: 13 },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 13 },
  cell: { borderTop: '1px solid #dcdfe4', padding: '6px 8px', textAlign: 'left', verticalAlign: 'top' },
  form: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 12px', alignItems: 'center', maxWidth: 640, marginTop: 12 },
  input: { padding: '4px 6px', fontSize: 13 },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
} satisfies Record<string, CSSProperties>;

/** Teamwork Graph connector status (activated by an org admin in admin.atlassian.com → Connectors). */
function ConnectorStatus() {
  const [text, setText] = useState('Connector: checking…');
  useEffect(() => {
    invoke('getGraphConnection')
      .then((reply) => {
        const r = reply as GraphConnectionReply | ErrorReply;
        if ('error' in r) setText(`Connector: ${r.error}`);
        else if (!r.connected) setText('Connector: not connected');
        else setText(`Connector: connected${r.name ? ` (${r.name})` : ''}${r.updatedAt ? `, updated ${new Date(r.updatedAt).toLocaleString()}` : ''}`);
      })
      .catch((e: unknown) => setText(`Connector: error ${errorText(e)}`));
  }, []);
  return <p style={{ ...s.section, paddingTop: 0, margin: 0 }}>{text}</p>;
}

const EMPTY_FORM = { serviceKey: '', displayName: '', jiraProjectKeys: '', jiraComponentNames: '', confluenceSpaceKeys: '', aliases: '', ownerTeamName: '', ownerTeamId: '' };
type MappingForm = typeof EMPTY_FORM;
const FIELDS: readonly [keyof MappingForm, string, string][] = [
  ['serviceKey', 'Service key', 'checkout'],
  ['displayName', 'Display name', 'Checkout (Arkana Commerce)'],
  ['jiraProjectKeys', 'Jira project keys', 'PAY, INC'],
  ['jiraComponentNames', 'Jira components', 'Checkout'],
  ['confluenceSpaceKeys', 'Confluence space keys', 'PLAT'],
  ['aliases', 'Aliases', 'payment gateway, card payments'],
  ['ownerTeamName', 'Owner team name', 'Payments'],
  ['ownerTeamId', 'Owner team id (optional, Atlassian team id for reach)', ''],
];
const list = (text: string) => text.split(',').map((v) => v.trim()).filter((v) => v !== '');
const toForm = (m: ServiceMapping): MappingForm => ({
  serviceKey: m.serviceKey,
  displayName: m.displayName,
  jiraProjectKeys: m.jiraProjectKeys.join(', '),
  jiraComponentNames: m.jiraComponentNames.join(', '),
  confluenceSpaceKeys: m.confluenceSpaceKeys.join(', '),
  aliases: m.aliases.join(', '),
  ownerTeamName: m.ownerTeamName ?? '',
  ownerTeamId: m.ownerTeamId ?? '',
});

/** Which Jira projects, components and Confluence spaces belong to each service; drives the analysis scope. */
function ServiceMappings({ refreshKey }: { refreshKey: number }) {
  const [mappings, setMappings] = useState<ServiceMapping[] | null>(null);
  const [form, setForm] = useState<MappingForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((reply: unknown) => {
    if (isError(reply)) setError(reply.error);
    else if (isSettingUp(reply)) setError(`Database is setting up (${reply.applied}/${reply.total}). Try again in a minute.`);
    else {
      setMappings((reply as { mappings: ServiceMapping[] }).mappings);
      setError(null);
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    invoke('listServiceMappings').then(apply).catch((e: unknown) => setError(errorText(e)));
  }, [apply, refreshKey]);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const mapping = {
      serviceKey: form.serviceKey,
      displayName: form.displayName,
      jiraProjectKeys: list(form.jiraProjectKeys),
      jiraComponentNames: list(form.jiraComponentNames),
      confluenceSpaceKeys: list(form.confluenceSpaceKeys),
      aliases: list(form.aliases),
      ownerTeamName: form.ownerTeamName,
      ownerTeamId: form.ownerTeamId,
    };
    invoke('saveServiceMapping', { mapping })
      .then((r) => {
        if (apply(r)) setForm(EMPTY_FORM);
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const remove = (serviceKey: string) => {
    setBusy(true);
    invoke('deleteServiceMapping', { serviceKey })
      .then(apply)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section style={s.section}>
      <h2 style={s.h2}>Service mappings</h2>
      <p style={s.muted}>Hindsight searches the projects and spaces of the incident's service. Separate multiple values with commas.</p>
      {error && <p style={s.error}>{error}</p>}
      {mappings === null && !error && <p style={s.muted}>Loading…</p>}
      {mappings && mappings.length === 0 && <p style={s.muted}>No service mappings yet.</p>}
      {mappings && mappings.length > 0 && (
        <table style={s.table}>
          <thead>
            <tr>
              {['Service', 'Jira projects', 'Components', 'Spaces', 'Aliases', 'Owner team', ''].map((h) => (
                <th key={h} style={s.cell}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.serviceKey}>
                <td style={s.cell}>
                  <strong>{m.displayName}</strong>
                  <div style={s.muted}>{m.serviceKey}</div>
                </td>
                <td style={s.cell}>{m.jiraProjectKeys.join(', ')}</td>
                <td style={s.cell}>{m.jiraComponentNames.join(', ')}</td>
                <td style={s.cell}>{m.confluenceSpaceKeys.join(', ')}</td>
                <td style={s.cell}>{m.aliases.join(', ')}</td>
                <td style={s.cell}>{m.ownerTeamName ?? ''}</td>
                <td style={s.cell}>
                  <div style={s.row}>
                    <button type="button" onClick={() => setForm(toForm(m))} disabled={busy}>
                      Edit
                    </button>
                    <button type="button" onClick={() => remove(m.serviceKey)} disabled={busy}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={save} style={s.form}>
        {FIELDS.map(([key, label, placeholder]) => (
          <label key={key} style={{ display: 'contents' }}>
            <span>{label}</span>
            <input style={s.input} value={form[key]} placeholder={placeholder} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
          </label>
        ))}
        <span />
        <div style={s.row}>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save mapping'}
          </button>
          <button type="button" onClick={() => setForm(EMPTY_FORM)} disabled={busy}>
            Clear
          </button>
        </div>
      </form>
    </section>
  );
}

const ACTIVE = new Set(['queued', 'running']);
const KIND_LABEL: Record<DemoJob['kind'], string> = { load: 'Load demo data', reset: 'Reset to showcase', remove: 'Remove demo data' };

/** Reuse warnings recorded in the finished job's result (shown together with the ones read from the database). */
function resultWarnings(job: DemoJob | null): string[] {
  const raw = job?.result && typeof job.result === 'object' ? (job.result as { warnings?: unknown }).warnings : undefined;
  return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === 'string') : [];
}

/** Demo data: Load (creates the Arkana Commerce scenario), Reset (forget analyses), Remove (delete what the app created). */
function DemoData({ onDone }: { onDone: () => void }) {
  const [job, setJob] = useState<DemoJob | null>(null);
  const [incidentKey, setIncidentKey] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(() => {
    invoke('getDemoJob')
      .then((r) => {
        if (isError(r)) setError(r.error);
        else if (!isSettingUp(r)) {
          const reply = r as { job: DemoJob | null; incidentKey: string | null; warnings?: string[]; notes?: string[] };
          setJob(reply.job);
          setIncidentKey(reply.incidentKey);
          setWarnings(reply.warnings ?? []);
          setNotes(reply.notes ?? []);
        }
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(poll, [poll]);
  const active = job !== null && ACTIVE.has(job.status);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [active, poll]);
  const status = job?.status;
  useEffect(() => {
    if (status === 'done' || status === 'partial') onDone();
  }, [status, onDone]);

  const start = (kind: DemoJob['kind']) => {
    setError(null);
    invoke('startDemoJob', { kind })
      .then((r) => {
        if (isError(r)) setError(r.error);
        else if (!isSettingUp(r)) setJob((r as { job: DemoJob }).job);
      })
      .catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <section style={s.section}>
      <h2 style={s.h2}>Demo data</h2>
      <p style={s.muted}>
        Creates the Arkana Commerce scenario: Jira project PAY, service project INC, Confluence space PLAT, about 50 work items, tickets, pages and
        comments, and the incident. Their dates are simulated history: Hindsight stores a scenario time for each, and the incident panel shows a
        "Simulated history" badge.
      </p>
      <div style={s.row}>
        {(['load', 'reset', 'remove'] as const).map((kind) => (
          <button key={kind} type="button" onClick={() => start(kind)} disabled={active}>
            {KIND_LABEL[kind]}
          </button>
        ))}
      </div>
      {error && <p style={s.error}>{error}</p>}
      {job && (
        <p>
          <strong>{KIND_LABEL[job.kind]}:</strong> {job.status}
          {job.total > 0 ? ` · step ${job.step}/${job.total}` : ''} · {job.message}
          {job.error && <span style={{ ...s.error, display: 'block' }}>{job.error}</span>}
        </p>
      )}
      {job && job.kind !== 'remove' && (job.status === 'done' || job.status === 'partial') && (
        <p style={{ background: '#e9f2ff', padding: '6px 8px', borderRadius: 4, fontSize: 12 }}>
          Before recording: Load demo data, open the incident, Analyze once, confirm the 4 signals, Trace reach. Do not Reset or Analyze again while recording.
        </p>
      )}
      {[...new Set([...warnings, ...resultWarnings(job)])].map((w) => (
        <p key={w} style={{ background: '#fff7d6', padding: '6px 8px', borderRadius: 4, fontSize: 12 }}>
          {w}
        </p>
      ))}
      {notes.map((n) => (
        <p key={n} style={s.muted}>
          {n}
        </p>
      ))}
      {incidentKey && <p style={s.muted}>Demo incident: {incidentKey}. Open it and click Analyze.</p>}
    </section>
  );
}

/** Teamwork Graph dossier: written by the score consumer through the stored connection (never by this page). */
function DossierPanel() {
  const [last, setLast] = useState<DossierStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke('getDossierStatus')
      .then((r) => {
        if (isError(r)) setMessage(r.error);
        else if (!isSettingUp(r)) setLast((r as { last: DossierStatus | null }).last);
      })
      .catch((e: unknown) => setMessage(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const write = () => {
    setMessage(null);
    invoke('writeTestDossier')
      .then((r) => {
        if (isError(r)) setMessage(r.error);
        else {
          setMessage('Queued. The result appears below in a few seconds.');
          [4000, 10000, 20000].forEach((ms) => setTimeout(load, ms));
        }
      })
      .catch((e: unknown) => setMessage(errorText(e)));
  };

  const summary = !last
    ? 'No dossier written yet.'
    : last.skipped
      ? `Last dossier: ${last.incidentKey}, skipped (${last.skipped})`
      : last.error
        ? `Last dossier: ${last.incidentKey}, failed: ${last.error}`
        : `Last dossier: ${last.incidentKey}, accepted ${last.accepted ?? 0}, rejected ${last.rejected ?? 0}`;

  return (
    <section style={s.section}>
      <h2 style={s.h2}>Teamwork Graph</h2>
      <p style={s.muted}>After each analysis Hindsight writes an "Early signals for …" document (counts only) through the connector.</p>
      <div style={s.row}>
        <button type="button" onClick={write}>
          Write test dossier
        </button>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </div>
      {message && <p style={s.muted}>{message}</p>}
      <p>
        {summary}
        {last ? <span style={s.muted}> · {new Date(last.at).toLocaleString()}</span> : null}
      </p>
    </section>
  );
}

/** Temporary: Teamwork Graph read spike. Shows the raw resolver reply. */
function TwgSpike() {
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string>('');
  const run = () => {
    setRunning(true);
    invoke('twgSpike')
      .then((reply) => setOutput(JSON.stringify(reply, null, 2)))
      .catch((e: unknown) => setOutput(`Error: ${errorText(e)}`))
      .finally(() => setRunning(false));
  };
  return (
    <section style={s.section}>
      <button type="button" onClick={run} disabled={running}>
        {running ? 'Running…' : 'Run Teamwork Graph spike'}
      </button>
      {output && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f4f5f7', padding: 12, marginTop: 12 }}>{output}</pre>}
    </section>
  );
}

interface StampReply {
  pages?: number;
  pagesAlready?: number;
  watchers?: number;
  failed?: string[];
  error?: string;
}

/** Adds the admin's human touch to the demo (review note on the S1 page, watcher on three issues) so reach can be traced. */
function StampDemo() {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = () => {
    setRunning(true);
    invoke('stampDemo')
      .then((r) => {
        const res = r as StampReply;
        if (res.error) setMessage(res.error);
        else {
          const page = res.pages ? 'review note added to the demo page' : res.pagesAlready ? 'demo page already reviewed' : 'demo page not changed';
          const failed = res.failed?.length ? ` Problems: ${res.failed.join('; ')}` : '';
          setMessage(`Done: ${page}; watching ${res.watchers ?? 0} of 3 demo issues.${failed}`);
        }
      })
      .catch((e: unknown) => setMessage(`Error: ${errorText(e)}`))
      .finally(() => setRunning(false));
  };
  return (
    <section style={s.section}>
      <h2 style={s.h2}>Demo reach</h2>
      <p style={s.muted}>
        Reach needs people, not the app: after Load demo data, Stamp demo data adds "Reviewed by you" to the vendor page and makes you a watcher of the payment client story and the two
        checkout tickets. Then set the owner team id of the checkout mapping to the responder team (the id in the team URL, <code>/people/team/&lt;id&gt;</code>).
      </p>
      <button type="button" onClick={run} disabled={running}>
        {running ? 'Stamping…' : 'Stamp demo data'}
      </button>
      {message && <p style={s.muted}>{message}</p>}
    </section>
  );
}

interface SentinelSettingsReply {
  weeklyCap?: number;
  max?: number;
  error?: string;
}

interface NoticeReply {
  n?: number;
  incidentKey?: string;
  pageUrl?: string | null;
  error?: string;
}

/**
 * Sentinel: the weekly alert cap per team, and the demo trigger "Post a new provider notice" (a comment by you on
 * the demo PLAT page with the keywords of the active PLAT route, so Sentinel alerts the owner team for real).
 */
function SentinelSetup() {
  const [cap, setCap] = useState('');
  const [max, setMax] = useState(1000);
  const [saving, setSaving] = useState(false);
  const [capMessage, setCapMessage] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; url?: string } | null>(null);

  useEffect(() => {
    invoke('getSentinelSettings')
      .then((r) => {
        const res = r as SentinelSettingsReply;
        if (res.error) setCapMessage(res.error);
        else {
          setCap(String(res.weeklyCap ?? ''));
          if (res.max) setMax(res.max);
        }
      })
      .catch((e: unknown) => setCapMessage(`Error: ${errorText(e)}`));
  }, []);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    invoke('saveSentinelSettings', { weeklyCap: cap.trim() })
      .then((r) => {
        const res = r as SentinelSettingsReply;
        if (res.error) setCapMessage(res.error);
        else {
          setCap(String(res.weeklyCap ?? cap));
          setCapMessage('Saved.');
        }
      })
      .catch((err: unknown) => setCapMessage(`Error: ${errorText(err)}`))
      .finally(() => setSaving(false));
  };

  const post = () => {
    setPosting(true);
    invoke('postProviderNotice')
      .then((r) => {
        const res = r as NoticeReply;
        if (res.error) setNotice({ text: res.error });
        else
          setNotice({
            text: `Provider notice #${res.n ?? '?'} posted on the demo page. Within a minute Sentinel comments there for the owner team; the alert shows on the Routes tab of ${res.incidentKey ?? 'the incident'}.`,
            ...(res.pageUrl ? { url: res.pageUrl } : {}),
          });
      })
      .catch((e: unknown) => setNotice({ text: `Error: ${errorText(e)}` }))
      .finally(() => setPosting(false));
  };

  return (
    <section style={s.section}>
      <h2 style={s.h2}>Sentinel</h2>
      <p style={s.muted}>
        Approved routes are watched: a new comment or page in the route's source that matches its keywords gets one blameless alert comment for the owner team. Sentinel never runs on
        content written by apps, alerts each item at most once, and keeps a daily cap across all teams (default 200).
      </p>
      <form onSubmit={save}>
        <div style={s.row}>
          <label htmlFor="sentinel-cap" style={{ fontSize: 13 }}>
            Weekly alert cap per team
          </label>
          <input id="sentinel-cap" type="number" min={1} max={max} value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 90 }} />
          <button type="submit" disabled={saving || cap.trim() === ''}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
      {capMessage && <p style={s.muted}>{capMessage}</p>}
      <p style={s.muted}>Demo: approve the Confluence space PLAT route on the demo incident first, then post a vendor notice as yourself.</p>
      <button type="button" onClick={post} disabled={posting}>
        {posting ? 'Posting…' : 'Post a new provider notice'}
      </button>
      {notice && (
        <p style={s.muted}>
          {notice.text}{' '}
          {notice.url && /^https:\/\//.test(notice.url) && (
            <a href={notice.url} target="_blank" rel="noreferrer">
              Open the page
            </a>
          )}
        </p>
      )}
    </section>
  );
}

/** Temporary: can this session read team membership of other accounts? Shows the raw resolver reply. */
function TeamSpike() {
  const [accountIds, setAccountIds] = useState('');
  const [pageId, setPageId] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string>('');
  const run = (e: FormEvent) => {
    e.preventDefault();
    setRunning(true);
    const ids = accountIds
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
    invoke('teamSpike', { accountIds: ids, pageId: pageId.trim() })
      .then((reply) => setOutput(JSON.stringify(reply, null, 2)))
      .catch((err: unknown) => setOutput(`Error: ${errorText(err)}`))
      .finally(() => setRunning(false));
  };
  return (
    <section style={s.section}>
      <form onSubmit={run}>
        <div style={s.row}>
          <input aria-label="Account ids (comma separated)" placeholder="Account ids, comma separated" value={accountIds} onChange={(e) => setAccountIds(e.target.value)} />
          <input aria-label="Confluence page id (optional)" placeholder="Page id (optional)" value={pageId} onChange={(e) => setPageId(e.target.value)} />
          <button type="submit" disabled={running}>
            {running ? 'Running…' : 'Run team membership spike'}
          </button>
        </div>
      </form>
      {output && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f4f5f7', padding: 12, marginTop: 12 }}>{output}</pre>}
    </section>
  );
}

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const onDemoDone = useCallback(() => setRefreshKey((k) => k + 1), []);
  return (
    <>
      <Placeholder title="Hindsight setup" surface="setup" />
      <ConnectorStatus />
      <ServiceMappings refreshKey={refreshKey} />
      <DemoData onDone={onDemoDone} />
      <StampDemo />
      <SentinelSetup />
      <DossierPanel />
      <TwgSpike />
      <TeamSpike />
    </>
  );
}

mount(<App />);
