import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_DAYS, InputError, parseDemoKind, parseIncidentKey, parseServiceKey, parseServiceMapping, parseWindowDays } from '../src/core/validate';

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

describe('parseServiceMapping', () => {
  const valid = {
    serviceKey: 'checkout',
    displayName: ' Checkout ',
    jiraProjectKeys: ['pay', 'INC', 'PAY'],
    jiraComponentNames: 'Checkout, ',
    confluenceSpaceKeys: ['PLAT'],
    aliases: ['payment gateway'],
    ownerTeamName: 'Payments',
    ownerTeamId: '',
  };

  it('normalises lists, case and empty values', () => {
    expect(parseServiceMapping(valid)).toEqual({
      serviceKey: 'checkout',
      displayName: 'Checkout',
      jiraProjectKeys: ['PAY', 'INC'],
      jiraComponentNames: ['Checkout'],
      confluenceSpaceKeys: ['PLAT'],
      aliases: ['payment gateway'],
      ownerTeamName: 'Payments',
      ownerTeamId: null,
    });
  });

  it.each([
    ['not an object', 'x'],
    ['bad service key', { ...valid, serviceKey: 'a b' }],
    ['missing display name', { ...valid, displayName: '  ' }],
    ['bad project key', { ...valid, jiraProjectKeys: ['PAY"; DROP'] }],
    ['bad space key', { ...valid, confluenceSpaceKeys: ['PL AT'] }],
    ['too many items', { ...valid, aliases: Array.from({ length: 21 }, (_, i) => `a${i}`) }],
    ['alias too long', { ...valid, aliases: ['x'.repeat(65)] }],
    ['non-text list', { ...valid, aliases: [1] }],
    ['owner too long', { ...valid, ownerTeamName: 'x'.repeat(256) }],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseServiceMapping(raw)).toThrow(InputError);
  });
});

describe('parseDemoKind / parseServiceKey', () => {
  it('accepts the three kinds only', () => {
    expect(parseDemoKind('load')).toBe('load');
    expect(parseDemoKind('remove')).toBe('remove');
    expect(() => parseDemoKind('simulate')).toThrow(InputError);
  });
  it('validates service keys', () => {
    expect(parseServiceKey(' checkout ')).toBe('checkout');
    expect(() => parseServiceKey('../x y')).toThrow(InputError);
  });
});
