import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_DAYS, InputError, parseIncidentKey, parseWindowDays } from '../src/core/validate';

describe('parseIncidentKey', () => {
  it('normalises case and whitespace', () => {
    expect(parseIncidentKey(' inc-12 ')).toBe('INC-12');
  });
  it.each([undefined, 12, '', 'INC', 'INC-0', '1NC-1', 'INC-1; DROP'])('rejects %s', (value) => {
    expect(() => parseIncidentKey(value)).toThrow(InputError);
  });
});

describe('parseWindowDays', () => {
  it('defaults when missing', () => {
    expect(parseWindowDays(undefined)).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindowDays('')).toBe(DEFAULT_WINDOW_DAYS);
  });
  it('accepts numeric strings', () => {
    expect(parseWindowDays('14')).toBe(14);
  });
  it.each(['0', '181', '7.5', 'ten', '-3'])('rejects %s', (value) => {
    expect(() => parseWindowDays(value)).toThrow(InputError);
  });
});
