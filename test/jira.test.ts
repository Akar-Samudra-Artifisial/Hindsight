import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ appRequest: vi.fn(), userRequest: vi.fn() }));
vi.mock('@forge/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forge/api')>();
  return {
    ...actual,
    default: { asApp: () => ({ requestJira: api.appRequest }), asUser: () => ({ requestJira: api.userRequest }) },
  };
});

const { isJiraRateLimited, jira, JiraError, siteBaseFromSelf } = await import('../src/adapters/jira');

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
const pathOf = (call: unknown[]) => (call[0] as { value: string }).value;
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;

beforeEach(() => {
  api.appRequest.mockReset();
  api.userRequest.mockReset();
});

describe('jira.searchPage', () => {
  it('posts JQL as the app and passes nextPageToken through', async () => {
    api.appRequest.mockResolvedValue(reply(200, { issues: [{ id: '1', key: 'PAY-1' }], nextPageToken: 'tok2' }));
    const page = await jira.searchPage('project = PAY', 'tok1');
    expect(page).toEqual({ issues: [{ id: '1', key: 'PAY-1' }], nextPageToken: 'tok2' });
    const call = api.appRequest.mock.calls[0] as unknown[];
    expect(pathOf(call)).toBe('/rest/api/3/search/jql');
    expect(bodyOf(call)).toMatchObject({ jql: 'project = PAY', maxResults: 50, nextPageToken: 'tok1' });
    expect(bodyOf(call)['fields']).toContain('comment');
  });

  it('omits the token on the first page and when the last page has none', async () => {
    api.appRequest.mockResolvedValue(reply(200, { issues: [] }));
    expect(await jira.searchPage('x', undefined)).toEqual({ issues: [] });
    expect(bodyOf(api.appRequest.mock.calls[0] as unknown[])).not.toHaveProperty('nextPageToken');
  });

  it('recognises 429 as rate limited', async () => {
    api.appRequest.mockResolvedValue(reply(429, { errorMessages: ['Too many requests'] }));
    const err = await jira.searchPage('x', undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(isJiraRateLimited(err)).toBe(true);
    expect(isJiraRateLimited(new JiraError(500, 'x'))).toBe(false);
  });
});

describe('jira.listComments', () => {
  it('reads comments oldest first with startAt/maxResults', async () => {
    api.appRequest.mockResolvedValue(reply(200, { comments: [{ id: 'c1' }], total: 1 }));
    expect(await jira.listComments('10001', 0, 100)).toEqual({ comments: [{ id: 'c1' }], total: 1 });
    expect(pathOf(api.appRequest.mock.calls[0] as unknown[])).toBe('/rest/api/3/issue/10001/comment?startAt=0&maxResults=100&orderBy=created');
  });
});

describe('as-user reads', () => {
  it('getIncidentAsUser: undefined on 404/403', async () => {
    api.userRequest.mockResolvedValueOnce(reply(404, { errorMessages: ['nope'] })).mockResolvedValueOnce(reply(403, {}));
    expect(await jira.getIncidentAsUser('INC-1')).toBeUndefined();
    expect(await jira.getIncidentAsUser('INC-1')).toBeUndefined();
    expect(api.appRequest).not.toHaveBeenCalled();
  });

  it('visibleIssueIds batches numeric ids by 100 as the user', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    api.userRequest.mockResolvedValueOnce(reply(200, { issues: [{ id: '1000' }] })).mockResolvedValueOnce(reply(200, { issues: [{ id: '1149' }] }));
    const visible = await jira.visibleIssueIds([...ids, 'x) OR 1=1']);
    expect([...visible]).toEqual(['1000', '1149']);
    expect(api.userRequest).toHaveBeenCalledTimes(2);
    const first = bodyOf(api.userRequest.mock.calls[0] as unknown[]);
    expect(first['jql']).toMatch(/^id in \(1000,1001,.*1099\)$/);
    expect(first['fields']).toEqual(['key']);
  });

  it('getIssueProperty: value, or undefined when not set', async () => {
    api.appRequest.mockResolvedValueOnce(reply(200, { key: 'hindsight', value: { serviceKey: 'payments' } })).mockResolvedValueOnce(reply(404, {}));
    expect(await jira.getIssueProperty('INC-1', 'hindsight')).toEqual({ serviceKey: 'payments' });
    expect(await jira.getIssueProperty('INC-1', 'hindsight')).toBeUndefined();
  });
});

describe('siteBaseFromSelf', () => {
  it('extracts the site origin', () => {
    expect(siteBaseFromSelf('https://one.atlassian.net/rest/api/3/issue/1')).toBe('https://one.atlassian.net');
    expect(siteBaseFromSelf(undefined)).toBeNull();
    expect(siteBaseFromSelf('nope')).toBeNull();
  });
});
