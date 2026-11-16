// Regression tests for the test-database hygiene helper (test/helpers/db-hygiene.ts): recovery after interrupted
// runs and ordinary failures. Needs TEST_DATABASE_URL (a DISPOSABLE database). No Meta or OpenAI calls.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertDisposableDatabaseUrl, HYGIENE_FIXTURES, isDatabaseVerified } from './helpers/db-hygiene.ts';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
assertDisposableDatabaseUrl(testDatabaseUrl); // before any hook: after() hooks still run if before() fails
Object.assign(process.env, {
  // Deliberately NOT receptionist-test: the only session tagged as a test session here is the one planted below.
  PGAPPNAME: 'receptionist-hygiene-check',
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl ?? '',
});

const { default: pg } = await import('pg');
const { closePool, pool } = await import('../src/database/pool.ts');
const { migrate } = await import('../src/database/migrate.ts');
const { assertDisposableDatabase, effectiveDatabaseName, prepareTestDatabase, TEST_APP_NAME, withTemporaryTrigger } = await import('./helpers/db-hygiene.ts');
const { parse: pgParse } = await import('pg-connection-string');

const q = async (sql: string, params: unknown[] = []) => (await pool!.query(sql, params)).rows;
const tempObjects = async () =>
  (await q(`SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'test\\_%'
            UNION ALL SELECT proname FROM pg_proc WHERE proname LIKE 'test\\_%' ORDER BY 1`)).map((r) => r.name);
// Outside the test namespaces (not +1555000NNNN, not @example.test): must survive every cleanup.
// Named in the helper, so any file's start-of-run cleanup removes them if this file is interrupted.
const KEEP_PHONE = HYGIENE_FIXTURES.phone;
const KEEP_EMAIL = HYGIENE_FIXTURES.ownerEmail;
/** A test account that non-test data refers to: must be kept (and reported), never block the cleanup. */
const REFERENCED_TEST_EMAIL = HYGIENE_FIXTURES.referencedTestEmail;
/** Inside these tests the fixtures are what is being checked, so the cleanup under test must leave them alone. */
const KEEP_FIXTURES = { keepHygieneFixtures: true };

before(async () => {
  if (!testDatabaseUrl) return;
  await prepareTestDatabase(pool!);
  await migrate();
  await removeOwnRows(); // the shared purge deliberately keeps these, so an interrupted run of this file is cleaned here
});
after(async () => {
  // Only once the server confirmed a _test database: after() still runs when before() failed that check.
  try {
    if (testDatabaseUrl && isDatabaseVerified()) await removeOwnRows();
  } finally {
    await closePool(); // also when the clean-up fails, so the run cannot hang on open connections
  }
});

