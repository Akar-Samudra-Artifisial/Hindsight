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
  history?: { createdDate?: string; createdBy?: { accountId?: string; accountType?: string } };
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

async function readJson<T>(res: APIResponse, what: string): Promise<T> {
  if (!res.ok) throw await failure(res, what);
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Confluence ${what} returned a response that is not JSON (${text.length} characters)`);
  }
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

interface RawPage {
  id: string | number;
  title?: string;
  _links?: { webui?: string; base?: string };
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

  /**
   * Title, version and storage body as the current user sees them; undefined on 401/403/404. Resolvers only.
   * Throws when the storage body is missing, because writing back a body that was not returned would wipe the page.
   */
  async getPageAsUser(pageId: string): Promise<{ title: string; version: number; body: string } | undefined> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, { headers: { Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403 || res.status === 404) return undefined;
    const page = await readJson<{ title: string; version: { number: number }; body?: { storage?: { value?: unknown } } }>(res, `get page ${pageId} as user`);
    const body = page.body?.storage?.value;
    if (typeof body !== 'string') throw new ConfluenceError(500, `Confluence get page ${pageId} as user returned no storage body`);
    return { title: page.title, version: page.version.number, body };
  },

  /**
   * Who saved each version of the page (newest 50), as the current user [VERIFY v2 `/pages/{id}/versions`]. Empty on
   * 401/403/404; other failures throw a ConfluenceError (429 included). Resolvers and actions only.
   */
  async getPageVersionAuthorsAsUser(pageId: string): Promise<{ accountId: string; at: string | null }[]> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}/versions?limit=50`, { headers: { Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403 || res.status === 404) return [];
    const body = await readJson<{ results?: { authorId?: string; createdAt?: string }[] }>(res, `versions of page ${pageId}`);
    return (body.results ?? []).flatMap((v) => (typeof v.authorId === 'string' && v.authorId !== '' ? [{ accountId: v.authorId, at: v.createdAt ?? null }] : []));
  },

  /** Replaces the body as the current user (they become a page contributor); returns the saved version. Resolvers only. */
  async updatePageAsUser(pageId: string, page: { title: string; body: string; version: number; message: string }): Promise<number> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title: page.title,
        body: { representation: 'storage', value: page.body },
        version: { number: page.version, message: page.message },
      }),
    });
    const saved = await readJson<{ version: { number: number } }>(res, `update page ${pageId} as user`);
    return saved.version.number;
  },

  // --- Demo seed --------------------------------------------------------------------------------

  /** The space with this key, or undefined. */
  async findSpace(key: string): Promise<{ id: string; key: string } | undefined> {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/spaces?keys=${key}&limit=1`, { headers: { Accept: 'application/json' } });
    const body = await readJson<{ results?: { id: string | number; key: string }[] }>(res, `find space ${key}`);
    const space = body.results?.[0];
    return space ? { id: String(space.id), key: space.key } : undefined;
  },

  /** Creates a global space (v1 API, scope `write:confluence-space`). */
  async createSpace(key: string, name: string, description: string): Promise<{ id: string; key: string }> {
    const res = await api.asApp().requestConfluence(route`/wiki/rest/api/space`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ key, name, description: { plain: { value: description, representation: 'plain' } } }),
    });
    const body = await readJson<{ id: string | number; key: string }>(res, `create space ${key}`);
    return { id: String(body.id), key: body.key };
  },

  /** The current page with exactly this title in the space, or undefined. */
  async findPageByTitle(spaceId: string, title: string): Promise<{ id: string; webUrl: string | null } | undefined> {
    const res = await api
      .asApp()
      .requestConfluence(route`/wiki/api/v2/spaces/${spaceId}/pages?title=${title}&status=current&limit=1`, { headers: { Accept: 'application/json' } });
    const body = await readJson<{ results?: RawPage[]; _links?: { base?: string } }>(res, `find page in space ${spaceId}`);
    const page = body.results?.[0];
    if (!page) return undefined;
    const base = body._links?.base;
    return { id: String(page.id), webUrl: base && page._links?.webui ? `${base}${page._links.webui}` : null };
  },

  /** Creates a current page from storage-format XHTML (v2). */
  async createPage(spaceId: string, title: string, storage: string): Promise<{ id: string; webUrl: string | null }> {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ spaceId, status: 'current', title, body: { representation: 'storage', value: storage } }),
    });
    const page = await readJson<RawPage>(res, `create page "${title}"`);
    const links = page._links;
    return { id: String(page.id), webUrl: links?.base && links.webui ? `${links.base}${links.webui}` : null };
  },

  /** Adds a global label (v1 API: v2 has no label write endpoint). */
  async addPageLabel(pageId: string, label: string): Promise<void> {
    const res = await api.asApp().requestConfluence(route`/wiki/rest/api/content/${pageId}/label`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify([{ prefix: 'global', name: label }]),
    });
    await readJson<unknown>(res, `add label to page ${pageId}`);
  },

  /**
   * Adds a footer comment to a page. Tries v2 `footer-comments` first [VERIFY scope `write:comment:confluence`]; when
   * v2 refuses it (401/403/404) it falls back to v1 `POST /wiki/rest/api/content` type `comment`.
   */
  async createFooterComment(pageId: string, storage: string): Promise<{ id: string; via: 'v2' | 'v1' }> {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/footer-comments`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ pageId, body: { representation: 'storage', value: storage } }),
    });
    if (res.ok) {
      const body = await readJson<{ id: string | number }>(res, `comment on page ${pageId}`);
      return { id: String(body.id), via: 'v2' };
    }
    if (res.status !== 401 && res.status !== 403 && res.status !== 404) throw await failure(res, `comment on page ${pageId}`);
    console.warn('confluence footer comment: v2 refused, falling back to v1', { pageId, status: res.status });
    const v1 = await api.asApp().requestConfluence(route`/wiki/rest/api/content`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ type: 'comment', container: { id: pageId, type: 'page' }, body: { storage: { value: storage, representation: 'storage' } } }),
    });
    const body = await readJson<{ id: string | number }>(v1, `comment on page ${pageId} (v1)`);
    return { id: String(body.id), via: 'v1' };
  },

  /** Moves the page to the trash, then purges it. A missing page counts as deleted; a failed purge is only logged. */
  async deletePage(pageId: string): Promise<void> {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, { method: 'DELETE', headers: { Accept: 'application/json' } });
    if (!res.ok && res.status !== 404) throw await failure(res, `delete page ${pageId}`);
    const purge = await api
      .asApp()
      .requestConfluence(route`/wiki/api/v2/pages/${pageId}?purge=true`, { method: 'DELETE', headers: { Accept: 'application/json' } });
    if (!purge.ok && purge.status !== 404) console.warn('confluence purge failed, page left in trash', { pageId, status: purge.status });
  },

  /** Total number of results for `cql` as the app (search index; lags right after creation). */
  async countByCql(cql: string): Promise<number> {
    const res = await api.asApp().requestConfluence(route`/wiki/rest/api/search?${new URLSearchParams({ cql, limit: '1' })}`, {
      headers: { Accept: 'application/json' },
    });
    const body = await readJson<{ totalSize?: number; size?: number }>(res, 'count search');
    return body.totalSize ?? body.size ?? 0;
  },
};

export type ConfluenceClient = typeof confluence;
