import pg from 'pg';
import type { QueryResultRow } from 'pg';
import { env } from '../config/env.ts';
import { AppError } from '../types/errors.ts';

export const isDatabaseConfigured = Boolean(env.DATABASE_URL);

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '[::1]']);

/**
 * TLS for the connection. An sslmode in the URL always wins (pg applies it over this option).
 * Otherwise a public hostname, such as Render's External URL, gets TLS with certificate verification;
 * localhost, sockets and single-label private hosts (Render's Internal URL, Docker service names) stay plain.
 */
export function sslFor(connectionString: string): boolean | undefined {
  const url = new URL(connectionString);
  if (url.searchParams.has('sslmode')) return undefined;
  const host = url.hostname.toLowerCase();
  return LOCAL_HOSTS.has(host) || !host.includes('.') ? undefined : true;
}

export const pool = env.DATABASE_URL
  ? new pg.Pool({
      connectionString: env.DATABASE_URL,
      ssl: sslFor(env.DATABASE_URL),
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
