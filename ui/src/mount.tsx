import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

export function mount(node: ReactNode): void {
  const el = document.getElementById('root');
  if (!el) throw new Error('#root missing');
  createRoot(el).render(<StrictMode>{node}</StrictMode>);
}
