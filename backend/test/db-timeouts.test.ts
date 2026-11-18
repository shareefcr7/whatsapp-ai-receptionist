// Database statement timeout (DB_STATEMENT_TIMEOUT_MS), at its 5s minimum so the tests stay short.
// Meta is mocked through fetch: no test contacts WhatsApp. Needs TEST_DATABASE_URL (a DISPOSABLE database).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { assertDisposableDatabaseUrl, isDatabaseVerified } from './helpers/db-hygiene.ts';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
assertDisposableDatabaseUrl(testDatabaseUrl); // before any hook: after() hooks still run if before() fails
Object.assign(process.env, {
  PGAPPNAME: 'receptionist-test', // tags this run's sessions; see test/helpers/db-hygiene.ts
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl ?? '',
  DB_STATEMENT_TIMEOUT_MS: '5000',
  WHATSAPP_ACCESS_TOKEN: 'EAAtest-access-token',
  WHATSAPP_PHONE_NUMBER_ID: '111111111111111',
});

const { parseEnv } = await import('../src/config/env.ts');
const { closePool, pool } = await import('../src/database/pool.ts');
const { migrate } = await import('../src/database/migrate.ts');
const { deliver, withConversationSend } = await import('../src/services/conversations/index.ts');
const { prepareTestDatabase, withTemporaryTrigger } = await import('./helpers/db-hygiene.ts');

const realFetch = globalThis.fetch;
let metaCalls = 0;
globalThis.fetch = (async (input: string | URL) => {
  if (new URL(String(input)).hostname !== 'graph.facebook.com') throw new Error('unexpected request');
  metaCalls++;
  return new Response(JSON.stringify({ messages: [{ id: `wamid.TIMEOUT.${metaCalls}` }] }), { status: 200 });
}) as typeof fetch;

const PHONE = '+15550004001';
const cleanup = async () => {
  // Self-healing if an earlier run was interrupted between creating and dropping its temporary trigger.
  await pool!.query(`DROP TRIGGER IF EXISTS test_slow_usage ON usage_logs`);
  await pool!.query(`DROP FUNCTION IF EXISTS test_slow_usage()`);
  await pool!.query(`DELETE FROM customers WHERE phone_number LIKE '+15550004%'`); // no audit history here
};

before(async () => {
  if (!testDatabaseUrl) return;
  await prepareTestDatabase(pool!); // refuses a non-_test database; recovers from an interrupted earlier run
  await migrate();
  await cleanup();
});
after(async () => {
  // Only once the server confirmed a _test database: after() still runs when before() failed that check.
  try {
    if (testDatabaseUrl && isDatabaseVerified()) await cleanup();
  } finally {
    globalThis.fetch = realFetch;
    await closePool(); // also when the clean-up fails, so the run cannot hang on open connections
  }
});

describe('DB_STATEMENT_TIMEOUT_MS setting', () => {
  it('defaults to 30s, and refuses values that are too small (at or below the 3s lock wait), too large or not numbers', () => {
    assert.equal(parseEnv({}).DB_STATEMENT_TIMEOUT_MS, 30_000);
    assert.equal(parseEnv({ DB_STATEMENT_TIMEOUT_MS: '' }).DB_STATEMENT_TIMEOUT_MS, 30_000);
    assert.equal(parseEnv({ DB_STATEMENT_TIMEOUT_MS: '5000' }).DB_STATEMENT_TIMEOUT_MS, 5_000);
    for (const bad of ['3000', '4999', '600001', 'abc', '5000.5']) {
      assert.throws(() => parseEnv({ DB_STATEMENT_TIMEOUT_MS: bad }), /DB_STATEMENT_TIMEOUT_MS/, bad);
    }
  });
});

