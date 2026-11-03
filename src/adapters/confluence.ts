import api, { route, type APIResponse } from '@forge/api';

/** Confluence replied with a non-2xx status. The message carries the HTTP status and Confluence's error text only. */
export class ConfluenceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ConfluenceError';
  }
}

export function isConfluenceRateLimited(err: unknown): boolean {
  return err instanceof ConfluenceError && err.status === 429;
}

export interface RawContent {
  id: string;
  type?: string;
  title?: string;
  space?: { key?: string };
  history?: { createdDate?: string; createdBy?: { accountId?: string } };
  version?: { when?: string; number?: number };
  body?: { storage?: { value?: string } };
  container?: { id?: string | number; title?: string; type?: string };
  _links?: { webui?: string };
}

export interface SearchPage {
  results: RawContent[];
  /** Absolute site base, e.g. `https://site.atlassian.net/wiki`. */
  base: string | null;
  /** Cursor for the next page; undefined on the last page. */
  nextCursor?: string;
}

/** [VERIFY] Expansions of the v1 search result for comments (`content.container`, `content.body.storage`) are untested. */
const SEARCH_EXPAND = 'content.body.storage,content.version,content.history,content.space,content.container';

async function failure(res: APIResponse, what: string): Promise<ConfluenceError> {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 200);
  try {
    const body = JSON.parse(text) as { message?: string };
    if (body.message) detail = body.message.slice(0, 300);
  } catch {
    // not JSON
  }
  return new ConfluenceError(res.status, `Confluence ${what} ${res.status}: ${detail || 'no body'}`);
}

/** `cursor` query parameter of a `_links.next` value such as `/rest/api/search?cql=...&cursor=abc`. */
export function cursorFromNext(next: string | undefined): string | undefined {
  if (!next) return undefined;
  try {
    return new URL(next, 'https://placeholder.invalid').searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}

/** Numeric content ids only: they are inlined into CQL `id in (...)`. */
const numericIds = (ids: readonly string[]): string[] => [...new Set(ids.filter((id) => /^[0-9]{1,18}$/.test(id)))];

async function search(as: 'app' | 'user', params: URLSearchParams): Promise<SearchPage> {
  const client = as === 'user' ? api.asUser() : api.asApp();
  const res = await client.requestConfluence(route`/wiki/rest/api/search?${params}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw await failure(res, 'search');
  const body = (await res.json()) as { results?: { content?: RawContent }[]; _links?: { next?: string; base?: string } };
  const results = (body.results ?? []).flatMap((r) => (r.content && r.content.id ? [{ ...r.content, id: String(r.content.id) }] : []));
  const nextCursor = cursorFromNext(body._links?.next);
  return { results, base: body._links?.base ?? null, ...(nextCursor ? { nextCursor } : {}) };
}

export const confluence = {
  /** One page (50) of a CQL search as the app, with storage body, version, history, space and container. */
  searchContent(cql: string, cursor: string | undefined): Promise<SearchPage> {
    const params = new URLSearchParams({ cql, limit: '50', expand: SEARCH_EXPAND });
    if (cursor) params.set('cursor', cursor);
    return search('app', params);
  },

  /**
   * Page ids the current user can view. One CQL `id in (...)` search per 50 ids [VERIFY]; when the search itself is
   * refused (400/403) it falls back to `GET /wiki/api/v2/pages/{id}` per page. Resolvers and actions only.
   */
  async visiblePageIds(ids: readonly string[]): Promise<Set<string>> {
    const visible = new Set<string>();
    const all = numericIds(ids);
    for (let i = 0; i < all.length; i += 50) {
      const batch = all.slice(i, i + 50);
      try {
        const page = await search('user', new URLSearchParams({ cql: `id in (${batch.join(',')})`, limit: '50' }));
        for (const c of page.results) visible.add(c.id);
      } catch (err) {
        if (!(err instanceof ConfluenceError) || (err.status !== 400 && err.status !== 403)) throw err;
        for (const id of batch) {
          const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${id}`, { headers: { Accept: 'application/json' } });
          if (res.ok) visible.add(id);
          else if (res.status !== 401 && res.status !== 403 && res.status !== 404) throw await failure(res, `view page ${id}`);
        }
      }
    }
    return visible;
  },
};

export type ConfluenceClient = typeof confluence;
