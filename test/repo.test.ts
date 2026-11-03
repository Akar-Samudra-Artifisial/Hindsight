import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('../src/adapters/sql', () => sql);

const { BATCH_ROWS, fromSqlTs, lockName, parseJsonColumn, repo, settingKey, sqlInt, toSqlTs } = await import('../src/adapters/repo');

type Call = [string, ...unknown[]];
const executeCalls = () => sql.execute.mock.calls as Call[];
const queryCalls = () => sql.query.mock.calls as Call[];

beforeEach(() => {
  sql.query.mockReset().mockResolvedValue([]);
  sql.execute.mockReset().mockResolvedValue(1);
});

const event = (i: number) => ({
  source: 'jira' as const,
  kind: 'issue',
  artifactId: `10${i}`,
  title: `Issue ${i}`,
  occurredAt: '2026-10-01T10:00:00.000Z',
  textLength: 10,
});

describe('column helpers', () => {
  it('converts timestamps to and from UTC SQL text', () => {
    expect(toSqlTs('2026-11-02T09:01:02.345Z')).toBe('2026-11-02 09:01:02');
    expect(fromSqlTs('2026-11-02 09:01:02')).toBe('2026-11-02T09:01:02.000Z');
    expect(fromSqlTs(new Date('2026-11-02T09:01:02Z'))).toBe('2026-11-02T09:01:02.000Z');
    expect(fromSqlTs(null)).toBeNull();
    expect(() => toSqlTs('nope')).toThrow('Invalid timestamp');
  });

  it('parses JSON columns that arrive as text or as values', () => {
    expect(parseJsonColumn<string[]>('["a"]')).toEqual(['a']);
    expect(parseJsonColumn<string[]>(['a'])).toEqual(['a']);
  });

  it('sqlInt truncates, clamps and rejects non-finite values', () => {
    expect(sqlInt(5.9, 0, 10)).toBe(5);
    expect(sqlInt(-3, 0, 10)).toBe(0);
    expect(sqlInt(99, 0, 10)).toBe(10);
    expect(() => sqlInt(Number.NaN, 0, 10)).toThrow(TypeError);
    expect(() => sqlInt('5' as unknown as number, 0, 10)).toThrow(TypeError);
  });

  it('validates setting keys and lock names', () => {
    expect(settingKey('window_days')).toBe('window_days');
    expect(() => settingKey("x'; DROP")).toThrow('Invalid setting key');
    expect(lockName('analyze:INC-12')).toBe('analyze:INC-12');
    expect(lockName('demo')).toBe('demo');
    expect(() => lockName('job:a b')).toThrow('Invalid lock name');
  });
});

describe('settings and locks', () => {
  it('stores settings as JSON with an upsert', async () => {
    await repo.setSetting('window_days', 30);
    expect(executeCalls()[0]).toEqual(['INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', 'window_days', '30']);
    sql.query.mockResolvedValueOnce([{ v: '30' }]);
    expect(await repo.getSetting<number>('window_days')).toBe(30);
  });

  it('acquireAppLock ensures the row, then takes the lock only when it has run out', async () => {
    sql.execute.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await repo.acquireAppLock('job:abc', '2026-11-02T09:00:00.000Z', 60)).toBe(false);
    expect(executeCalls()[0]![0]).toContain('ON DUPLICATE KEY UPDATE');
    const [statement, ...params] = executeCalls()[1]!;
    expect(statement).toContain('until_at IS NULL OR until_at <= ?');
    expect(params).toEqual(['2026-11-02 09:01:00', 'job:abc', '2026-11-02 09:00:00']);
  });
});

describe('graph connection', () => {
  it('upserts the connection without erasing known names', async () => {
    await repo.saveGraphConnection({ connectionId: 'conn-1', name: 'Hindsight', connectorName: 'c', flowName: 'f', lastAction: 'CREATED', status: 'active' });
    const [statement, ...params] = executeCalls()[0]!;
    expect(statement).toContain('INSERT INTO graph_connection');
    expect(statement).toContain('ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)');
    expect(statement).toContain('status = VALUES(status)');
    expect(params).toEqual(['conn-1', 'Hindsight', 'c', 'f', 'CREATED', 'active']);
  });

  it('reads the latest active connection', async () => {
    sql.query.mockResolvedValueOnce([
      { connection_id: 'conn-1', name: 'Hindsight', connector_name: null, flow_name: null, last_action: 'CREATED', status: 'active', created_at: '2026-11-03 01:00:00', updated_at: '2026-11-03 02:00:00' },
    ]);
    const c = await repo.getActiveGraphConnection();
    expect(queryCalls()[0]![0]).toMatch(/WHERE status = 'active' ORDER BY updated_at DESC, connection_id ASC LIMIT 1$/);
    expect(c).toMatchObject({ connectionId: 'conn-1', name: 'Hindsight', updatedAt: '2026-11-03T02:00:00.000Z' });
  });
});

describe('incidents', () => {
  it('upsert never writes scenario columns', async () => {
    await repo.upsertIncident({ issueKey: 'INC-1', issueId: '1', projectKey: 'INC', summary: 'Checkout failing', startedAt: '2026-10-20T00:00:00.000Z' });
    const [statement] = executeCalls()[0]!;
    expect(statement).not.toContain('scenario_');
    expect(statement).toContain('service_key = COALESCE(VALUES(service_key), service_key)');
  });
});

