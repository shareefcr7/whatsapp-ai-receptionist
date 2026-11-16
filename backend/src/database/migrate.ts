import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closePool, requirePool } from './pool.ts';

// Same relative depth from src/database and dist/database.
const MIGRATIONS_DIR = join(import.meta.dirname, '../../../database/migrations');
const LOCK_ID = 727274; // arbitrary, shared by every migrate run

/** Applies unapplied database/migrations/*.sql in name order, each in its own transaction. */
export async function migrate(): Promise<string[]> {
  const client = await requirePool().connect();
  const applied: string[] = [];
  let reusable = true;
  try {
    // No statement timeout for this dedicated connection: a migration, or waiting for another deploy's migrate to
    // finish (the advisory lock below), can legitimately outlast DB_STATEMENT_TIMEOUT_MS. Reset before release.
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
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
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    // Back to the connection's startup value, so the pool never hands out a connection without the timeout.
    await client.query('RESET statement_timeout').catch(() => (reusable = false));
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