/** This file's own non-test rows (some with audit history), removed with the documented maintenance procedure. */
async function removeOwnRows() {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL receptionist.audit_maintenance = 'on'`);
    await c.query(`DELETE FROM conversation_events WHERE conversation_id IN (SELECT cv.id FROM conversations cv JOIN customers cu ON cu.id = cv.customer_id WHERE cu.phone_number = $1)`, [KEEP_PHONE]);
    await c.query(`DELETE FROM customers WHERE phone_number = $1`, [KEEP_PHONE]);
    await c.query(`DELETE FROM staff_users WHERE email IN ($1, $2)`, [KEEP_EMAIL, REFERENCED_TEST_EMAIL]);
    await c.query(`DELETE FROM usage_logs WHERE operation = 'hygiene-probe'`);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

describe('database URL guard: checks the database pg will actually connect to', () => {
  const ok = [
    ['postgresql://test@127.0.0.1:54329/receptionist_test', 'receptionist_test'],
    ['postgres://u:p@db.example.invalid/receptionist_test?sslmode=require', 'receptionist_test'],
    // The guard parses socket: URLs (database from ?db=) so it can refuse unsafe ones; the app itself only
    // accepts postgres:// and postgresql:// (src/config/env.ts), so a real test run never uses one.
    ['socket:/var/run/postgresql?db=receptionist_test', 'receptionist_test'],
    ['postgresql://h/receptionist_test?database=prod', 'receptionist_test'], // pg ignores ?database= on a normal URL
  ] as const;
  const refused: [string, RegExp][] = [
    ['socket:/var/run/x_test?db=prod', /database "prod"/], // the confirmed bypass: path ends in _test, ?db= selects prod
    ['socket:/var/run/postgresql_test', /names no database/], // no ?db=: pg would fall back to PGDATABASE or the user name
    ['postgresql://h/prod?db=receptionist_test', /database "prod"/],
    ['postgresql://h/receptionist_test_old', /database "receptionist_test_old"/],
    ['postgresql://h', /names no database/],
    ['postgresql://h/', /names no database/],
    ['/var/run/postgresql receptionist_test', /must be a postgres/], // pg's bare-socket form: refused (fail closed)
    ['not a url_test', /must be a postgres/], // pg would resolve this against a dummy base URL
    ['mysql://h/receptionist_test', /must be a postgres/],
    ['', /must be a postgres/],
  ];

  it('accepts a database name ending in _test, read exactly as pg reads it', () => {
    for (const [url, name] of ok) {
      assert.equal(effectiveDatabaseName(url), name, url);
      assert.equal(pgParse(url).database, name, `pg agrees for ${url}`);
      assert.doesNotThrow(() => assertDisposableDatabaseUrl(url), url);
    }
  });

  it('refuses any other effective database, and malformed or ambiguous URLs (fail closed)', () => {
    for (const [url, why] of refused) {
      assert.throws(() => (url === '' ? effectiveDatabaseName(url) : assertDisposableDatabaseUrl(url)), why, url);
    }
    assert.doesNotThrow(() => assertDisposableDatabaseUrl(undefined)); // no URL: no database tests at all
  });
});

describe('disposable-database guard', () => {
  it('accepts only database names ending in _test', () => {
    assert.doesNotThrow(() => assertDisposableDatabase('receptionist_test'));
    for (const name of ['receptionist', 'postgres', 'receptionist_test_old', 'test', 'receptionist-test', 'prod_test_db']) {
      assert.throws(() => assertDisposableDatabase(name), /Refusing to run destructive tests/, name);
    }
  });
});

describe('test database hygiene (database)', { skip: !testDatabaseUrl }, () => {
  it('a temporary trigger is removed even when the test using it fails', async () => {
    const fault = { name: 'test_fault', table: 'usage_logs', timing: 'BEFORE INSERT', body: `RAISE EXCEPTION 'simulated fault';` };
    await assert.rejects(
      withTemporaryTrigger(pool!, fault, async () => {
        assert.deepEqual(await tempObjects(), ['test_fault', 'test_fault']); // trigger and function, while running
        throw new Error('an assertion failed inside the test');
      }),
      /an assertion failed inside the test/,
    );
    assert.deepEqual(await tempObjects(), []);
    await q(`INSERT INTO usage_logs (provider, operation) VALUES ('whatsapp', 'hygiene-probe')`); // writes work again
    await q(`DELETE FROM usage_logs WHERE operation = 'hygiene-probe'`);
  });

  it('a temporary trigger left by an interrupted run does not break the next use of that name', async () => {
    // Exactly what a killed run leaves: a plain CREATE, never dropped.
    await q(`CREATE FUNCTION test_block_events() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'leftover'; END; $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER test_block_events BEFORE INSERT ON conversation_events FOR EACH ROW EXECUTE FUNCTION test_block_events()`);
    const block = { name: 'test_block_events', table: 'conversation_events', timing: 'BEFORE INSERT', body: `RAISE EXCEPTION 'audit unavailable';` };
    await withTemporaryTrigger(pool!, block, async () => {});
    assert.deepEqual(await tempObjects(), []);
  });

  it('refuses a trigger name the hygiene check could not find later', async () => {
    await assert.rejects(withTemporaryTrigger(pool!, { name: 'fault', table: 'usage_logs', timing: 'BEFORE INSERT', body: '' }, async () => {}), /test_/);
  });

  it('after a simulated interruption, removes leftover objects, rows and sessions; reports them; keeps everything else', async (t: TestContext) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => void warnings.push(args.map(String).join(' ')));
    t.mock.method(console, 'error', () => {}); // the pool's connection-error listener, if it sees the ended session

    // 1. Leftover temporary triggers from killed tests.
    await q(`CREATE FUNCTION test_slow_usage() RETURNS trigger AS $$ BEGIN IF NEW.provider = 'whatsapp' THEN PERFORM pg_sleep(6); END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER test_slow_usage BEFORE INSERT ON usage_logs FOR EACH ROW EXECUTE FUNCTION test_slow_usage()`);
    await q(`CREATE FUNCTION test_fault() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER test_fault BEFORE INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION test_fault()`);
    // 2. Leftover test rows, including audit history (which ordinary deletes refuse) and a staff member with history.
    const [{ id: staffId }] = await q(`INSERT INTO staff_users (email, full_name) VALUES ('leftover@example.test', 'Leftover') RETURNING id`);
    const [{ id: customerId }] = await q(`INSERT INTO customers (phone_number) VALUES ('+15550009901') RETURNING id`);
    const [{ id: cid }] = await q(`INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`, [customerId]);
    const [{ id: mid }] = await q(
      `INSERT INTO messages (conversation_id, direction, sender_type, content, status, staff_id) VALUES ($1, 'outbound', 'staff', 'x', 'queued', $2) RETURNING id`,
      [cid, staffId],
    );
    await q(`INSERT INTO conversation_events (conversation_id, staff_id, action, message_id) VALUES ($1, $2, 'staff_reply', $3)`, [cid, staffId, mid]);
    await q(`INSERT INTO usage_logs (provider, operation, conversation_id) VALUES ('openai', 'chat_completion', $1)`, [cid]);
    // 3. Rows outside the test namespaces.
    await q(`INSERT INTO customers (phone_number) VALUES ($1) ON CONFLICT DO NOTHING`, [KEEP_PHONE]);
    await q(`INSERT INTO staff_users (email, full_name) VALUES ($1, 'Owner') ON CONFLICT DO NOTHING`, [KEEP_EMAIL]);
    // 4. A session from the killed run, still holding a conversation lock.
    const stale = new pg.Client({ connectionString: testDatabaseUrl, application_name: TEST_APP_NAME });
    stale.on('error', () => {}); // it is about to be ended from the server side
    t.after(() => stale.end().catch(() => {})); // closed even if an assertion below fails
    await stale.connect();
    await stale.query('SELECT pg_advisory_lock(1, hashtext($1))', [cid]);

    const report = await prepareTestDatabase(pool!, { staleBefore: new Date(Date.now() + 60_000), ...KEEP_FIXTURES });

    assert.ok(report.includes('1 stale test session(s) ended'), report.join('; '));
    for (const expected of ['trigger test_slow_usage on usage_logs', 'trigger test_fault on messages', 'function test_slow_usage()', 'function test_fault()', '1 audit event(s)', '1 usage row(s)', '1 test customer(s)']) {
      assert.ok(report.includes(expected), `${expected} — got: ${report.join('; ')}`);
    }
    assert.ok(report.some((r) => /test staff account/.test(r)), report.join('; '));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^Test database hygiene: cleaned up after an earlier run: /);

    assert.deepEqual(await tempObjects(), []);
    assert.equal((await q(`SELECT count(*)::int AS n FROM customers WHERE phone_number LIKE '+1555000%'`))[0].n, 0);
    // (REFERENCED_TEST_EMAIL is the one test account the cleanup deliberately keeps: see the next test.)
    assert.equal((await q(`SELECT count(*)::int AS n FROM staff_users WHERE email LIKE '%@example.test' AND email <> $1`, [REFERENCED_TEST_EMAIL]))[0].n, 0);
    assert.equal((await q(`SELECT count(*)::int AS n FROM customers WHERE phone_number = $1`, [KEEP_PHONE]))[0].n, 1, 'non-test customer kept');
    assert.equal((await q(`SELECT count(*)::int AS n FROM staff_users WHERE email = $1`, [KEEP_EMAIL]))[0].n, 1, 'non-test staff kept');
    // The stale session is gone, and with it the conversation lock it held.
    const [{ got }] = await q('SELECT pg_try_advisory_lock(1, hashtext($1)) AS got', [cid]);
    assert.equal(got, true);
    await q('SELECT pg_advisory_unlock(1, hashtext($1))', [cid]);
    await assert.rejects(stale.query('SELECT 1'));
    await stale.end().catch(() => {});

    // The real audit protection is untouched, and the maintenance bypass did not outlive its transaction.
    const triggers = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'conversation_events'::regclass AND NOT tgisinternal ORDER BY tgname`)).map((r) => r.tgname);
    assert.deepEqual(triggers, ['conversation_events_no_delete', 'conversation_events_no_truncate', 'conversation_events_no_update']);
    const fks = (await q(`SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'conversation_events'::regclass AND contype = 'f' ORDER BY conname`)).map((r) => `${r.conname}=${r.confdeltype}`);
    assert.deepEqual(fks, ['conversation_events_conversation_id_fkey=r', 'conversation_events_message_id_fkey=r', 'conversation_events_staff_id_fkey=a']);
    const flags = await Promise.all(Array.from({ length: 5 }, () => q(`SELECT coalesce(current_setting('receptionist.audit_maintenance', true), '') AS f`)));
    for (const [row] of flags) assert.notEqual(row.f, 'on');

    // Idempotent: a second run finds nothing and says nothing.
    assert.deepEqual(await prepareTestDatabase(pool!, { staleBefore: new Date(Date.now() + 60_000), ...KEEP_FIXTURES }), []);
    assert.equal(warnings.length, 1);
  });

  it('a test staff account referenced by non-test data is kept and reported; non-test audit history is untouched', async (t: TestContext) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => void warnings.push(args.map(String).join(' ')));
    const [{ id: staffId }] = await q(`INSERT INTO staff_users (email, full_name) VALUES ($1, 'Referenced') RETURNING id`, [REFERENCED_TEST_EMAIL]);
    const [{ id: customerId }] = await q(`INSERT INTO customers (phone_number) VALUES ($1) ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number RETURNING id`, [KEEP_PHONE]);
    const [{ id: cid }] = await q(`INSERT INTO conversations (customer_id, status) VALUES ($1, 'closed') RETURNING id`, [customerId]);
    const [{ id: mid }] = await q(
      `INSERT INTO messages (conversation_id, direction, sender_type, content, status, staff_id) VALUES ($1, 'outbound', 'staff', 'x', 'sent', $2) RETURNING id`,
      [cid, staffId],
    );
    await q(`INSERT INTO conversation_events (conversation_id, staff_id, action, message_id) VALUES ($1, $2, 'staff_reply', $3)`, [cid, staffId, mid]);

    const report = await prepareTestDatabase(pool!, KEEP_FIXTURES); // must not throw, nor touch the non-test conversation
    assert.deepEqual(report, [`kept 1 test staff account(s) still referenced by non-test data: ${REFERENCED_TEST_EMAIL}`]);
    assert.equal(warnings.length, 1);
    assert.equal((await q(`SELECT count(*)::int AS n FROM conversation_events WHERE conversation_id = $1`, [cid]))[0].n, 1, 'non-test audit event kept');
    assert.equal((await q(`SELECT count(*)::int AS n FROM messages WHERE id = $1`, [mid]))[0].n, 1, 'non-test message kept');
    assert.equal((await q(`SELECT count(*)::int AS n FROM staff_users WHERE id = $1`, [staffId]))[0].n, 1, 'referenced test staff kept');
  });

  it("any file's start-of-run cleanup removes this file's own fixtures if it was interrupted (they would break api.test)", async (t: TestContext) => {
    t.mock.method(console, 'warn', () => {});
    // What an interrupted run of this file leaves: the fixtures, one with audit history, never cleaned by after().
    // (The earlier tests may already have created some of them: insert if missing, then look the ids up.)
    await q(`INSERT INTO staff_users (email, full_name) VALUES ($1, 'Referenced') ON CONFLICT DO NOTHING`, [REFERENCED_TEST_EMAIL]);
    await q(`INSERT INTO staff_users (email, full_name) VALUES ($1, 'Owner') ON CONFLICT DO NOTHING`, [KEEP_EMAIL]);
    const [{ id: staffId }] = await q(`SELECT id FROM staff_users WHERE email = $1`, [REFERENCED_TEST_EMAIL]);
    const [{ id: customerId }] = await q(`INSERT INTO customers (phone_number) VALUES ($1) ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number RETURNING id`, [KEEP_PHONE]);
    const [{ id: cid }] = await q(`INSERT INTO conversations (customer_id, status) VALUES ($1, 'closed') RETURNING id`, [customerId]);
    const [{ id: mid }] = await q(`INSERT INTO messages (conversation_id, direction, sender_type, content, status, staff_id) VALUES ($1, 'outbound', 'staff', 'x', 'sent', $2) RETURNING id`, [cid, staffId]);
    await q(`INSERT INTO conversation_events (conversation_id, staff_id, action, message_id) VALUES ($1, $2, 'staff_reply', $3)`, [cid, staffId, mid]);

    const report = await prepareTestDatabase(pool!); // the default, as every file's before() calls it
    assert.ok(report.includes('3 db-hygiene.test.ts fixture row(s)'), report.join('; '));
    assert.equal((await q(`SELECT count(*)::int AS n FROM customers WHERE phone_number = $1`, [KEEP_PHONE]))[0].n, 0);
    assert.equal((await q(`SELECT count(*)::int AS n FROM staff_users WHERE email IN ($1, $2)`, [KEEP_EMAIL, REFERENCED_TEST_EMAIL]))[0].n, 0);
    assert.equal((await q(`SELECT count(*)::int AS n FROM conversations WHERE id = $1`, [cid]))[0].n, 0);
  });

  it('a non-_test database is refused before any hook runs: after() clean-ups never reach it', async (t: TestContext) => {
    // A database whose name does not end in _test, holding canary rows in tables that test after() hooks delete from.
    const guardDb = 'receptionist_guardcheck';
    const guardUrl = new URL(testDatabaseUrl!);
    guardUrl.pathname = `/${guardDb}`;
    try {
      await q(`DROP DATABASE IF EXISTS ${guardDb} WITH (FORCE)`);
      await q(`CREATE DATABASE ${guardDb}`);
    } catch (err) {
      t.skip(`cannot create a database to check against (${(err as { code?: string }).code ?? 'error'})`);
      return;
    }
    const canary = new pg.Client({ connectionString: guardUrl.toString() });
    try {
      await canary.connect();
      await canary.query(`CREATE TABLE webhook_events (source text); INSERT INTO webhook_events VALUES ('whatsapp');
                          CREATE TABLE google_calendar_connection (id int); INSERT INTO google_calendar_connection VALUES (1);`);
      const { spawnSync } = await import('node:child_process');
      // Without NODE_TEST_CONTEXT: inherited, it makes the nested `node --test` act as this runner's sub-process
      // (exit status 0, serialized output) instead of a real, independent run.
      const { NODE_TEST_CONTEXT: _, ...childEnv } = process.env;
      for (const file of ['test/whatsapp.test.ts', 'test/calendar.test.ts']) {
        const run = spawnSync(process.execPath, ['--test', '--test-force-exit', file], {
          cwd: fileURLToPath(new URL('..', import.meta.url)), // decoded: works with spaces in the checkout path
          env: { ...childEnv, TEST_DATABASE_URL: guardUrl.toString() },
          encoding: 'utf8',
          timeout: 60_000,
        });
        assert.notEqual(run.status, 0, `${file} must fail`);
        assert.match(run.stdout + run.stderr, /Refusing to run destructive tests against database "receptionist_guardcheck"/, file);
      }
      const { rows: [counts] } = await canary.query(`SELECT (SELECT count(*)::int FROM webhook_events) AS w, (SELECT count(*)::int FROM google_calendar_connection) AS g`);
      assert.deepEqual(counts, { w: 1, g: 1 }, 'canary rows untouched');
    } finally {
      await canary.end().catch(() => {});
      await q(`DROP DATABASE IF EXISTS ${guardDb} WITH (FORCE)`);
    }
  });

  it('a pooler alias or socket: URL that reaches a non-_test database causes zero destructive SQL, also in after()', async (t: TestContext) => {
    // The real database is receptionist_guardcheck (not _test). A tiny proxy rewrites the database name in each
    // connection's startup message, as a pooler alias would: the URL says receptionist_alias_test (passes the URL
    // check), the server is receptionist_guardcheck. before() then fails its server-side check, and after() runs.
    const guardDb = 'receptionist_guardcheck';
    const alias = 'receptionist_alias_test';
    const real = new URL(testDatabaseUrl!);
    try {
      await q(`DROP DATABASE IF EXISTS ${guardDb} WITH (FORCE)`);
      await q(`CREATE DATABASE ${guardDb}`);
    } catch (err) {
      t.skip(`cannot create a database to check against (${(err as { code?: string }).code ?? 'error'})`);
      return;
    }
    const { createServer, connect } = await import('node:net');
    const proxy = createServer((client) => {
      client.on('error', () => {});
      client.once('data', (first) => {
        const length = first.readInt32BE(0);
        const fields = first.subarray(8, length - 1).toString('utf8').split('\0'); // key, value, ..., ''
        for (let i = 0; i < fields.length - 1; i += 2) if (fields[i] === 'database' && fields[i + 1] === alias) fields[i + 1] = guardDb;
        const body = Buffer.from(`${fields.join('\0')}\0`, 'utf8');
        const header = Buffer.alloc(8);
        header.writeInt32BE(8 + body.length, 0);
        header.writeInt32BE(first.readInt32BE(4), 4); // protocol version
        const upstream = connect(Number(real.port || 5432), real.hostname, () => {
          upstream.write(Buffer.concat([header, body, first.subarray(length)]));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    const aliasUrl = new URL(testDatabaseUrl!);
    aliasUrl.host = `127.0.0.1:${proxyPort}`;
    aliasUrl.pathname = `/${alias}`;

    const guardUrl = new URL(testDatabaseUrl!);
    guardUrl.pathname = `/${guardDb}`;
    const canary = new pg.Client({ connectionString: guardUrl.toString() });
    // A session tagged as a test session, older than the child runs: a cleanup that ran would end it.
    const session = new pg.Client({ connectionString: guardUrl.toString(), application_name: TEST_APP_NAME });
    session.on('error', () => {});
    // Proof the proxy really is an alias. Closed in finally: an open connection would keep proxy.close() waiting.
    const viaAlias = new pg.Client({ connectionString: aliasUrl.toString() });
    viaAlias.on('error', () => {});
    try {
      await canary.connect();
      await session.connect();
      // Every object a destructive cleanup would touch: rows the after() hooks delete, and a test_* trigger it drops.
      await canary.query(`
        CREATE TABLE webhook_events (source text); INSERT INTO webhook_events VALUES ('whatsapp');
        CREATE TABLE customers (phone_number text); INSERT INTO customers VALUES ('+15550001001');
        CREATE TABLE google_calendar_connection (id int); INSERT INTO google_calendar_connection VALUES (1);
        CREATE TABLE staff_users (email text); INSERT INTO staff_users VALUES ('cal-admin@example.test'), ('admin@example.test');
        CREATE FUNCTION test_canary() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER test_canary BEFORE INSERT ON webhook_events FOR EACH ROW EXECUTE FUNCTION test_canary();`);
      // Through the proxy, the server reports the non-_test database.
      await viaAlias.connect();
      assert.equal((await viaAlias.query('SELECT pg_catalog.current_database() AS db')).rows[0].db, guardDb);
      await viaAlias.end();

      const { execFile } = await import('node:child_process');
      const { NODE_TEST_CONTEXT: _, ...childEnv } = process.env; // a real, independent run (see the test above)
      const runFile = (file: string, url: string) =>
        new Promise<{ code: number; output: string }>((resolve) => {
          execFile(process.execPath, ['--test', '--test-force-exit', file], {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            env: { ...childEnv, TEST_DATABASE_URL: url },
            timeout: 60_000,
          }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, output: `${stdout}${stderr}` }));
        });
      const socketBypass = `socket:/tmp/x_test?db=${guardDb}`; // the confirmed bypass of the old pathname check
      for (const file of ['test/whatsapp.test.ts', 'test/calendar.test.ts', 'test/api.test.ts']) {
        const viaPooler = await runFile(file, aliasUrl.toString());
        assert.notEqual(viaPooler.code, 0, `${file} via alias must fail`);
        assert.match(viaPooler.output, /Refusing to run destructive tests against database "receptionist_guardcheck"/, `${file} via alias`);
        const viaSocket = await runFile(file, socketBypass);
        assert.notEqual(viaSocket.code, 0, `${file} via socket: must fail`);
        assert.match(viaSocket.output, /Refusing to run destructive tests against database "receptionist_guardcheck"/, `${file} via socket:`);
      }

      const { rows: [left] } = await canary.query(`SELECT
        (SELECT count(*)::int FROM webhook_events) AS events, (SELECT count(*)::int FROM customers) AS customers,
        (SELECT count(*)::int FROM google_calendar_connection) AS calendar, (SELECT count(*)::int FROM staff_users) AS staff,
        (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'test_canary') AS trigger,
        (SELECT count(*)::int FROM pg_proc WHERE proname = 'test_canary') AS function,
        (SELECT count(*)::int FROM pg_tables WHERE tablename = 'schema_migrations') AS migrations`);
      // ...and no migration either (api.test.ts runs migrate() in a nested describe's before()).
      assert.deepEqual(left, { events: 1, customers: 1, calendar: 1, staff: 2, trigger: 1, function: 1, migrations: 0 }, 'no DELETE, DROP or migration');
      assert.equal((await session.query('SELECT 1 AS alive')).rows[0].alive, 1, 'no session was terminated');
    } finally {
      await viaAlias.end().catch(() => {}); // before proxy.close(), which waits for every proxied connection
      await canary.end().catch(() => {});
      await session.end().catch(() => {});
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await q(`DROP DATABASE IF EXISTS ${guardDb} WITH (FORCE)`);
    }
  });
});
