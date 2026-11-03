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

describe('demo seed rows', () => {
  const row = {
    source: 'jsm' as const,
    kind: 'comment',
    artifactId: '10010',
    commentId: '20020',
    artifactKey: 'INC-2',
    title: 'Payment fails at checkout',
    url: null,
    projectKey: 'INC',
    spaceKey: null,
    occurredAt: '2026-11-03T10:00:00.000Z',
    scenarioAt: '2026-10-27T09:12:00.000Z',
  };

  it('seedScenarioEvents writes scenario_at and only updates scenario_at on a duplicate', async () => {
    await repo.seedScenarioEvents([row]);
    const [statement, ...params] = executeCalls()[0]!;
    expect(statement).toContain('scenario_at)');
    expect(statement).toMatch(/ON DUPLICATE KEY UPDATE scenario_at = VALUES\(scenario_at\)\s*$/);
    expect(params).toContain('2026-10-27 09:12:00');
    expect(params).toHaveLength(12);
  });

  it('upsertEvents still never writes scenario_at', async () => {
    await repo.upsertEvents([event(1)]);
    expect(executeCalls()[0]![0]).not.toContain('scenario_at');
  });

  it('seedIncidentScenario updates only scenario and service columns on a duplicate', async () => {
    await repo.seedIncidentScenario({
      issueKey: 'INC-1',
      issueId: '1',
      projectKey: 'INC',
      summary: 'Checkout payments failing',
      serviceKey: 'checkout',
      startedAt: '2026-11-03T10:00:00.000Z',
      scenarioStartedAt: '2026-11-02T09:12:00.000Z',
      scenarioResolvedAt: '2026-11-02T12:12:00.000Z',
    });
    const statement = executeCalls()[0]![0];
    const update = statement.slice(statement.indexOf('ON DUPLICATE KEY UPDATE'));
    expect(update).toContain('scenario_started_at = VALUES(scenario_started_at)');
    expect(update).not.toContain('started_at = VALUES(started_at),');
    expect(update).not.toContain('summary');
  });

  it('listDemoArtifacts uses an inline integer LIMIT and maps rows', async () => {
    sql.query.mockResolvedValue([
      { slot: 'incident', role: 'incident', source: 'jsm', artifact_id: '1', comment_id: '', artifact_key: 'INC-1', url: null, scenario_at: '2026-11-02 09:12:00', created_by_app: 1, created_at: '2026-11-03 10:00:00' },
    ]);
    const rows = await repo.listDemoArtifacts();
    expect(queryCalls()[0]![0]).toMatch(/LIMIT 500$/);
    expect(rows[0]).toMatchObject({ slot: 'incident', createdByApp: true, scenarioAt: '2026-11-02T09:12:00.000Z', artifactKey: 'INC-1' });
  });

  it('deleteJobsForIncident deletes reach paths, routes, decisions, signals, candidates then jobs, one statement each', async () => {
    await repo.deleteJobsForIncident('INC-1');
    expect(executeCalls().map((c) => c[0])).toEqual([
      'DELETE FROM reach_paths WHERE incident_key = ?',
      'DELETE FROM routes WHERE origin_incident_key = ?',
      'DELETE FROM signal_decisions WHERE incident_key = ?',
      'DELETE FROM signals WHERE incident_key = ?',
      'DELETE FROM signal_candidates WHERE incident_key = ?',
      'DELETE FROM analysis_jobs WHERE incident_key = ?',
    ]);
    expect(executeCalls().every((c) => c[1] === 'INC-1')).toBe(true);
  });
});

