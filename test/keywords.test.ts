import { describe, expect, it } from 'vitest';
import { extractKeywords, MAX_KEYWORDS, parseKeywords, stem, tokenise } from '../src/core/keywords';

describe('tokenise and stem', () => {
  it('keeps words of 3+ letters and numbers of 2+ digits', () => {
    expect(tokenise('TLS 1.1 on v2 at 402, ünïcode')).toEqual(['tls', '402', 'ünïcode']);
  });

  it('strips light suffixes', () => {
    expect(['payments', 'failing', 'failed', 'retries', 'status', 'class', 'checkout', '426'].map(stem)).toEqual([
      'payment',
      'fail',
      'fail',
      'retry',
      'status',
      'class',
      'checkout',
      '426',
    ]);
  });
});

describe('extractKeywords', () => {
  it('weights summary ×3, aliases ×2, description ×1', () => {
    const kws = extractKeywords({
      summary: 'Checkout payments failing',
      description: 'Customers see HTTP 402 when the payment is retried',
      aliases: ['payment gateway'],
    });
    const byStem = new Map(kws.map((k) => [k.stem, k.weight]));
    expect(byStem.get('payment')).toBe(6);
    expect(byStem.get('checkout')).toBe(3);
    expect(byStem.get('fail')).toBe(3);
    expect(byStem.get('gateway')).toBe(2);
    expect(byStem.get('402')).toBe(1);
    expect(byStem.has('the')).toBe(false);
    expect(kws[0]?.stem).toBe('payment');
  });

  it('is deterministic and capped', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`).join(' ');
    const a = extractKeywords({ summary: 'x', description: words });
    expect(a).toHaveLength(MAX_KEYWORDS);
    expect(extractKeywords({ summary: 'x', description: words })).toEqual(a);
  });

  it('parseKeywords drops malformed entries', () => {
    expect(parseKeywords([{ stem: 'a', weight: 1 }, { stem: 2 }, null])).toEqual([{ stem: 'a', weight: 1 }]);
    expect(parseKeywords('nope')).toEqual([]);
  });
});
