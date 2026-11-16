// Test-database hygiene, shared by every PostgreSQL test file. Not a test file itself (the glob is *.test.ts).
//
// - Refuses to touch any database whose name does not end in _test.
// - Recovers from interrupted runs: ends test sessions left by a killed process, drops leftover test_* triggers and
//   functions, and purges rows in the test namespaces (fictional +1555000NNNN phones, *@example.test staff).
// - Reports whatever it had to clean up, so a leftover is visible rather than silently masking a problem.
//
// Test files must run one at a time against one database (npm test uses --test-concurrency=1): the recovery step
// treats test sessions started before this process as stale and ends them, and the purge covers every test
// namespace, so a file started in parallel would break one that is still running. Needs PostgreSQL 14 or later.
import type pg from 'pg';
// The parser pg itself uses (pg/lib/connection-parameters.js), so the guard checks the database pg will connect to.
import { parse as parseConnectionString } from 'pg-connection-string';

/** Set as PGAPPNAME by every test file, so sessions from an earlier, killed run can be told apart and ended. */
export const TEST_APP_NAME = 'receptionist-test';
/** Every test customer's phone (fictional 555 range). Each file uses its own 4-digit block: see TEST_PHONE_BLOCKS. */
export const TEST_PHONE_PATTERN = '+1555000%';
/** Every test staff account. */
export const TEST_EMAIL_PATTERN = '%@example.test';
/**
 * One phone block per test file, so a file's own cleanup never touches another file's rows. (The recovery purge in
 * prepareTestDatabase deliberately covers all blocks: it runs before a file starts, when no other file is running.)
 */
export const TEST_PHONE_BLOCKS = {
  api: '+15550000%',
  whatsapp: '+15550001%',
  reply: '+15550002%',
  conversations: '+15550003%',
  dbTimeouts: '+15550004%',
} as const;

/**
 * Fixtures that db-hygiene.test.ts creates deliberately OUTSIDE the namespaces (to prove the purge leaves such rows
 * alone). Named here so every file's start-of-run cleanup can remove them after an interrupted run of that file.
 */
export const HYGIENE_FIXTURES = {
  phone: '+447700900123',
  ownerEmail: 'owner@clinic.invalid',
  referencedTestEmail: 'referenced@example.test',
} as const;

/** When this test process started: sessions older than this belong to an earlier run. */
const PROCESS_STARTED = new Date(Date.now() - process.uptime() * 1000);

