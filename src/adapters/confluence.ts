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
  version?: { when?: string; number?: number; by?: { accountId?: string; accountType?: string } };
  body?: { storage?: { value?: string } };
  container?: { id?: string | number; title?: string; type?: string };
  _links?: { webui?: string; base?: string };
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

// --- Sentinel reads (v2) ---------------------------------------------------------------------------

type Author = { accountId?: string; accountType?: string };

/** A Confluence page or comment as Sentinel reads it. v2 gives author ids only; `accountType` comes from the search. */
export interface SentinelContent {
  type: 'page' | 'comment';
  id: string;
  /** The page itself, or the page the comment is on; null for a comment on a blog post or attachment. */
  pageId: string | null;
  pageTitle: string | null;
  spaceKey: string | null;
  storage: string;
  createdBy: Author | null;
  /** Who saved the current version. */
  versionBy: Author | null;
  links: { base?: string; webui?: string };
}

interface V2Page {
  title?: string;
  spaceId?: string | number;
  authorId?: string;
  version?: { authorId?: string };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
}

interface V2Comment {
  pageId?: string | number | null;
  version?: { authorId?: string };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
}

const ACCEPT = { headers: { Accept: 'application/json' } };

const authorOf = (id: unknown): Author | null => (typeof id === 'string' && id !== '' ? { accountId: id } : null);

/** v2 page as the app (`body-format=storage` only when the body is needed; `none` is refused with 400); undefined on 404. */
async function getPageV2(id: string, withBody: boolean): Promise<V2Page | undefined> {
  const res = withBody
    ? await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${id}?body-format=storage`, ACCEPT)
    : await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${id}`, ACCEPT);
  if (res.status === 404) return undefined;
  return readJson<V2Page>(res, `get page ${id}`);
}

