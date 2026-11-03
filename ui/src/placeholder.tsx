import { invoke } from '@forge/bridge';
import { useEffect, useState } from 'react';

interface Status {
  surface: string;
  ready: boolean;
  applied: number;
  total: number;
}

/** Scaffold view: proves the resolver round-trip works. Replaced by the real view later. */
export function Placeholder({ title, surface }: { title: string; surface: string }) {
  const [status, setStatus] = useState<string>('Loading…');
  useEffect(() => {
    invoke('getStatus', { surface })
      .then((reply) => {
        const s = reply as Status | { error: string };
        setStatus(
          'error' in s
            ? `Error: ${s.error}`
            : s.ready
              ? `Database ready (${s.applied}/${s.total} migrations)`
              : `Setting up database (${s.applied}/${s.total} migrations)`,
        );
      })
      .catch((e: unknown) => setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`));
  }, [surface]);
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>{title}</h1>
      <p>{status}</p>
    </main>
  );
}
