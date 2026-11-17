import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { closePool, requirePool } from './pool.ts';

// Same relative depth from src/database and dist/database.
const MIGRATIONS_DIR = join(import.meta.dirname, '../../../database/migrations');
export const LOCK_ID = 727274; // arbitrary, shared by every migrate run
/** How long to wait for another migrate run's lock before giving up with an actionable error. */
export const LOCK_WAIT = '10s';

const lockTimeoutError = (cause: unknown) =>
  new Error(
    `Could not start migrations: another migration run has held the migration lock for over ${LOCK_WAIT}. Nothing was changed. ` +
      `Wait for that run to finish and try again. If no migration is running, a stuck session holds the lock: find it with ` +
      `SELECT pid, application_name, backend_start FROM pg_locks JOIN pg_stat_activity USING (pid) ` +
      `WHERE locktype = 'advisory' AND objid = ${LOCK_ID}; and end it with SELECT pg_terminate_backend(<pid>);`,
    { cause },
  );

/** Applies unapplied database/migrations/*.sql in name order, each in its own transaction. */
export async function migrate(db: Pick<pg.Pool, 'connect'> = requirePool()): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  let reusable = true;
  let locked = false;
  try {
    // No statement timeout for this dedicated connection: a migration can legitimately outlast
    // DB_STATEMENT_TIMEOUT_MS. Reset before release.
    await client.query('SET statement_timeout = 0');
    // Bounded wait for another run's lock, so a stuck session cannot hang a deploy. Only for the lock: the migrations
    // themselves keep the previous behaviour (no lock timeout).
    await client.query(`SET lock_timeout = '${LOCK_WAIT}'`);
    try {
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    } catch (err) {
      if ((err as { code?: unknown }).code === '55P03') throw lockTimeoutError(err);
      throw err;
    }
    locked = true;
    await client.query('SET lock_timeout = 0');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => (reusable = false));
    // Back to the connection's startup values, so the pool never hands out a connection with these settings changed.
    // If a reset fails the connection's state is unknown, so it is destroyed instead of returned to the pool.
    await client.query('RESET statement_timeout').catch(() => (reusable = false));
    await client.query('RESET lock_timeout').catch(() => (reusable = false));
    client.release(!reusable);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const applied = await migrate();
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