describe('statement timeout (database)', { skip: !testDatabaseUrl }, () => {
  it('every pooled connection starts with the configured timeout, set at connect time (no session SET)', async () => {
    const clients = await Promise.all(Array.from({ length: 4 }, () => pool!.connect()));
    try {
      for (const c of clients) assert.equal((await c.query(`SELECT current_setting('statement_timeout') AS t`)).rows[0].t, '5s');
    } finally {
      for (const c of clients) c.release();
    }
  });

  it('a statement running past the limit is cancelled (57014), and the connection stays usable', async () => {
    const c = await pool!.connect();
    try {
      const started = Date.now();
      await assert.rejects(c.query('SELECT pg_sleep(6)'), (err: any) => err.code === '57014');
      const took = Date.now() - started;
      assert.ok(took >= 4500 && took < 6000, `cancelled after ${took}ms`);
      assert.equal((await c.query('SELECT 1 AS one')).rows[0].one, 1);
    } finally {
      c.release();
    }
  });

  it('a conversation lock wait still answers "busy" (its 3s limit fires first), not a statement timeout', async (t) => {
    t.mock.method(console, 'error', () => {});
    const id = crypto.randomUUID();
    const holder = await pool!.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(1, hashtext($1))', [id]);
      await assert.rejects(withConversationSend(id, async () => 'unreachable'), { code: 'CONVERSATION_BUSY' });
    } finally {
      await holder.query('SELECT pg_advisory_unlock(1, hashtext($1))', [id]);
      holder.release();
    }
  });

  it('migrate() is exempt: it waits past the limit for another migrate, then hands back connections with the timeout', async () => {
    // Another deploy's migrate holds the migration lock for longer than the statement timeout.
    const other = await pool!.connect();
    await other.query('SELECT pg_advisory_lock(727274)');
    const release = setTimeout(() => void other.query('SELECT pg_advisory_unlock(727274)'), 6_000);
    try {
      const started = Date.now();
      assert.deepEqual(await migrate(), []); // waited ~6s (beyond 5s) instead of failing with 57014
      assert.ok(Date.now() - started >= 5_500, `waited ${Date.now() - started}ms`);
    } finally {
      clearTimeout(release);
      await other.query('SELECT pg_advisory_unlock_all()');
      other.release();
    }
    // All 10 (the pool maximum), so the connection migrate() used is certainly among them.
    const clients = await Promise.all(Array.from({ length: 10 }, () => pool!.connect()));
    try {
      for (const c of clients) assert.equal((await c.query(`SELECT current_setting('statement_timeout') AS t`)).rows[0].t, '5s');
    } finally {
      for (const c of clients) c.release();
    }
  });

  it('a statement timeout after Meta accepted a message cannot cause a resend: still "sent", recorded as sent', async (t: TestContext) => {
    t.mock.method(console, 'error', () => {});
    const { rows: [{ id: customerId }] } = await pool!.query(`INSERT INTO customers (phone_number) VALUES ($1) RETURNING id`, [PHONE]);
    const { rows: [{ id: conversationId }] } = await pool!.query(`INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`, [customerId]);
    const { rows: [{ id: messageId }] } = await pool!.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, content, status) VALUES ($1, 'outbound', 'staff', 'hello', 'queued') RETURNING id`,
      [conversationId],
    );
    // Recording WhatsApp usage hangs past the limit, as a slow database would.
    const slowUsage = { name: 'test_slow_usage', table: 'usage_logs', timing: 'BEFORE INSERT', body: `IF NEW.provider = 'whatsapp' THEN PERFORM pg_sleep(6); END IF; RETURN NEW;` };
    await withTemporaryTrigger(pool!, slowUsage, async () => {
      const result = await withConversationSend(conversationId, (c) => deliver(c, { id: messageId, conversationId, phone: PHONE, text: 'hello' }));
      assert.equal(result.status, 'sent'); // not an error that would invite a resend
    });
    const { rows: [row] } = await pool!.query(`SELECT status, whatsapp_message_id FROM messages WHERE id = $1`, [messageId]);
    assert.deepEqual(row, { status: 'sent', whatsapp_message_id: 'wamid.TIMEOUT.1' });
    assert.equal(metaCalls, 1);
  });
});
