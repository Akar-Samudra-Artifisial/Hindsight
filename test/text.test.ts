import { describe, expect, it } from 'vitest';
import { adfToText, decodeEntities, excerptAround, hashText, normaliseText, storageToText } from '../src/core/text';

describe('adfToText', () => {
  it('flattens nested ADF with blocks, mentions and hard breaks', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'mention', attrs: { text: '@Rani' } }] },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'TLS 1.1' }, { type: 'hardBreak' }, { type: 'text', text: 'ends' }] }] }],
        },
        { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://vendor.example/eol' } }] },
      ],
    };
    expect(normaliseText(adfToText(doc))).toBe('Hello @Rani\nTLS 1.1\nends\n\nhttps://vendor.example/eol');
  });

  it('accepts plain strings and ignores junk', () => {
    expect(adfToText('plain')).toBe('plain');
    expect(adfToText(null)).toBe('');
    expect(adfToText({ type: 'doc', content: [42, null] })).toBe('');
  });
});

describe('storageToText', () => {
  it('strips tags, keeps CDATA and decodes entities', () => {
    const xhtml =
      '<p>Vendor &amp; partner: TLS&nbsp;1.1 &lt;deprecated&gt; &#8212; &#x2713;</p><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[curl <host>]]></ac:plain-text-body></ac:structured-macro><ul><li>one</li><li>two</li></ul>';
    expect(normaliseText(storageToText(xhtml))).toBe('Vendor & partner: TLS 1.1 <deprecated> — ✓\ncurl <host>\none\ntwo');
  });

  it('leaves unknown entities as they are', () => {
    expect(decodeEntities('&bogus; &#0;')).toBe('&bogus; &#0;');
  });
});

describe('normaliseText and hashText', () => {
  it('normalises Unicode, newlines and spaces', () => {
    expect(normaliseText('  Cafe\u0301\r\n\r\n\r\n  x\t y  ')).toBe('Café\n\nx y');
  });

  it('hashes the normalised text (stable SHA-256 hex)', () => {
    const a = hashText('Payment  fails\r\n');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashText('Payment fails')).toBe(a);
    expect(hashText('Payment failed')).not.toBe(a);
  });
});

describe('excerptAround', () => {
  it('returns short text untouched', () => {
    expect(excerptAround('short', 3, 2000)).toBe('short');
  });

  it('cuts at most max characters around the index', () => {
    const text = `${'a'.repeat(3000)}HIT${'b'.repeat(3000)}`;
    const ex = excerptAround(text, 3000, 2000);
    expect(ex.length).toBeLessThanOrEqual(2000);
    expect(ex).toContain('HIT');
    expect(ex.startsWith('…')).toBe(true);
    expect(ex.endsWith('…')).toBe(true);
  });
});
