import { invoke } from '@forge/bridge';
import { useEffect, useState } from 'react';
import { mount } from './mount';
import { Placeholder } from './placeholder';

interface GraphConnectionReply {
  connected: boolean;
  name: string | null;
  updatedAt: string | null;
}

/** Teamwork Graph connector status (activated by an org admin in admin.atlassian.com → Connectors). */
function ConnectorStatus() {
  const [text, setText] = useState('Connector: checking…');
  useEffect(() => {
    invoke('getGraphConnection')
      .then((reply) => {
        const r = reply as GraphConnectionReply | { error: string };
        if ('error' in r) setText(`Connector: ${r.error}`);
        else if (!r.connected) setText('Connector: not connected');
        else setText(`Connector: connected${r.name ? ` (${r.name})` : ''}${r.updatedAt ? `, updated ${new Date(r.updatedAt).toLocaleString()}` : ''}`);
      })
      .catch((e: unknown) => setText(`Connector: error ${e instanceof Error ? e.message : String(e)}`));
  }, []);
  return <p style={{ fontFamily: 'system-ui, sans-serif', padding: '0 16px', margin: 0 }}>{text}</p>;
}

/** Temporary: Teamwork Graph read spike. Shows the raw resolver reply. */
function TwgSpike() {
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string>('');
  const run = () => {
    setRunning(true);
    invoke('twgSpike')
      .then((reply) => setOutput(JSON.stringify(reply, null, 2)))
      .catch((e: unknown) => setOutput(`Error: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setRunning(false));
  };
  return (
    <section style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <button type="button" onClick={run} disabled={running}>
        {running ? 'Running…' : 'Run Teamwork Graph spike'}
      </button>
      {output && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f4f5f7', padding: 12, marginTop: 12 }}>{output}</pre>}
    </section>
  );
}

mount(
  <>
    <Placeholder title="Hindsight setup" surface="setup" />
    <ConnectorStatus />
    <TwgSpike />
  </>,
);