describe('events', () => {
  it('upserts in batches of 50 and never overwrites scenario_at', async () => {
    const events = Array.from({ length: BATCH_ROWS + 1 }, (_, i) => event(i));
    await repo.upsertEvents(events);
    expect(executeCalls()).toHaveLength(2);
    const [first, ...params] = executeCalls()[0]!;
    expect(first).toContain('ON DUPLICATE KEY UPDATE');
    expect(first).not.toContain('scenario_at');
    const update = first.slice(first.indexOf('ON DUPLICATE KEY UPDATE'));
    expect(update).not.toMatch(/\bid = VALUES\(id\)/);
    expect(update).toContain('title = VALUES(title)');
    expect(params).toHaveLength(BATCH_ROWS * 21);
    expect(executeCalls()[1]!.slice(1)).toHaveLength(21);
  });

  it('does nothing for an empty list', async () => {
    expect(await repo.upsertEvents([])).toBe(0);
    expect(sql.execute).not.toHaveBeenCalled();
  });
});

describe('jobs', () => {
  it('creates a queued job with JSON scope and progress', async () => {
    const id = await repo.createJob({
      incidentKey: 'INC-1',
      windowDays: 30,
      windowFrom: '2026-09-20T00:00:00.000Z',
      windowTo: '2026-10-20T00:00:00.000Z',
      scope: { jiraProjectKeys: ['PAY'] },
    });
    const [statement, ...params] = executeCalls()[0]!;
    expect(statement).toContain("VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)");
    expect(params).toEqual([id, 'INC-1', 30, '2026-09-20 00:00:00', '2026-10-20 00:00:00', '{"jiraProjectKeys":["PAY"]}', '{}', null]);
  });

  it('updates only the patched columns', async () => {
    await repo.updateJob('j1', { status: 'collecting', cursor: { phase: 'jira' }, lastError: null });
    expect(executeCalls()[0]).toEqual(['UPDATE analysis_jobs SET status = ?, cursor_json = ?, last_error = ? WHERE id = ?', 'collecting', '{"phase":"jira"}', null, 'j1']);
    expect(await repo.updateJob('j1', {})).toBe(0);
  });

  it('finds the active job excluding terminal states', async () => {
    await repo.getActiveJobForIncident('INC-1');
    const [statement, ...params] = queryCalls()[0]!;
    expect(statement).toContain('status NOT IN (?, ?)');
    expect(statement).toMatch(/LIMIT 1$/);
    expect(params).toEqual(['INC-1', 'done', 'failed']);
  });
});

describe('candidates', () => {
  const candidate = (i: number) => ({
    jobId: 'j1',
    incidentKey: 'INC-1',
    eventId: `e${i}`,
    filterScore: 40,
    reasons: ['keyword'],
    matchedKeywords: ['tls'],
    daysBefore: 3,
    excerpt: 'x'.repeat(2500),
  });

  it('inserts in batches, keeps the first row on duplicates and caps the excerpt', async () => {
    await repo.insertCandidates(Array.from({ length: 51 }, (_, i) => candidate(i)));
    expect(executeCalls()).toHaveLength(2);
    const [statement, ...params] = executeCalls()[1]!;
    expect(statement).toContain('ON DUPLICATE KEY UPDATE id = id');
    expect(params).toHaveLength(12);
    expect(String(params[8])).toHaveLength(2000);
  });

  it('inlines LIMIT through sqlInt, never as a bound parameter', async () => {
    await repo.listKeptCandidates('j1', 10.7);
    await repo.listKeptCandidates('j1', 99_999);
    const [[a, ...aParams], [b]] = queryCalls() as [Call, Call];
    expect(a).toMatch(/ORDER BY filter_score DESC, days_before DESC, event_id ASC LIMIT 10$/);
    expect(aParams).toEqual(['j1']);
    expect(b).toMatch(/LIMIT 500$/);
    for (const [text] of queryCalls()) expect(text).not.toMatch(/(LIMIT|OFFSET) \?/);
  });

  it('marks truncated candidates per job', async () => {
    await repo.markCandidatesTruncated('j1', ['c1', 'c2']);
    expect(executeCalls()[0]).toEqual(["UPDATE signal_candidates SET status = 'truncated' WHERE job_id = ? AND id IN (?, ?)", 'j1', 'c1', 'c2']);
  });
});

describe('collect lookups', () => {
  it('findEventsByRefs returns id + scenario time only for the requested refs', async () => {
    sql.query.mockResolvedValueOnce([
      { id: 'e1', source: 'jira', artifact_id: '10', comment_id: '', scenario_at: '2026-10-01 00:00:00' },
      { id: 'e2', source: 'jira', artifact_id: '10', comment_id: 'c9', scenario_at: null },
    ]);
    const found = await repo.findEventsByRefs([{ source: 'jira', artifactId: '10', commentId: '' }]);
    expect([...found.entries()]).toEqual([['jira|10|', { id: 'e1', scenarioAt: '2026-10-01T00:00:00.000Z' }]]);
    const [statement, ...params] = queryCalls()[0] as Call;
    expect(statement).toContain('WHERE source = ? AND artifact_id IN (?)');
    expect(params).toEqual(['jira', '10']);
  });

  it('listCandidateRanks inlines a validated LIMIT', async () => {
    await repo.listCandidateRanks('job-1');
    expect((queryCalls()[0] as Call)[0]).toMatch(/LIMIT 20000$/);
  });

  it('getLatestJobForIncident orders by newest', async () => {
    await repo.getLatestJobForIncident('INC-1');
    expect((queryCalls()[0] as Call)[0]).toContain('ORDER BY created_at DESC, id DESC LIMIT 1');
  });
});

describe('extendAppLock', () => {
  it('moves the expiry of an existing lock', async () => {
    await repo.extendAppLock('analyze:INC-1', '2026-11-02T09:00:00.000Z', 1200);
    expect(executeCalls()[0]).toEqual(['UPDATE app_locks SET until_at = ? WHERE name = ?', '2026-11-02 09:20:00', 'analyze:INC-1']);
  });
});
