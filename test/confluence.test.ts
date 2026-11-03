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