describe('signals', () => {
  const signal = (i: number) => ({
    jobId: 'j2',
    incidentKey: 'INC-1',
    eventId: `e${i}`,
    candidateId: `c${i}`,
    signalType: 'technical_warning' as const,
    quote: 'q'.repeat(400),
    reason: 'Names the retry risk.',
    confidence: 1.4,
    daysBefore: 12,
    textHash: null,
    model: 'claude-haiku-4-5-20251001',
    promptVersion: 'score-v1',
  });

  it('upsertSignals inserts proposed rows and never overwrites a confirmed or rejected signal', async () => {
    await repo.upsertSignals(Array.from({ length: 51 }, (_, i) => signal(i)));
    expect(executeCalls()).toHaveLength(2);
    const [statement, ...params] = executeCalls()[1]!;
    expect(statement).toContain('ON DUPLICATE KEY UPDATE');
    // Every refreshed column is guarded by the proposed status, and status itself is never updated.
    const updates = statement.slice(statement.indexOf('ON DUPLICATE KEY UPDATE') + 'ON DUPLICATE KEY UPDATE'.length).split(/,\s(?=\w+ = )/);
    for (const u of updates) expect(u.trim()).toMatch(/^(\w+) = IF\(status = 'proposed', VALUES\(\1\), \1\)$/);
    expect(statement).not.toMatch(/\bstatus = VALUES\(status\)/);
    expect(params).toHaveLength(14);
    expect(String(params[6])).toHaveLength(300);
    expect(params[8]).toBe(1);
    expect(params[9]).toBe('proposed');
    expect(await repo.upsertSignals([])).toBe(0);
  });

  it('listSignalsForIncident inlines a validated LIMIT and maps rows', async () => {
    sql.query.mockResolvedValueOnce([
      { id: 's1', job_id: 'j', incident_key: 'INC-1', event_id: 'e', candidate_id: 'c', signal_type: 'external_change', quote: 'q', reason: 'r', confidence: '0.8', status: 'confirmed', days_before: 9, text_hash: null, model: 'm', prompt_version: 'p', created_at: '2026-11-03 10:00:00', updated_at: '2026-11-03 10:00:00' },
    ]);
    const rows = await repo.listSignalsForIncident('INC-1', 9999);
    expect((queryCalls()[0] as Call)[0]).toMatch(/ORDER BY days_before DESC, id ASC LIMIT 500$/);
    expect(rows[0]).toMatchObject({ id: 's1', status: 'confirmed', confidence: 0.8, daysBefore: 9, signalType: 'external_change' });
  });

  it('updateSignalStatus is a compare-and-set on the previous status', async () => {
    expect(await repo.updateSignalStatus('s1', 'proposed', 'confirmed')).toBe(1);
    expect(executeCalls()[0]).toEqual(['UPDATE signals SET status = ? WHERE id = ? AND status = ?', 'confirmed', 's1', 'proposed']);
  });

  it('deleteStaleProposedSignals removes decisions then proposed signals of strictly older jobs, keeping score_failed events', async () => {
    sql.execute.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await repo.deleteStaleProposedSignals('INC-1', { id: 'j2', createdAt: '2026-11-03T10:00:00.000Z' })).toBe(2);
    const [[decisions, ...dParams], [signals, ...sParams]] = executeCalls() as [Call, Call];
    expect(decisions).toMatch(/^DELETE FROM signal_decisions WHERE incident_key = \? AND signal_id IN \(SELECT id FROM signals WHERE /);
    expect(signals).toMatch(/^DELETE FROM signals WHERE /);
    for (const s of [decisions, signals]) {
      expect(s).toContain("status = 'proposed' AND job_id <> ?");
      expect(s).toContain('job_id IN (SELECT id FROM analysis_jobs WHERE incident_key = ? AND created_at < ?)');
      expect(s).toContain("event_id NOT IN (SELECT event_id FROM signal_candidates WHERE job_id = ? AND status = 'score_failed')");
    }
    expect(sParams).toEqual(['INC-1', 'j2', 'INC-1', '2026-11-03 10:00:00', 'j2']);
    expect(dParams).toEqual(['INC-1', ...sParams]);
  });

  it('scoreErrorCounts groups failed candidates by reason', async () => {
    sql.query.mockResolvedValueOnce([
      { score_error: 'quote_not_found', n: 2 },
      { score_error: 'llm_invalid_output', n: 1 },
    ]);
    expect(await repo.scoreErrorCounts('j1')).toEqual({ quote_not_found: 2, llm_invalid_output: 1 });
    expect((queryCalls()[0] as Call)[0]).toContain("status = 'score_failed' GROUP BY score_error");
  });

  it('insertDecision stores the decider for audit', async () => {
    await repo.insertDecision({ signalId: 's1', incidentKey: 'INC-1', decision: 'confirm', decidedBy: 'acc-1' });
    const [statement, ...params] = executeCalls()[0]!;
    expect(statement).toContain('INSERT INTO signal_decisions');
    expect(params.slice(1)).toEqual(['s1', 'INC-1', 'confirm', 'acc-1', null]);
  });

  it('markCandidates sets status and score_error per job; candidateStatusCounts groups by status', async () => {
    await repo.markCandidates('j1', ['c1', 'c2'], 'score_failed', 'quote_not_found');
    expect(executeCalls()[0]).toEqual(['UPDATE signal_candidates SET status = ?, score_error = ? WHERE job_id = ? AND id IN (?, ?)', 'score_failed', 'quote_not_found', 'j1', 'c1', 'c2']);
    sql.query.mockResolvedValueOnce([
      { status: 'kept', n: 3 },
      { status: 'score_failed', n: '1' },
    ]);
    expect(await repo.candidateStatusCounts('j1')).toEqual({ kept: 3, score_failed: 1 });
  });
});

