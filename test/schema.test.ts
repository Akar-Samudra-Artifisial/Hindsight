import { describe, expect, it, vi } from 'vitest';
import {
  applyMigrations,
  isSqlRateLimited,
  migrateWithPacing,
  schemaGuard,
  SchemaSettingUpError,
  type Migration,
  type MigrationStore,
} from '../src/core/schema';

const MIGS: Migration[] = [
  { name: 'v001', statement: 'CREATE TABLE IF NOT EXISTS a (id INT)' },
  { name: 'v002', statement: 'CREATE TABLE IF NOT EXISTS b (id INT)' },
  { name: 'v003', statement: 'CREATE TABLE IF NOT EXISTS c (id INT)' },
];

const rateLimit = () => Object.assign(new Error('Limits for the current installation have been exceeded'), { code: 'RATE_LIMIT_EXCEEDED' });

/** In-memory store; `failAfter` DDL calls throw the rate-limit error until `reset()`. */
function fakeStore(initial: string[] | undefined, failAfter = Infinity) {
  let history = initial ? [...initial] : undefined;
  let ddlCalls = 0;
  let limit = failAfter;
  const ddl: string[] = [];
  const store: MigrationStore = {
    applied: async () => (history ? [...history] : undefined),
    createHistory: async () => {
      history = history ?? [];
    },
    ddl: async (statement) => {
      if (ddlCalls >= limit) throw rateLimit();
      ddlCalls++;
      ddl.push(statement);
    },
    record: async (name) => {
      history = [...(history ?? []), name];
    },
  };
  return { store, ddl, reset: () => (limit = Infinity), history: () => history };
}

describe('isSqlRateLimited', () => {
  it('recognises code, status 429, message and wrapped causes', () => {
    expect(isSqlRateLimited({ code: 'RATE_LIMIT_EXCEEDED' })).toBe(true);
    expect(isSqlRateLimited({ responseDetails: { status: 429 } })).toBe(true);
    expect(isSqlRateLimited(new Error('x', { cause: rateLimit() }))).toBe(true);
    expect(isSqlRateLimited(new Error('syntax error'))).toBe(false);
    expect(isSqlRateLimited(undefined)).toBe(false);
  });
});

describe('applyMigrations', () => {
  it('creates the history on a new install and runs everything in order', async () => {
    const s = fakeStore(undefined);
    expect(await applyMigrations(s.store, MIGS)).toEqual(['v001', 'v002', 'v003']);
    expect(s.history()).toEqual(['v001', 'v002', 'v003']);
  });

  it('skips migrations already applied', async () => {
    const s = fakeStore(['v001', 'v002']);
    expect(await applyMigrations(s.store, MIGS)).toEqual(['v003']);
    expect(s.ddl).toEqual([MIGS[2]!.statement]);
  });

  it('turns the DDL rate limit into SchemaSettingUpError with progress', async () => {
    const s = fakeStore([], 1);
    const err = await applyMigrations(s.store, MIGS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaSettingUpError);
    expect(err).toMatchObject({ applied: 1, total: 3 });
  });

  it('rethrows other errors', async () => {
    const store: MigrationStore = {
      applied: async () => [],
      createHistory: async () => undefined,
      ddl: async () => {
        throw new Error('syntax error');
      },
      record: async () => undefined,
    };
    await expect(applyMigrations(store, MIGS)).rejects.toThrow('syntax error');
  });
});

describe('migrateWithPacing', () => {
  it('waits once on the rate limit, then finishes', async () => {
    const s = fakeStore([], 1);
    const sleep = vi.fn(async () => {
      s.reset();
    });
    const result = await migrateWithPacing(s.store, MIGS, { sleep, now: () => 0, deadline: 1_000_000, waitMs: 10 });
    expect(result).toEqual({ status: 'done', applied: 3, total: 3 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('stops at the deadline and reports pending', async () => {
    const s = fakeStore([], 2);
    const sleep = vi.fn(async () => undefined);
    const result = await migrateWithPacing(s.store, MIGS, { sleep, now: () => 1000, deadline: 1500, waitMs: 61_000 });
    expect(result).toEqual({ status: 'pending', applied: 2, total: 3 });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('schemaGuard', () => {
  it('never runs DDL: queues a migration (throttled) and throws while pending, then remembers ready', async () => {
    let applied = 1;
    let t = 0;
    const request = vi.fn(async () => 'job');
    const guard = schemaGuard(async () => ({ applied, total: 3 }), request, { now: () => t, requestEveryMs: 60_000 });
    await expect(guard()).rejects.toBeInstanceOf(SchemaSettingUpError);
    await expect(guard()).rejects.toMatchObject({ applied: 1, total: 3 });
    expect(request).toHaveBeenCalledTimes(1);
    t = 60_000;
    await expect(guard()).rejects.toBeInstanceOf(SchemaSettingUpError);
    expect(request).toHaveBeenCalledTimes(2);
    applied = 3;
    await expect(guard()).resolves.toBeUndefined();
    applied = 0;
    await expect(guard()).resolves.toBeUndefined();
  });

  it('still throws SchemaSettingUpError when queueing fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const guard = schemaGuard(async () => ({ applied: 0, total: 1 }), async () => {
      throw new Error('queue down');
    });
    await expect(guard()).rejects.toBeInstanceOf(SchemaSettingUpError);
    warn.mockRestore();
  });
});
