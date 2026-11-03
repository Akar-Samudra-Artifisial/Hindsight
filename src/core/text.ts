import { createHash } from 'node:crypto';

/** Artifact text helpers (pure). Collected text is only hashed and excerpted, never stored in `events`. */

const ADF_BLOCKS = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'tableRow',
  'tableCell',
  'tableHeader',
  'panel',
  'rule',
  'mediaSingle',
  'decisionItem',
  'taskItem',
  'expand',
]);

/** Atlassian Document Format → plain text: text nodes, mentions, emoji and links; blocks end with a newline. */
export function adfToText(node: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!n || typeof n !== 'object') return;
    const obj = n as { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; content?: unknown };
    if (obj.type === 'text' && typeof obj.text === 'string') parts.push(obj.text);
    else if (obj.type === 'hardBreak') parts.push('\n');
    else if (obj.type === 'mention' || obj.type === 'emoji' || obj.type === 'status') {
      const t = obj.attrs?.['text'] ?? obj.attrs?.['shortName'];
      if (typeof t === 'string') parts.push(t);
    } else if (obj.type === 'inlineCard' || obj.type === 'blockCard') {
      const url = obj.attrs?.['url'];
      if (typeof url === 'string') parts.push(url);
    }
    walk(obj.content);
    if (typeof obj.type === 'string' && ADF_BLOCKS.has(obj.type)) parts.push('\n');
  };
  if (typeof node === 'string') return node;
  walk(node);
  return parts.join('');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

/** Confluence storage format (XHTML + `ac:` macros) → plain text. CDATA content (code macros) is kept. */
export function storageToText(xhtml: string): string {
  return decodeEntities(
    xhtml
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|td|th|blockquote|pre|ac:task|ac:structured-macro)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/** NFC, unified newlines, collapsed spaces per line, at most one blank line, trimmed. */
export function normaliseText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v\u00a0\u2000-\u200b\u202f\u205f\u3000 ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** SHA-256 (hex) of the normalised text: the cache key for scoring; the text itself is not stored. */
export function hashText(text: string): string {
  return createHash('sha256').update(normaliseText(text), 'utf8').digest('hex');
}

/** At most `max` characters of `text` around `index`, with an ellipsis where it was cut. */
export function excerptAround(text: string, index: number, max = 2000): string {
  if (text.length <= max) return text;
  const at = Math.min(Math.max(0, Math.trunc(index)), text.length);
  const start = Math.max(0, Math.min(at - Math.floor(max / 4), text.length - max));
  const end = Math.min(text.length, start + max);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return `${head}${text.slice(start + head.length, end - tail.length)}${tail}`;
}