export function assertDisposableDatabase(name: string): void {
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run destructive tests against database "${name}": its name must end in _test.`);
  }
}

/**
 * The database pg will actually connect to for `url`, parsed exactly as pg parses it. Fails closed:
 * - only postgres://, postgresql:// and socket: URLs (pg's parser resolves anything else against a dummy base URL,
 *   so a stray string would silently become a database name);
 * - a socket: URL's database is its ?db= parameter, not its path (the path is the socket directory). socket: is
 *   recognised only so an unsafe one is refused correctly: the app's config (src/config/env.ts) accepts only
 *   postgres:// and postgresql://, so the tests need one of those;
 * - no database at all is refused (pg would fall back to PGDATABASE or the user name, which this cannot check).
 */
export function effectiveDatabaseName(url: string): string {
  if (!/^(postgres|postgresql|socket):/i.test(url)) {
    throw new Error('Refusing to run destructive tests: TEST_DATABASE_URL must be a postgres://, postgresql:// or socket: URL.');
  }
  let database: string | null | undefined;
  try {
    database = parseConnectionString(url).database;
  } catch {
    throw new Error('Refusing to run destructive tests: TEST_DATABASE_URL could not be parsed.');
  }
  if (!database) throw new Error('Refusing to run destructive tests: TEST_DATABASE_URL names no database.');
  return database;
}

/**
 * Call at the top of every PostgreSQL test file, before any hook is registered. A guard inside before() is not
 * enough: node:test still runs after() hooks when before() fails, and those clean up (delete) data.
 * No URL means no database tests, which is always safe.
 */
export function assertDisposableDatabaseUrl(url: string | undefined): void {
  if (!url) return;
  assertDisposableDatabase(effectiveDatabaseName(url));
}

// Set only once the server itself has confirmed the database name (prepareTestDatabase). The URL check cannot see
// through a connection pooler alias (e.g. "x_test" mapped to a real database), and node:test still runs after()
// hooks when before() fails, so every destructive after() cleanup must check this first. One value per test file:
// node --test runs each file in its own process.
let verifiedDatabase: string | null = null;
export const isDatabaseVerified = (): boolean => verifiedDatabase !== null;

/**
 * Run first in a test file's before(), before migrate(). Returns what it had to clean up (empty on a clean database)
 * and logs it, so an interrupted earlier run is reported instead of breaking this one.
 */
export async function prepareTestDatabase(
  pool: pg.Pool,
  // keepHygieneFixtures: only for db-hygiene.test.ts, while it is checking that the purge leaves such rows alone.
  { staleBefore = PROCESS_STARTED, keepHygieneFixtures = false }: { staleBefore?: Date; keepHygieneFixtures?: boolean } = {},
): Promise<string[]> {
  const report: string[] = [];
  const c = await pool.connect();
  try {
    // Schema-qualified, so a function named current_database() earlier on the search_path cannot answer instead.
    const { rows } = await c.query<{ name: string }>('SELECT pg_catalog.current_database() AS name');
    assertDisposableDatabase(rows[0]!.name);
    verifiedDatabase = rows[0]!.name;

    // Sessions from a killed test run: they can still hold advisory locks (a conversation, or the migration lock).
    // The 5s timeout waits for each session to actually exit, so its locks are free when this returns.
    const { rows: ended } = await c.query(
      `SELECT pid, pg_terminate_backend(pid, 5000) AS ended FROM pg_stat_activity
       WHERE datname = pg_catalog.current_database() AND application_name = $1 AND pid <> pg_backend_pid() AND backend_start < $2`,
      [TEST_APP_NAME, staleBefore],
    );
    const endedCount = ended.filter((r) => r.ended).length; // false if a session did not exit within the 5s wait
    if (endedCount) report.push(`${endedCount} stale test session(s) ended`);
    if (endedCount < ended.length) report.push(`${ended.length - endedCount} stale test session(s) did not end in time`);

    // Temporary test triggers and functions (test_*), wherever they were left.
    const { rows: triggers } = await c.query<{ tgname: string; table: string }>(
      `SELECT t.tgname, t.tgrelid::regclass::text AS table FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgname LIKE 'test\\_%'`,
    );
    for (const t of triggers) {
      await c.query(`DROP TRIGGER IF EXISTS ${quoteIdent(t.tgname)} ON ${t.table}`);
      report.push(`trigger ${t.tgname} on ${t.table}`);
    }
    const { rows: functions } = await c.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'test\\_%'`,
    );
    for (const f of functions) {
      await c.query(`DROP FUNCTION IF EXISTS ${f.signature}`);
      report.push(`function ${f.signature}`);
    }

    // Rows in the test namespaces (only once the schema exists: a fresh database has nothing to purge).
    const { rows: schema } = await c.query<{ ready: boolean }>(`SELECT to_regclass('public.conversation_events') IS NOT NULL AS ready`);
    if (schema[0]!.ready) report.push(...(await purgeTestRows(c, !keepHygieneFixtures)));
  } finally {
    c.release();
  }
  if (report.length) console.warn(`Test database hygiene: cleaned up after an earlier run: ${report.join('; ')}`);
  return report;
}

/**
 * Deletes test-namespace customers (and their conversations, messages, usage and audit events) and test staff, in
 * one transaction using the documented audit-maintenance procedure. Never deletes rows outside the namespaces:
 * audit events are removed only for test conversations, and a test staff account that a non-test message or audit
 * event still points at is kept and reported, not deleted (and does not block the run). The schema's own ON DELETE
 * SET NULL actions can still null a reference on a non-test row that pointed at deleted test data (e.g. an
 * appointment's staff_id); in a disposable _test database that is acceptable.
 */