/** Space key from a v2 space id as the app; null when the space is gone. */
async function spaceKeyV2(spaceId: string): Promise<string | null> {
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/spaces/${spaceId}`, ACCEPT);
  if (res.status === 404) return null;
  const body = await readJson<{ key?: string }>(res, `get space ${spaceId}`);
  return typeof body.key === 'string' && body.key !== '' ? body.key : null;
}

/** Footer comment, else inline comment (v2, as the app); undefined when neither exists; `'refused'` on 401/403. */
async function getCommentV2(id: string): Promise<V2Comment | undefined | 'refused'> {
  for (const which of ['footer', 'inline'] as const) {
    const res =
      which === 'footer'
        ? await api.asApp().requestConfluence(route`/wiki/api/v2/footer-comments/${id}?body-format=storage`, ACCEPT)
        : await api.asApp().requestConfluence(route`/wiki/api/v2/inline-comments/${id}?body-format=storage`, ACCEPT);
    if (res.status === 404) continue;
    if (res.status === 401 || res.status === 403) {
      console.warn('confluence comment: v2 refused, reading it from the search', { id, status: res.status });
      return 'refused';
    }
    return readJson<V2Comment>(res, `get ${which} comment ${id}`);
  }
  return undefined;
}

/** A comment from the v1 CQL search (as the app), with container, space, history and body. */
async function commentFromSearch(id: string): Promise<SentinelContent | 'not_indexed'> {
  const page = await search('app', new URLSearchParams({ cql: `id = ${id} AND type = comment`, limit: '1', expand: SEARCH_EXPAND }));
  const c = page.results[0];
  if (!c) return 'not_indexed';
  const onPage = c.container?.type === 'page' && c.container.id !== undefined;
  return {
    type: 'comment',
    id,
    pageId: onPage ? String(c.container?.id) : null,
    pageTitle: c.container?.title ?? null,
    spaceKey: c.space?.key ?? null,
    storage: c.body?.storage?.value ?? '',
    createdBy: c.history?.createdBy ?? null,
    versionBy: c.version?.by ?? null,
    links: { ...(page.base ? { base: page.base } : {}), ...(c._links?.webui ? { webui: c._links.webui } : {}) },
  };
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
  async createFooterComment(pageId: string, storage: string): Promise<{ id: string; via: 'v2' | 'v1'; authorId?: string }> {
    const res = await api.asApp().requestConfluence(route`/wiki/api/v2/footer-comments`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ pageId, body: { representation: 'storage', value: storage } }),
    });
    if (res.ok) {
      const body = await readJson<{ id: string | number; version?: { authorId?: string } }>(res, `comment on page ${pageId}`);
      // The author of a comment the app wrote is the app account (Sentinel learns it, v2 reads carry no account type).
      const authorId = body.version?.authorId;
      return { id: String(body.id), via: 'v2', ...(typeof authorId === 'string' && authorId !== '' ? { authorId } : {}) };
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

  // --- Sentinel ---------------------------------------------------------------------------------

  /**
   * A page or comment as Sentinel reads it, as the app. v1 `GET /wiki/rest/api/content/{id}` is gone (410), so pages
   * come from v2 `/pages/{id}` and comments from v2 `/footer-comments/{id}` (then `/inline-comments/{id}`). v2 comment
   * reads need `read:comment:confluence`, which the app does not hold: when v2 refuses (401/403) the comment is read
   * from the v1 CQL search (`search:confluence`, proven in collect). Undefined when it does not exist (404);
   * `'not_indexed'` when only the search could read it and the index does not have it yet.
   */
  async getSentinelContent(kind: 'page' | 'comment', id: string): Promise<SentinelContent | undefined | 'not_indexed'> {
    if (!/^[0-9]{1,18}$/.test(id)) return undefined;
    const spaces = new Map<string, string | null>();
    const spaceKey = async (spaceId: unknown): Promise<string | null> => {
      if (spaceId === undefined || spaceId === null || spaceId === '') return null;
      const sid = String(spaceId);
      if (!spaces.has(sid)) spaces.set(sid, await spaceKeyV2(sid));
      return spaces.get(sid) ?? null;
    };
    if (kind === 'page') {
      const page = await getPageV2(id, true);
      if (!page) return undefined;
      return {
        type: 'page',
        id,
        pageId: id,
        pageTitle: page.title ?? null,
        spaceKey: await spaceKey(page.spaceId),
        storage: page.body?.storage?.value ?? '',
        createdBy: authorOf(page.authorId),
        versionBy: authorOf(page.version?.authorId),
        links: page._links ?? {},
      };
    }
    const comment = await getCommentV2(id);
    if (comment === 'refused') return commentFromSearch(id);
    if (!comment) return undefined;
    const pageId = comment.pageId !== undefined && comment.pageId !== null && comment.pageId !== '' ? String(comment.pageId) : null;
    const page = pageId ? await getPageV2(pageId, false) : undefined;
    // v2 comments carry no creator; the version author is the creator of version 1 and the last editor after that.
    const by = authorOf(comment.version?.authorId);
    return {
      type: 'comment',
      id,
      pageId,
      pageTitle: page?.title ?? null,
      spaceKey: page ? await spaceKey(page.spaceId) : null,
      storage: comment.body?.storage?.value ?? '',
      createdBy: by,
      versionBy: by,
      links: comment._links ?? {},
    };
  },

  /** Adds a footer comment as the current user (v2). Resolvers only. */
  async createFooterCommentAsUser(pageId: string, storage: string): Promise<{ id: string }> {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/footer-comments`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ pageId, body: { representation: 'storage', value: storage } }),
    });
    const body = await readJson<{ id: string | number }>(res, `comment on page ${pageId} as user`);
    return { id: String(body.id) };
  },

  /** Deletes a page or comment (v1) as the app; a missing one counts as deleted. */
  async deleteContentV1(id: string): Promise<void> {
    const res = await api.asApp().requestConfluence(route`/wiki/rest/api/content/${id}`, { method: 'DELETE', headers: { Accept: 'application/json' } });
    if (!res.ok && res.status !== 404) throw await failure(res, `delete content ${id}`);
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
