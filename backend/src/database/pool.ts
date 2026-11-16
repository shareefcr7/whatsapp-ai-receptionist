import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
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
      // Sent as a startup parameter when each connection opens: no session SET that could linger in the pool.
      statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    })
  : null;

// Without a listener, an idle client dropping its connection crashes the process.
pool?.on('error', (err) => console.error('Idle database client error:', err.message));

// pg-pool removes its own error listener while a client is checked out, so a connection dropped mid-request (e.g. a
// database restart during a WhatsApp send, which holds a connection for up to ~46s) would emit an unhandled 'error'
// and crash the process. This listener stays for the client's life. The failed query still rejects, and pg-pool
// discards a broken client when it is released (it checks the client is still queryable).
pool?.on('connect', (client) => {
  client.on('error', (err: Error & { code?: string }) => console.error(`Database connection error: ${err.code ?? 'connection lost'}`));
});

export function requirePool(): pg.Pool {
  if (!pool) throw new AppError(503, 'DATABASE_NOT_CONFIGURED', 'DATABASE_URL is not set.');
  return pool;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await requirePool().query<T>(text, params)).rows;
}

/** One transaction on a connection the caller already holds (e.g. one that also holds a session lock). */
export async function transaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await requirePool().connect();
  try {
    return await transaction(client, () => fn(client));
  } finally {
    client.release();
  }
}

/** Runs at most `max` tasks at once; the rest wait in order, holding nothing. */
export function concurrencyLimit(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next(); // hand the slot straight on
      else active--;
    }
  };
}

/**
 * A WhatsApp send holds a pool connection (and the conversation lock) for up to ~15s per attempt, so a slow Meta could
 * otherwise drain all 10 connections. Every send (AI and staff) takes a slot first, before a connection.
 * ponytail: per process; N server instances allow N×3 sends. Moving sends out of the transaction removes the need.
 */
export const MAX_CONCURRENT_SENDS = 3;
export const withSendSlot = concurrencyLimit(MAX_CONCURRENT_SENDS);

export async function closePool(): Promise<void> {
  await pool?.end();
}