async function purgeTestRows(c: pg.PoolClient, removeHygieneFixtures: boolean): Promise<string[]> {
  const report: string[] = [];
  await c.query('BEGIN');
  try {
    await c.query(`SET LOCAL receptionist.audit_maintenance = 'on'`);
    if (removeHygieneFixtures) {
      // Exactly the named fixtures of db-hygiene.test.ts, nothing else outside the namespaces.
      const { phone, ownerEmail, referencedTestEmail } = HYGIENE_FIXTURES;
      await c.query(
        `DELETE FROM conversation_events WHERE conversation_id IN (
           SELECT cv.id FROM conversations cv JOIN customers cu ON cu.id = cv.customer_id WHERE cu.phone_number = $1)`,
        [phone],
      );
      const fixtureCustomer = await c.query(`DELETE FROM customers WHERE phone_number = $1`, [phone]); // cascades
      const fixtureStaff = await c.query(
        `DELETE FROM staff_users s WHERE s.email IN ($1, $2)
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.staff_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.staff_id = s.id)`,
        [ownerEmail, referencedTestEmail],
      );
      const removed = (fixtureCustomer.rowCount ?? 0) + (fixtureStaff.rowCount ?? 0);
      if (removed) report.push(`${removed} db-hygiene.test.ts fixture row(s)`);
    }
    const testConversations = `SELECT cv.id FROM conversations cv JOIN customers cu ON cu.id = cv.customer_id WHERE cu.phone_number LIKE $1`;
    const events = await c.query(`DELETE FROM conversation_events WHERE conversation_id IN (${testConversations})`, [TEST_PHONE_PATTERN]);
    const usage = await c.query(`DELETE FROM usage_logs WHERE conversation_id IN (${testConversations})`, [TEST_PHONE_PATTERN]);
    const customers = await c.query(`DELETE FROM customers WHERE phone_number LIKE $1`, [TEST_PHONE_PATTERN]); // cascades
    // Only staff nothing else refers to (messages.staff_id and conversation_events.staff_id refuse deletion).
    const staff = await c.query(
      `DELETE FROM staff_users s WHERE s.email LIKE $1
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.staff_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.staff_id = s.id)`,
      [TEST_EMAIL_PATTERN],
    ); // sessions cascade
    const { rows: kept } = await c.query<{ email: string }>(`SELECT email FROM staff_users WHERE email LIKE $1 ORDER BY email`, [TEST_EMAIL_PATTERN]);
    await c.query('COMMIT');
    for (const [label, result] of [['audit event', events], ['usage row', usage], ['test customer', customers], ['test staff account', staff]] as const) {
      if (result.rowCount) report.push(`${result.rowCount} ${label}(s)`);
    }
    if (kept.length) report.push(`kept ${kept.length} test staff account(s) still referenced by non-test data: ${kept.map((k) => k.email).join(', ')}`);
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return report;
}

/**
 * Installs a temporary test trigger (and its function) for the duration of `run`, and always removes both, even if
 * `run` throws. Creation is idempotent (CREATE OR REPLACE, DROP ... IF EXISTS first), so a leftover from an
 * interrupted run cannot make this fail. `name` must start with test_ so prepareTestDatabase can find leftovers.
 */
export async function withTemporaryTrigger(
  pool: pg.Pool,
  { name, table, timing, body }: { name: string; table: string; timing: string; body: string },
  run: () => Promise<void>,
): Promise<void> {
  if (!/^test_[a-z_]+$/.test(name)) throw new Error(`temporary trigger names must match test_[a-z_]+, got "${name}"`);
  const drop = async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
  };
  await drop();
  try {
    // Inside the try: if creating the trigger fails, the function created just before is still removed.
    await pool.query(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN ${body} END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    await run();
  } finally {
    await drop();
  }
}

const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;
