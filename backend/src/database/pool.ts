import pg from 'pg';
import type { QueryResultRow } from 'pg';
import { env } from '../config/env.ts';
import { AppError } from '../types/errors.ts';

export const isDatabaseConfigured = Boolean(env.DATABASE_URL);

export const pool = env.DATABASE_URL
  ? new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    })
  : null;

// Without a listener, an idle client dropping its connection crashes the process.
pool?.on('error', (err) => console.error('Idle database client error:', err.message));

export function requirePool(): pg.Pool {
  if (!pool) throw new AppError(503, 'DATABASE_NOT_CONFIGURED', 'DATABASE_URL is not set.');
  return pool;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await requirePool().query<T>(text, params)).rows;
}

export async function closePool(): Promise<void> {
  await pool?.end();
}
