import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ appRequest: vi.fn(), userRequest: vi.fn() }));
vi.mock('@forge/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forge/api')>();
  return {
    ...actual,
    default: { asApp: () => ({ requestConfluence: api.appRequest }), asUser: () => ({ requestConfluence: api.userRequest }) },
  };
});

const { confluence, cursorFromNext, isConfluenceRateLimited } = await import('../src/adapters/confluence');

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const pathOf = (call: unknown[]) => (call[0] as { value: string }).value;

beforeEach(() => {
  api.appRequest.mockReset();
  api.userRequest.mockReset();
});

describe('confluence.getSentinelContent (v2)', () => {
  const route = (path: string, res: unknown) => [path, res] as const;
  const serve = (table: readonly (readonly [string, unknown])[]) =>
    api.appRequest.mockImplementation(async (r: { value: string }) => {
      const hit = table.find(([p]) => r.value === p);
      return hit ? hit[1] : reply(500, { message: `unexpected ${r.value}` });
    });

  it('page: v2 body-format=storage (never none), creator/version author, space id → key', async () => {
    serve([
      route(
        '/wiki/api/v2/pages/900?body-format=storage',
        reply(200, { id: '900', title: 'Gateway notes', spaceId: '77', authorId: 'u-1', version: { authorId: 'u-2' }, body: { storage: { value: '<p>gateway</p>' } }, _links: { webui: '/spaces/PLAT/pages/900' } }),
      ),
      route('/wiki/api/v2/spaces/77', reply(200, { id: '77', key: 'PLAT' })),
    ]);
    expect(await confluence.getSentinelContent('page', '900')).toEqual({
      type: 'page',
      id: '900',
      pageId: '900',
      pageTitle: 'Gateway notes',
      spaceKey: 'PLAT',
      storage: '<p>gateway</p>',
      createdBy: { accountId: 'u-1' },
      versionBy: { accountId: 'u-2' },
      links: { webui: '/spaces/PLAT/pages/900' },
    });
    expect(api.appRequest.mock.calls.map((c) => pathOf(c as unknown[])).join(' ')).not.toMatch(/body-format=none|\/rest\/api\/content/);
  });

  it('footer comment: v2 comment + parent page (title, space key)', async () => {
    serve([
      route(
        '/wiki/api/v2/footer-comments/5472298?body-format=storage',
        reply(200, { id: '5472298', pageId: '5079131', version: { authorId: 'u-3' }, body: { storage: { value: '<p>Provider notice #1</p>' } }, _links: { webui: '/spaces/PLAT/pages/5079131?focusedCommentId=5472298' } }),
      ),
      route('/wiki/api/v2/pages/5079131', reply(200, { id: '5079131', title: 'Build pipeline conventions', spaceId: '77' })),
      route('/wiki/api/v2/spaces/77', reply(200, { key: 'PLAT' })),
    ]);
    expect(await confluence.getSentinelContent('comment', '5472298')).toMatchObject({
      type: 'comment',
      pageId: '5079131',
      pageTitle: 'Build pipeline conventions',
      spaceKey: 'PLAT',
      storage: '<p>Provider notice #1</p>',
      createdBy: { accountId: 'u-3' },
    });
  });

  it('falls back to inline-comments on 404, and is undefined when neither exists', async () => {
    serve([
      route('/wiki/api/v2/footer-comments/5?body-format=storage', reply(404, {})),
      route('/wiki/api/v2/inline-comments/5?body-format=storage', reply(200, { pageId: '9', version: { authorId: 'u' }, body: { storage: { value: 'x' } } })),
      route('/wiki/api/v2/pages/9', reply(200, { title: 'T', spaceId: '1' })),
      route('/wiki/api/v2/spaces/1', reply(404, {})),
    ]);
    expect(await confluence.getSentinelContent('comment', '5')).toMatchObject({ pageId: '9', pageTitle: 'T', spaceKey: null });
    serve([route('/wiki/api/v2/footer-comments/6?body-format=storage', reply(404, {})), route('/wiki/api/v2/inline-comments/6?body-format=storage', reply(404, {}))]);
    expect(await confluence.getSentinelContent('comment', '6')).toBeUndefined();
  });

  it('v2 comment read refused (scope) → the CQL search, with account type; not in the index yet → not_indexed', async () => {
    api.appRequest.mockImplementation(async (r: { value: string }) => {
      if (r.value.startsWith('/wiki/api/v2/footer-comments/')) return reply(401, { message: 'Unauthorized; scope does not match' });
      return reply(200, {
        results: [
          {
            content: {
              id: 7,
              type: 'comment',
              space: { key: 'PLAT' },
              body: { storage: { value: '<p>n</p>' } },
              container: { id: 900, type: 'page', title: 'Conventions' },
              history: { createdBy: { accountId: 'h', accountType: 'atlassian' } },
              _links: { webui: '/x' },
            },
          },
        ],
        _links: { base: 'https://one.atlassian.net/wiki' },
      });
    });
    expect(await confluence.getSentinelContent('comment', '7')).toMatchObject({
      pageId: '900',
      pageTitle: 'Conventions',
      spaceKey: 'PLAT',
      createdBy: { accountId: 'h', accountType: 'atlassian' },
      links: { base: 'https://one.atlassian.net/wiki', webui: '/x' },
    });
    const searchCall = api.appRequest.mock.calls.map((c) => pathOf(c as unknown[])).find((p) => p.startsWith('/wiki/rest/api/search'))!;
    expect(new URL(searchCall, 'https://x.invalid').searchParams.get('cql')).toBe('id = 7 AND type = comment');
    api.appRequest.mockImplementation(async (r: { value: string }) => (r.value.startsWith('/wiki/api/v2/') ? reply(403, {}) : reply(200, { results: [] })));
    expect(await confluence.getSentinelContent('comment', '7')).toBe('not_indexed');
  });

  it('410 (removed endpoint) throws a ConfluenceError with the status; a non-numeric id is never requested', async () => {
    serve([route('/wiki/api/v2/pages/900?body-format=storage', reply(410, { message: 'This deprecated endpoint has been removed.' }))]);
    await expect(confluence.getSentinelContent('page', '900')).rejects.toMatchObject({ status: 410 });
    api.appRequest.mockClear();
    expect(await confluence.getSentinelContent('page', '1 OR 1=1')).toBeUndefined();
    expect(api.appRequest).not.toHaveBeenCalled();
  });

  it('createFooterComment returns the v2 author (the app account)', async () => {
    api.appRequest.mockResolvedValue(reply(200, { id: 50, version: { authorId: 'app-hs' } }));
    expect(await confluence.createFooterComment('9', '<p>x</p>')).toEqual({ id: '50', via: 'v2', authorId: 'app-hs' });
  });
});