describe('getLatestCollectedJobForIncident', () => {
  it('only considers jobs whose collect finished', async () => {
    await repo.getLatestCollectedJobForIncident('INC-1');
    const [statement, ...params] = queryCalls()[0]!;
    expect(statement).toContain('status IN (?, ?, ?, ?)');
    expect(params).toEqual(['INC-1', 'scoring', 'reaching', 'proposing', 'done']);
  });
});

describe('reach paths', () => {
  const path = (i: number, reached: boolean | null = false) => ({
    signalId: `sig-${i}`,
    incidentKey: 'INC-1',
    reached,
    hopCount: 2,
    steps: [{ role: 'author', teamId: 't-plat', teamName: 'Arkana Platform', at: null }],
    stopPoint: { teamId: 't-plat', teamName: 'Arkana Platform', missingLinks: 1 },
    graphState: 'ok' as const,
    responderTeamId: 't-pay',
    via: 'resolver' as const,
  });

  it('upsertReachPaths is idempotent per signal and refreshes every computed column', async () => {
    await repo.upsertReachPaths(Array.from({ length: 51 }, (_, i) => path(i, i === 0 ? null : true)));
    expect(executeCalls()).toHaveLength(2);
    const [statement, ...params] = executeCalls()[0]!;
    expect(statement).toContain('INSERT INTO reach_paths');
    expect(statement).toContain('ON DUPLICATE KEY UPDATE');
    expect(statement).not.toMatch(/\b(id|signal_id) = /);
    // A stored `ok` path is never replaced by pending/unknown: every column is guarded and graph_state comes last.
    const keep = "graph_state = 'ok' AND VALUES(graph_state) <> 'ok'";
    const updates = statement.slice(statement.indexOf('ON DUPLICATE KEY UPDATE') + 'ON DUPLICATE KEY UPDATE'.length).split(/,\s(?=\w+ = )/).map((u) => u.trim());
    for (const u of updates) expect(u).toContain(`IF(${keep}, `);
    expect(updates).toContain(`computed_at = IF(${keep}, computed_at, CURRENT_TIMESTAMP)`);
    expect(updates.at(-1)).toBe(`graph_state = IF(${keep}, graph_state, VALUES(graph_state))`);
    expect(params).toHaveLength(50 * 10);
    expect(params.slice(1, 10)).toEqual([
      'sig-0',
      'INC-1',
      null,
      2,
      JSON.stringify(path(0).steps),
      JSON.stringify(path(0).stopPoint),
      'ok',
      't-pay',
      'resolver',
    ]);
    expect(params[13]).toBe(1);
    expect(await repo.upsertReachPaths([])).toBe(0);
  });

  it('listReachPaths maps rows (reached null stays null, JSON parsed)', async () => {
    sql.query.mockResolvedValueOnce([
      { id: 'r1', signal_id: 'sig-1', incident_key: 'INC-1', reached: null, hop_count: 0, steps_json: '[]', stop_point_json: null, graph_state: 'unknown', responder_team_id: null, via: 'action', computed_at: '2026-11-03 10:00:00' },
      { id: 'r2', signal_id: 'sig-2', incident_key: 'INC-1', reached: 0, hop_count: 1, steps_json: [{ role: 'author', teamId: null, teamName: null }], stop_point_json: '{"teamId":null,"teamName":null,"missingLinks":1}', graph_state: 'ok', responder_team_id: 't', via: 'resolver', computed_at: '2026-11-03 10:00:00' },
    ]);
    const rows = await repo.listReachPaths('INC-1');
    expect(queryCalls()[0]![0]).toMatch(/WHERE incident_key = \? ORDER BY signal_id ASC LIMIT 500$/);
    expect(rows[0]).toMatchObject({ reached: null, steps: [], stopPoint: null, graphState: 'unknown', computedAt: '2026-11-03T10:00:00.000Z' });
    expect(rows[1]).toMatchObject({ reached: false, hopCount: 1, stopPoint: { missingLinks: 1 }, responderTeamId: 't' });
  });
});

