import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ appRequest: vi.fn(), userRequest: vi.fn() }));
vi.mock('@forge/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forge/api')>();
  return {
    ...actual,
    default: { asApp: () => ({ requestJira: api.appRequest }), asUser: () => ({ requestJira: api.userRequest }) },
  };
});

const { isJiraRateLimited, jira, JiraError, pickDoneTransition, siteBaseFromSelf } = await import('../src/adapters/jira');

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

describe('demo seed and admin calls', () => {
  it('isAdminAsUser checks mypermissions as the current user', async () => {
    api.userRequest.mockResolvedValue(reply(200, { permissions: { ADMINISTER: { havePermission: true } } }));
    expect(await jira.isAdminAsUser()).toBe(true);
    expect(pathOf(api.userRequest.mock.calls[0] as unknown[])).toBe('/rest/api/3/mypermissions?permissions=ADMINISTER');
    api.userRequest.mockResolvedValue(reply(200, { permissions: { ADMINISTER: { havePermission: false } } }));
    expect(await jira.isAdminAsUser()).toBe(false);
  });

  it('bulkCreateIssues maps rejected elements to undefined, in input order', async () => {
    api.appRequest.mockResolvedValue(reply(201, { issues: [{ id: 1, key: 'PAY-1' }, { id: 3, key: 'PAY-2' }], errors: [{ failedElementNumber: 1 }] }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doc = { type: 'doc' as const, version: 1 as const, content: [] };
    const out = await jira.bulkCreateIssues('PAY', '10', [0, 1, 2].map((i) => ({ summary: `s${i}`, description: doc, labels: ['hindsight-demo'] })));
    expect(out).toEqual([{ id: '1', key: 'PAY-1' }, undefined, { id: '3', key: 'PAY-2' }]);
    const body = bodyOf(api.appRequest.mock.calls[0] as unknown[]) as { issueUpdates: { fields: Record<string, unknown> }[] };
    expect(body.issueUpdates[0]!.fields).toMatchObject({ project: { key: 'PAY' }, issuetype: { id: '10' }, labels: ['hindsight-demo'] });
  });

  it('transitionToDone retries without the resolution when Jira rejects it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api.appRequest
      .mockResolvedValueOnce(reply(200, { transitions: [{ id: '5', to: { name: 'In progress', statusCategory: { key: 'indeterminate' } } }, { id: '9', to: { name: 'Closed', statusCategory: { key: 'done' } } }] }))
      .mockResolvedValueOnce(reply(400, { errors: { resolution: 'Field cannot be set' } }))
      .mockResolvedValueOnce(reply(204, undefined));
    expect(await jira.transitionToDone('INC-2', 'Cannot Reproduce')).toEqual({ closed: true, status: 'Closed', resolution: null, path: [] });
    const calls = api.appRequest.mock.calls as unknown[][];
    expect(bodyOf(calls[1]!)).toEqual({ transition: { id: '9' }, fields: { resolution: { name: 'Cannot Reproduce' } } });
    expect(bodyOf(calls[2]!)).toEqual({ transition: { id: '9' } });
  });

  it('transitionToDone returns undefined without a Done transition', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api.appRequest.mockResolvedValue(reply(200, { transitions: [] }));
    expect(await jira.transitionToDone('INC-2')).toEqual({ closed: false, path: [], available: [] });
  });

  it('deleteIssue sends DELETE and treats 404 as deleted', async () => {
    api.appRequest.mockResolvedValue(reply(404, { errorMessages: ['gone'] }));
    await expect(jira.deleteIssue('PAY-1')).resolves.toBeUndefined();
    const call = api.appRequest.mock.calls[0] as unknown[];
    expect(pathOf(call)).toBe('/rest/api/3/issue/PAY-1?deleteSubtasks=true');
    expect((call[1] as { method: string }).method).toBe('DELETE');
  });

  it('setIssueProperty PUTs the value; getProject returns the project type', async () => {
    api.appRequest.mockResolvedValueOnce(reply(200, undefined)).mockResolvedValueOnce(reply(200, { id: 7, key: 'INC', name: 'Arkana Support', projectTypeKey: 'service_desk' }));
    await jira.setIssueProperty('INC-1', 'hindsight', { serviceKey: 'checkout' });
    expect((api.appRequest.mock.calls[0] as unknown[])[1]).toMatchObject({ method: 'PUT' });
    expect(await jira.getProject('INC')).toEqual({ id: '7', key: 'INC', name: 'Arkana Support', projectTypeKey: 'service_desk' });
  });
});

