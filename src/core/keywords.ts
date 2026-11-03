/** Weighted incident keywords (pure). The LLM adds synonyms in week 3; this is the deterministic base. */

export interface Keyword {
  stem: string;
  weight: number;
}

export const MAX_KEYWORDS = 25;
const WEIGHT_SUMMARY = 3;
const WEIGHT_ALIAS = 2;
const WEIGHT_DESCRIPTION = 1;

const STOPWORDS = new Set(
  (
    'the and for are but not you all any can had her was one our out has have him his how its may new now old see two way who ' +
    'did get got let put say she too use with that this from they will would there their what when where which while about ' +
    'after before again also been being both could does doing down each few more most much must only other over same should ' +
    'some such than then them these those through under until very were your yours into just like because between during ' +
    'here why off own nor once per via yet able please thanks thank hi hello team issue ticket page comment today ' +
    'yesterday tomorrow still even need needs know think cannot cant dont didnt doesnt isnt wont really maybe'
  ).split(' '),
);

/** Lower-cased word tokens (letters/digits, Unicode aware); keeps tokens of ≥3 letters or numbers of ≥2 digits. */
export function tokenise(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    if (/^[0-9]+$/.test(t) ? t.length >= 2 : t.length >= 3) out.push(t);
  }
  return out;
}

/** Light suffix stripping: `payments → payment`, `failing → fail`, `failed → fail`, `retries → retry`. */
export function stem(token: string): string {
  if (/^[0-9]+$/.test(token)) return token;
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ied')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Stems of the non-stopword tokens of `text`, in order (with repeats). */
export function stems(text: string): string[] {
  return tokenise(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

export interface KeywordSource {
  summary: string;
  description?: string;
  aliases?: readonly string[];
}

/** Up to `max` keywords, heaviest first (ties by stem), from summary ×3, aliases ×2 and description ×1. */
export function extractKeywords(src: KeywordSource, max = MAX_KEYWORDS): Keyword[] {
  const weights = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const s of new Set(stems(text))) weights.set(s, (weights.get(s) ?? 0) + weight);
  };
  add(src.summary, WEIGHT_SUMMARY);
  for (const alias of src.aliases ?? []) add(alias, WEIGHT_ALIAS);
  if (src.description) add(src.description, WEIGHT_DESCRIPTION);
  return [...weights.entries()]
    .map(([s, weight]) => ({ stem: s, weight }))
    .sort((a, b) => b.weight - a.weight || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0))
    .slice(0, max);
}

/** Validates keywords read back from JSON (scope or `incidents.keywords`). */
export function parseKeywords(raw: unknown): Keyword[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (k): k is Keyword =>
      !!k && typeof k === 'object' && typeof (k as Keyword).stem === 'string' && typeof (k as Keyword).weight === 'number',
  );
}
