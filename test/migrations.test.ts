import { describe, expect, it } from 'vitest';
import { LATEST_MIGRATION, MIGRATIONS } from '../src/core/migrations';

/** MySQL/TiDB reserved words that are plausible column names; they must be backticked if ever used. */
const RESERVED = new Set([
  'cursor',
  'rank',
  'window',
  'key',
  'keys',
  'version',
  'last_value',
  'first_value',
  'row_number',
  'range',
  'groups',
  'order',
  'group',
  'index',
  'read',
  'release',
  'condition',
  'interval',
  'lead',
  'lag',
  'over',
  'row',
  'rows',
  'function',
  'values',
  'desc',
  'match',
  'option',
  'usage',
]);

/** Column names (first token of each column definition line) of a CREATE TABLE statement. */
function columnNames(statement: string): string[] {
  const body = statement.slice(statement.indexOf('(') + 1, statement.lastIndexOf(')'));
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^(PRIMARY|UNIQUE|KEY|INDEX)\b/i.test(l))
    .map((l) => l.split(/\s+/)[0]!);
}

describe('MIGRATIONS', () => {
  it('has the eight week-2 tables, v001–v008, unique names in order', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'v001_create_settings',
      'v002_create_app_locks',
      'v003_create_graph_connection',
      'v004_create_service_mappings',
      'v005_create_incidents',
      'v006_create_events',
      'v007_create_analysis_jobs',
      'v008_create_signal_candidates',
    ]);
    expect(LATEST_MIGRATION).toBe('v008_create_signal_candidates');
  });

  it.each(MIGRATIONS.map((m) => [m.name, m.statement]))('%s is a single idempotent statement without foreign keys', (_name, statement) => {
    expect(statement).toMatch(/^(CREATE TABLE|ALTER TABLE \S+ ADD (COLUMN|INDEX)) IF NOT EXISTS /);
    expect(statement).not.toContain(';');
    expect(statement).not.toMatch(/FOREIGN KEY|REFERENCES/i);
  });

  it.each(MIGRATIONS.map((m) => [m.name, m.statement]))('%s has no unquoted reserved column names', (_name, statement) => {
    for (const column of columnNames(statement)) {
      if (column.startsWith('`')) continue;
      expect(RESERVED.has(column.toLowerCase()), `column ${column}`).toBe(false);
    }
  });

  it('events keeps scenario_at and the dedup key the collect upsert relies on', () => {
    const events = MIGRATIONS.find((m) => m.name === 'v006_create_events')!.statement;
    expect(events).toContain('scenario_at TIMESTAMP NULL');
    expect(events).toContain('UNIQUE KEY uq_events_ref (source, artifact_id, comment_id)');
  });
});