describe('site URL and Done transitions', () => {
  it('siteBaseFromSelf rejects the API gateway host', () => {
    expect(siteBaseFromSelf('https://api.atlassian.com/ex/jira/abc/rest/api/3/issue/1')).toBeNull();
  });

  it('siteUrl reads serverInfo.baseUrl; getIssueSelf uses it instead of the gateway self', async () => {
    api.appRequest.mockImplementation(async (path: { value: string }) =>
      path.value === '/rest/api/3/serverInfo'
        ? reply(200, { baseUrl: 'https://one-atlas-vyyd.atlassian.net' })
        : reply(200, { id: '1', key: 'INC-15', self: 'https://api.atlassian.com/ex/jira/abc/rest/api/3/issue/1' }),
    );
    expect(await jira.getIssueSelf('INC-15')).toEqual({ id: '1', key: 'INC-15', siteUrl: 'https://one-atlas-vyyd.atlassian.net' });
    expect(await jira.siteUrl()).toBe('https://one-atlas-vyyd.atlassian.net');
  });

  const t = (id: string, name: string, to: string, category = 'done') => ({ id, name, to: { name: to, statusCategory: { key: category } } });

  it('pickDoneTransition prefers Resolve over Cancel when asked, else keeps the first Done', () => {
    const list = [t('1', 'Cancel', 'Canceled'), t('2', 'Start', 'In progress', 'indeterminate'), t('3', 'Resolve', 'Resolved')];
    expect(pickDoneTransition(list, true)?.id).toBe('3');
    expect(pickDoneTransition(list, false)?.id).toBe('1');
    expect(pickDoneTransition([t('1', 'Decline', 'Declined'), t('4', 'Mark', 'Closed')], true)?.id).toBe('4');
    expect(pickDoneTransition([t('1', 'Cancel', 'Canceled')], true)?.id).toBe('1');
  });

  it('transitionToDone hops through an intermediate status to reach Done', async () => {
    api.appRequest
      .mockResolvedValueOnce(reply(200, { transitions: [t('11', 'Start work', 'In progress', 'indeterminate')] }))
      .mockResolvedValueOnce(reply(204, undefined))
      .mockResolvedValueOnce(reply(200, { transitions: [t('21', 'Cancel', 'Canceled'), t('22', 'Resolve', 'Resolved')] }))
      .mockResolvedValueOnce(reply(204, undefined));
    expect(await jira.transitionToDone('INC-15', undefined, { preferResolved: true })).toEqual({ closed: true, status: 'Resolved', resolution: null, path: ['In progress'] });
    expect(bodyOf((api.appRequest.mock.calls as unknown[][])[3]!)).toEqual({ transition: { id: '22' } });
  });
});

describe('transitionToDone without a reachable Done status', () => {
  it('returns the offered transitions so the caller can log them', async () => {
    const t = { id: '1', name: 'Respond', to: { name: 'Waiting for customer', statusCategory: { key: 'indeterminate' } } };
    api.appRequest.mockImplementation(async (_p: unknown, init?: { method?: string }) => (init?.method === 'POST' ? reply(204, undefined) : reply(200, { transitions: [t] })));
    const r = await jira.transitionToDone('INC-3', 'Cannot Reproduce');
    expect(r).toEqual({ closed: false, path: ['Waiting for customer'], available: ['Respond → Waiting for customer'] });
  });
});