describe('routes', () => {
  const route = (i: number) => ({
    originIncidentKey: 'INC-1',
    sourceType: 'confluence_space' as const,
    sourceKey: `SP${i}`,
    spec: { keywords: ['vendor'], target: { teamId: 't-pay', action: 'mention' as const } },
    reason: 'Signal stopped at Platform',
    estimatedDaysSaved: 11.04,
    maxDaysBefore: 12,
    signalIds: ['sig-1'],
    score: 11.044,
    rankNo: i + 1,
  });

  it('upsertRoutes inserts proposed rows and never demotes or rewrites an active route', async () => {
    await repo.upsertRoutes([route(0), route(1)]);
    const [statement, ...params] = executeCalls()[0]!;
    expect(statement).toContain('ON DUPLICATE KEY UPDATE');
    const updates = statement.slice(statement.indexOf('ON DUPLICATE KEY UPDATE') + 'ON DUPLICATE KEY UPDATE'.length).split(/,\s(?=\w+ = )/);
    for (const u of updates) expect(u.trim()).toMatch(/^(\w+) = IF\(status = 'active', \1, VALUES\(\1\)\)$/);
    expect(statement).not.toMatch(/\bstatus = VALUES\(status\)/);
    expect(statement).not.toMatch(/decided_by = VALUES/);
    expect(params).toHaveLength(26);
    expect(params.slice(1, 13)).toEqual(['INC-1', 'confluence_space', 'SP0', JSON.stringify(route(0).spec), 'Signal stopped at Platform', 11, 12, '["sig-1"]', 11.04, 'proposed', 1, null]);
    expect(await repo.upsertRoutes([])).toBe(0);
  });

  it('listRoutes orders by rank, maps decimals and never reads decided_by', async () => {
    sql.query.mockResolvedValueOnce([
      { id: 'ro1', origin_incident_key: 'INC-1', source_type: 'jira_project', source_key: 'PAY', spec_json: '{"keywords":[],"target":{"teamId":"t","action":"mention"}}', reason: 'r', estimated_days_saved: '11.0', max_days_before: 12, signal_ids: '["s"]', score: '11.00', status: 'active', rank_no: 1, activated_at: '2026-11-03 10:00:00', created_at: '2026-11-03 09:00:00', updated_at: '2026-11-03 10:00:00' },
    ]);
    const rows = await repo.listRoutes('INC-1');
    const statement = queryCalls()[0]![0];
    expect(statement).toMatch(/WHERE origin_incident_key = \? ORDER BY rank_no ASC, id ASC LIMIT 50$/);
    expect(statement).not.toContain('decided_by');
    expect(rows[0]).toMatchObject({ estimatedDaysSaved: 11, score: 11, status: 'active', signalIds: ['s'], activatedAt: '2026-11-03T10:00:00.000Z' });
    expect(rows[0]).not.toHaveProperty('decidedBy');
  });

  it('decideRoute is a compare-and-set that records the decider and activation time', async () => {
    await repo.decideRoute('ro1', 'proposed', 'active', 'acc-1');
    await repo.decideRoute('ro1', 'active', 'dismissed', 'acc-1');
    expect(executeCalls()[0]).toEqual(['UPDATE routes SET status = ?, decided_by = ?, activated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?', 'active', 'acc-1', 'ro1', 'proposed']);
    expect(executeCalls()[1]![0]).toContain('activated_at = NULL');
  });
});

describe('deleteProposedRoutes', () => {
  it('deletes only proposed routes of the incident, by id', async () => {
    await repo.deleteProposedRoutes('INC-1', ['a', 'b']);
    expect(executeCalls()[0]).toEqual(["DELETE FROM routes WHERE origin_incident_key = ? AND status = 'proposed' AND id IN (?, ?)", 'INC-1', 'a', 'b']);
    expect(await repo.deleteProposedRoutes('INC-1', [])).toBe(0);
  });
});