describe('confluence.searchContent', () => {
  it('sends CQL with expansions and parses results, base and next cursor', async () => {
    api.appRequest.mockResolvedValue(
      reply(200, {
        results: [{ content: { id: 11, type: 'page', title: 'TLS note' } }, { title: 'no content' }],
        _links: { base: 'https://one.atlassian.net/wiki', next: '/rest/api/search?cql=x&cursor=abc%3D&limit=50' },
      }),
    );
    const page = await confluence.searchContent('space in ("PLAT")', undefined);
    expect(page).toEqual({ results: [{ id: '11', type: 'page', title: 'TLS note' }], base: 'https://one.atlassian.net/wiki', nextCursor: 'abc=' });
    const url = new URL(pathOf(api.appRequest.mock.calls[0] as unknown[]), 'https://x.invalid');
    expect(url.pathname).toBe('/wiki/rest/api/search');
    expect(url.searchParams.get('cql')).toBe('space in ("PLAT")');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('expand')).toContain('content.body.storage');
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('passes the cursor and has none on the last page', async () => {
    api.appRequest.mockResolvedValue(reply(200, { results: [], _links: {} }));
    expect(await confluence.searchContent('x', 'c1')).toEqual({ results: [], base: null });
    expect(new URL(pathOf(api.appRequest.mock.calls[0] as unknown[]), 'https://x.invalid').searchParams.get('cursor')).toBe('c1');
  });

  it('recognises 429', async () => {
    api.appRequest.mockResolvedValue(reply(429, { message: 'slow down' }));
    const err = await confluence.searchContent('x', undefined).catch((e: unknown) => e);
    expect(isConfluenceRateLimited(err)).toBe(true);
    expect(isConfluenceRateLimited(new Error('x'))).toBe(false);
  });
});

describe('confluence.visiblePageIds', () => {
  it('uses one CQL id search as the user', async () => {
    api.userRequest.mockResolvedValue(reply(200, { results: [{ content: { id: '2' } }] }));
    expect([...(await confluence.visiblePageIds(['1', '2', 'bad id']))]).toEqual(['2']);
    const url = new URL(pathOf(api.userRequest.mock.calls[0] as unknown[]), 'https://x.invalid');
    expect(url.searchParams.get('cql')).toBe('id in (1,2)');
    expect(api.appRequest).not.toHaveBeenCalled();
  });

  it('falls back to one page read per id when the search is refused', async () => {
    api.userRequest
      .mockResolvedValueOnce(reply(403, { message: 'scope' }))
      .mockResolvedValueOnce(reply(200, { id: '1' }))
      .mockResolvedValueOnce(reply(404, {}));
    expect([...(await confluence.visiblePageIds(['1', '2']))]).toEqual(['1']);
    expect(pathOf(api.userRequest.mock.calls[1] as unknown[])).toBe('/wiki/api/v2/pages/1');
  });
});

describe('cursorFromNext', () => {
  it('reads the cursor parameter', () => {
    expect(cursorFromNext('/rest/api/search?cursor=z&cql=a')).toBe('z');
    expect(cursorFromNext('/rest/api/search?cql=a')).toBeUndefined();
    expect(cursorFromNext(undefined)).toBeUndefined();
  });
});

describe('confluence demo seed calls', () => {
  it('createFooterComment uses v2 when allowed', async () => {
    api.appRequest.mockResolvedValue(reply(200, { id: 42 }));
    expect(await confluence.createFooterComment('9', '<p>x</p>')).toEqual({ id: '42', via: 'v2' });
    expect(pathOf(api.appRequest.mock.calls[0] as unknown[])).toBe('/wiki/api/v2/footer-comments');
  });

  it('createFooterComment falls back to v1 when v2 is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api.appRequest.mockResolvedValueOnce(reply(403, { message: 'scope' })).mockResolvedValueOnce(reply(200, { id: 43 }));
    expect(await confluence.createFooterComment('9', '<p>x</p>')).toEqual({ id: '43', via: 'v1' });
    const v1 = api.appRequest.mock.calls[1] as unknown[];
    expect(pathOf(v1)).toBe('/wiki/rest/api/content');
    expect(JSON.parse((v1[1] as { body: string }).body)).toMatchObject({ type: 'comment', container: { id: '9', type: 'page' } });
  });

  it('createFooterComment throws on other errors', async () => {
    api.appRequest.mockResolvedValue(reply(500, { message: 'boom' }));
    await expect(confluence.createFooterComment('9', '<p>x</p>')).rejects.toThrow('500');
  });

  it('deletePage trashes then purges; a failed purge is only logged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api.appRequest.mockResolvedValueOnce(reply(204, undefined)).mockResolvedValueOnce(reply(403, { message: 'no' }));
    await expect(confluence.deletePage('9')).resolves.toBeUndefined();
    expect((api.appRequest.mock.calls as unknown[][]).map(pathOf)).toEqual(['/wiki/api/v2/pages/9', '/wiki/api/v2/pages/9?purge=true']);
  });

  it('countByCql reads totalSize', async () => {
    api.appRequest.mockResolvedValue(reply(200, { results: [], totalSize: 6 }));
    expect(await confluence.countByCql('label = "hindsight-demo"')).toBe(6);
  });
});

describe('confluence.getPageVersionAuthorsAsUser', () => {
  it('reads version authors as the user; no access → empty; 429 throws a rate-limit error', async () => {
    api.userRequest.mockResolvedValueOnce(reply(200, { results: [{ number: 2, authorId: 'u1', createdAt: '2026-11-03T07:33:00.000Z' }, { number: 1, authorId: '' }] }));
    expect(await confluence.getPageVersionAuthorsAsUser('5079131')).toEqual([{ accountId: 'u1', at: '2026-11-03T07:33:00.000Z' }]);
    expect(pathOf(api.userRequest.mock.calls[0]!)).toBe('/wiki/api/v2/pages/5079131/versions?limit=50');
    api.userRequest.mockResolvedValueOnce(reply(403, {}));
    expect(await confluence.getPageVersionAuthorsAsUser('1')).toEqual([]);
    api.userRequest.mockResolvedValueOnce(reply(429, { message: 'slow down' }));
    const err = await confluence.getPageVersionAuthorsAsUser('1').catch((e: unknown) => e);
    expect(isConfluenceRateLimited(err)).toBe(true);
  });
});
