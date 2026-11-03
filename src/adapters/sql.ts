import { Queue } from '@forge/events';
import { migrationRunner, sql } from '@forge/sql';
import { MIGRATIONS } from '../core/migrations';
import { isSqlRateLimited, migrateWithPacing, schemaGuard, schemaStatus, type MigrationResult, type MigrationStore } from '../core/schema';

export const MIGRATE_QUEUE = 'schema-migrate';
const migrateQueue = new Queue({ key: MIGRATE_QUEUE });

/** Forge SQL migration history (the `__migrations` table of `@forge/sql`'s `migrationRunner`). Reads use the DML endpoint. */
const store: MigrationStore = {
  async applied() {
    try {
      const result = await sql.prepare<{ name: string }>('SELECT name FROM __migrations').execute();
      return (result.rows as { name: string }[]).map((r) => r.name);
    } catch (err) {
      // A new install has no history table yet; the migration run creates it.
      if (isSqlRateLimited(err)) throw err;
      return undefined;
    }
  },
  createHistory: () => migrationRunner.initialize(),
  ddl: async (statement) => {
    await sql.executeDDL(statement);
  },
  record: async (name) => {
    await sql.prepare('INSERT INTO __migrations (name) VALUES (?)').bindParams(name).execute();
  },
};

/**
 * Queues a migration run on the `schema-migrate` consumer (the only place that runs DDL). `extra` travels in the
 * event body, e.g. a connector change that has to be saved once the schema exists.
 */
export async function requestMigration(reason: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { jobId } = await migrateQueue.push({ body: { ...extra, reason } });
  return jobId;
}

/** Applies pending migrations, waiting out the DDL rate limit, for up to `budgetMs`. Only for the `schema-migrate` consumer. */
export function runMigrations(budgetMs: number): Promise<MigrationResult> {
  return migrateWithPacing(store, MIGRATIONS, {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    deadline: Date.now() + budgetMs,
  });
}

/**
 * Call before any code that touches SQL. Never runs DDL: while migrations are pending it queues a migration run and
 * throws `SchemaSettingUpError` (callers show "setting up" or retry later).
 */
export const ensureSchema = schemaGuard(() => schemaStatus(store, MIGRATIONS), () => requestMigration('pending'));

/** Parameterised SELECT; never interpolate values into `statement`. */
export async function query<Row>(statement: string, ...params: unknown[]): Promise<Row[]> {
  const result = await sql.prepare<Row>(statement).bindParams(...params).execute();
  return result.rows as Row[];
}

/** Parameterised INSERT/UPDATE/DELETE; returns the number of affected rows. */
export async function execute(statement: string, ...params: unknown[]): Promise<number> {
  const result = await sql.prepare<{ affectedRows: number }>(statement).bindParams(...params).execute();
  const rows = result.rows as unknown as { affectedRows?: number };
  return rows.affectedRows ?? 0;
}
