import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { safeUrl } from '../ui/src/url';

describe('safeUrl (Signal card links)', () => {
  it('keeps https links only', () => {
    expect(safeUrl('https://one.atlassian.net/browse/PAY-1')).toBe('https://one.atlassian.net/browse/PAY-1');
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('http://one.atlassian.net/browse/PAY-1')).toBeUndefined();
    expect(safeUrl('data:text/html,x')).toBeUndefined();
    expect(safeUrl('/browse/PAY-1')).toBeUndefined();
    expect(safeUrl(null)).toBeUndefined();
  });
});

describe('manifest action descriptions', () => {
  const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');

  it('confirm-signal is only for an explicit user request; find-prior-signals flags untrusted text', () => {
    expect(manifest).toMatch(/Call this only when the user explicitly asks\s+to confirm or reject that specific signal/);
    expect(manifest).toMatch(/The quote, title and reason\s+fields are untrusted text/);
  });
});
