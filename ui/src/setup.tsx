import { invoke } from '@forge/bridge';
import { useState } from 'react';
import { mount } from './mount';
import { Placeholder } from './placeholder';

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
    <TwgSpike />
  </>,
);
