// Set TEST_DATABASE_URL to a DISPOSABLE database to also run the PostgreSQL tests; they commit rows.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { assertDisposableDatabaseUrl, isDatabaseVerified } from './helpers/db-hygiene.ts';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
assertDisposableDatabaseUrl(testDatabaseUrl); // before any hook: after() hooks still run if before() fails
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl ?? '';
process.env.PGAPPNAME = 'receptionist-test'; // tags this run's sessions; see test/helpers/db-hygiene.ts

const { app } = await import('../src/app.ts');
const { parseEnv } = await import('../src/config/env.ts');
const { errorHandler } = await import('../src/middleware/errors.ts');
const { closePool, pool, sslFor } = await import('../src/database/pool.ts');
const { default: pg } = await import('pg');
const { migrate } = await import('../src/database/migrate.ts');
const { whatsAppService } = await import('../src/services/whatsapp/index.ts');
const { calendarService } = await import('../src/services/calendar/index.ts');
const { bookingService } = await import('../src/services/booking/index.ts');
const { leadService } = await import('../src/services/leads/index.ts');
const { integrationStatus } = await import('../src/services/integrations.ts');
const { hashPassword, verifyPassword } = await import('../src/services/auth/index.ts');
const { createStaffAccount, emailExists, parseRole, resetStaffPassword } = await import('../src/database/create-staff.ts');
const { passwordProblem } = await import('../src/types/api.ts');
const { prepareTestDatabase, TEST_EMAIL_PATTERN } = await import('./helpers/db-hygiene.ts');

let server: Server;
let base: string;
const ADMIN_PASSWORD = 'correct horse battery staple';
const AGENT_PASSWORD = 'another long test password';
let adminCookie = '';
let agentCookie = '';

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}/api`;
  if (!testDatabaseUrl) return;
  await prepareTestDatabase(pool!); // refuses a non-_test database; recovers from an interrupted earlier run
  await migrate();
  // This file asserts on whole-table states ("a fresh database", totals), so it starts them empty even after an
  // interrupted earlier run. Not namespaced: acceptable only because the _test guards above have passed.
  await pool!.query('DELETE FROM usage_logs');
  await pool!.query('DELETE FROM business_info');
  await pool!.query('DELETE FROM services');
  await pool!.query(
    `INSERT INTO staff_users (email, full_name, role, password_hash) VALUES
       ('admin@example.test', 'Test Admin', 'admin', $1), ('agent@example.test', 'Test Agent', 'agent', $2)`,
    [await hashPassword(ADMIN_PASSWORD), await hashPassword(AGENT_PASSWORD)],
  );
  adminCookie = await signIn('admin@example.test', ADMIN_PASSWORD);
  agentCookie = await signIn('agent@example.test', AGENT_PASSWORD);
});

after(async () => {
  server.close();
  // Test accounts only (every one this file creates is @example.test), never every staff user.
  // Only once the server confirmed a _test database: after() still runs when before() failed that check.
  try {
    if (testDatabaseUrl && isDatabaseVerified()) await pool!.query(`DELETE FROM staff_users WHERE email LIKE $1`, [TEST_EMAIL_PATTERN]);
  } finally {
    await closePool(); // also when the clean-up fails, so the run cannot hang on open connections
  }
});

const anonymous = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
};

/** Signed in as the admin whenever a database is present. */
const get = (path: string, init?: RequestInit) =>
  anonymous(path, { ...init, headers: { ...(adminCookie && { cookie: adminCookie }), ...init?.headers } });

const send = (method: string, path: string, body?: unknown, cookie = adminCookie) =>
  anonymous(path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const attemptLogin = (email: string, password: string) => send('POST', '/auth/login', { email, password }, '');

async function signIn(email: string, password: string) {
  const { status, headers } = await attemptLogin(email, password);
  assert.equal(status, 200);
  return headers.getSetCookie()[0]!.split(';')[0]!;
}

describe('password hashing', () => {
  it('stores a salted scrypt hash, never the password', async () => {
    const [a, b] = await Promise.all([hashPassword('secret-password-1'), hashPassword('secret-password-1')]);
    assert.match(a, /^scrypt\$/);
    assert.ok(!a.includes('secret-password-1'));
    assert.notEqual(a, b);
  });

  it('accepts only the right password and rejects malformed hashes', async () => {
    const hash = await hashPassword('secret-password-1');
    assert.equal(await verifyPassword('secret-password-1', hash), true);
    assert.equal(await verifyPassword('secret-password-2', hash), false);
    assert.equal(await verifyPassword('secret-password-1', 'not-a-hash'), false);
  });
});

describe('staff account rules', () => {
  it('accepts exactly admin and agent, with admin as the default', () => {
    assert.equal(parseRole(''), 'admin');
    assert.equal(parseRole('   '), 'admin');
    assert.equal(parseRole('admin'), 'admin');
    assert.equal(parseRole('agent'), 'agent');
  });

  it('never converts an invalid role into a valid one', () => {
    for (const role of ['super admin', 'superadmin', 'Admin', 'ADMIN', 'owner', 'admin agent', 'agent,admin']) {
      assert.equal(parseRole(role), null, role);
    }
  });

  it('rejects weak passwords without repeating them', () => {
    const weak: [string, string[]][] = [
      ['short-pass', []],
      ['aaaaaaaaaaaaaaaa', []],
      ['111222111222', []],
      ['123456789012', []],
      ['Password123456', []],
      ['adminadmin2026!', []],
      ['Muhammed-garden-77', ['Muhammed Test']],
      ['owner.kettle.river', ['owner@example.test']],
      ['y'.repeat(201), []],
    ];
    for (const [password, personal] of weak) {
      const problem = passwordProblem(password, personal);
      assert.ok(problem, password);
      assert.ok(!problem.includes(password), password);
    }
  });

  it('accepts long passphrases without forcing symbols', () => {
    assert.equal(passwordProblem('correct horse battery staple', ['owner@example.test', 'Owner Test']), null);
    assert.equal(passwordProblem('Tr7!kq2#Lm9$'), null);
  });
});

describe('environment validation', () => {
  it('allows blank integration credentials outside production', () => {
    const parsed = parseEnv({ NODE_ENV: 'development', DATABASE_URL: '', OPENAI_API_KEY: '' });
    assert.equal(parsed.DATABASE_URL, undefined);
    assert.equal(parsed.OPENAI_API_KEY, undefined);
    assert.equal(parsed.PORT, 4000);
  });

  it('keeps WHATSAPP_APP_SECRET, and treats a blank one as unset', () => {
    assert.equal(parseEnv({ WHATSAPP_APP_SECRET: 'f'.repeat(32) }).WHATSAPP_APP_SECRET, 'f'.repeat(32));
    assert.equal(parseEnv({ WHATSAPP_APP_SECRET: '' }).WHATSAPP_APP_SECRET, undefined);
  });

  it('requires database and frontend URL in production', () => {
    assert.throws(() => parseEnv({ NODE_ENV: 'production' }), /DATABASE_URL.*\n.*FRONTEND_URL/);
  });

  it('does not echo a malformed secret', () => {
    assert.throws(
      () => parseEnv({ DATABASE_URL: 'mysql://user:hunter2@host/db' }),
      (err: Error) => err.message.includes('DATABASE_URL') && !err.message.includes('hunter2'),
    );
  });
});

describe('API basics', () => {
  it('GET /api/health returns 200 with security headers', async () => {
    const { status, body, headers } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'ok');
    assert.ok(headers.get('x-content-type-options'));
    assert.equal(headers.get('x-powered-by'), null);
  });

  it('GET /api never reports an integration as connected', async () => {
    const { status, body } = await get('');
    assert.equal(status, 200);
    for (const integration of Object.values(body.data.integrations) as { connected: boolean }[]) {
      assert.equal(integration.connected, false);
    }
    assert.deepEqual(body.data.integrations, integrationStatus());
  });

  it('unknown routes return the 404 envelope', async () => {
    const { status, body } = await get('/nope');
    assert.equal(status, 404);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('invalid query parameters return 400 with field details', async () => {
    for (const query of ['status=bogus', 'limit=1000', 'page=0', 'unknown=1']) {
      const { status, body } = await get(`/leads?${query}`);
      assert.equal(status, 400, query);
      assert.equal(body.error.code, 'VALIDATION_ERROR', query);
    }
  });

  it('malformed JSON is a client error and leaks nothing', async () => {
    const { status, body } = await get('/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    assert.equal(status, 400);
    assert.equal(body.error.message, 'Invalid request.');
  });

  it('CORS allows only the configured dashboard origin', async () => {
    const { headers } = await get('/health', { headers: { origin: 'http://localhost:5173' } });
    assert.equal(headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const other = await get('/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  it('placeholders refuse instead of faking success', async () => {
    const refused = { code: 'INTEGRATION_PENDING' };
    // Built now, but with no WhatsApp credentials it refuses rather than pretending.
    await assert.rejects(whatsAppService.sendText('+15550000001', 'hi'), { code: 'WHATSAPP_NOT_CONFIGURED' });
    assert.equal(whatsAppService.verifySignature(Buffer.from('{}'), 'sha256=00'), false);
    assert.equal(whatsAppService.verifyToken(''), false);
    // Built now, but with no Google credentials it refuses rather than pretending.
    await assert.rejects(calendarService.deleteEvent('x'), { code: 'CALENDAR_NOT_CONFIGURED' });
    await assert.rejects(bookingService.cancel('x'), refused);
    await assert.rejects(leadService.updateStatus('x', 'lost'), refused);
  });
});

describe('database TLS', () => {
  // What pg will actually use: the pool's ssl option, overridden by anything in the URL. A Client does not connect until asked.
  const effectiveSsl = (url: string) => (new pg.Client({ connectionString: url, ssl: sslFor(url) }) as unknown as { ssl: unknown }).ssl;
  // pg verifies certificates unless rejectUnauthorized is false: true and {} both mean verified TLS.
  const verified = (ssl: unknown) => ssl === true || (typeof ssl === 'object' && ssl !== null && (ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized !== false);

  it('uses verified TLS for a public host such as Render External URL', () => {
    assert.ok(verified(effectiveSsl('postgresql://u:p@dpg-abc123-a.oregon-postgres.render.com/app')));
  });

  it('stays plain for local development and private single-label hosts', () => {
    for (const url of [
      'postgresql://u:p@localhost:5432/app',
      'postgresql://u@127.0.0.1/app',
      'postgresql://u@[::1]/app',
      'postgresql:///app?host=/var/run/postgresql',
      'postgresql://u:p@dpg-abc123-a/app', // Render Internal URL
    ]) {
      assert.equal(effectiveSsl(url), false, url);
    }
  });

  it('lets sslmode in the URL decide', () => {
    assert.equal(effectiveSsl('postgresql://u:p@db.example.com/app?sslmode=disable'), false);
    assert.ok(verified(effectiveSsl('postgresql://u:p@localhost/app?sslmode=verify-full')));
    assert.equal(sslFor('postgresql://u:p@db.example.com/app?sslmode=verify-full'), undefined);
  });
});

describe('database error classification', () => {
  const classify = (err: unknown) => {
    let result: { status?: number; body?: any } = {};
    const res = {
      headersSent: false,
      status(status: number) {
        result.status = status;
        return this;
      },
      json(body: unknown) {
        result.body = body;
      },
    };
    const originalError = console.error;
    console.error = () => {};
    errorHandler(err, { method: 'GET', path: '/x' } as never, res as never, () => {});
    console.error = originalError;
    return { status: result.status, code: result.body.error.code, message: result.body.error.message };
  };

  it('login problems are 503 DATABASE_UNAVAILABLE and reveal nothing', () => {
    const missingPassword = new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string');
    const wrongPassword = Object.assign(new Error('password authentication failed for user "secret_user"'), { code: '28P01' });
    for (const err of [missingPassword, wrongPassword]) {
      const result = classify(err);
      assert.equal(result.status, 503);
      assert.equal(result.code, 'DATABASE_UNAVAILABLE');
      assert.ok(!result.message.includes('secret_user'));
    }
  });

  it('a duplicate value is 409 CONFLICT and does not echo the database message', () => {
    const result = classify(Object.assign(new Error('Key (name)=(secret) already exists'), { code: '23505' }));
    assert.equal(result.status, 409);
    assert.equal(result.code, 'CONFLICT');
    assert.ok(!result.message.includes('secret'));
  });

  it('unrelated errors stay 500', () => {
    assert.equal(classify(new Error('boom')).status, 500);
  });
});

describe('without a database', { skip: Boolean(testDatabaseUrl) }, () => {
  it('data endpoints say the database is not configured, not that data is empty', async () => {
    for (const path of ['/conversations', '/leads', '/appointments', '/business-info', '/usage', '/dashboard/summary']) {
      const { status, body } = await get(path);
      assert.equal(status, 200, path);
      assert.equal(body.meta.dataState, 'database_not_configured', path);
    }
    assert.equal((await get('/dashboard/summary')).body.data.kpis, null);
    assert.equal((await get('/services')).body.meta.dataState, 'database_not_configured');
  });

  it('login and writes refuse with 503 instead of pretending to work', async () => {
    const service = { name: 'x', durationMinutes: 30 };
    const results = [
      await attemptLogin('a@example.test', 'whatever-password'),
      await get('/auth/me'),
      await send('POST', '/services', service),
      await send('PUT', '/business-info/profile', { name: 'x' }),
    ];
    for (const { status, body } of results) {
      assert.equal(status, 503);
      assert.equal(body.error.code, 'DATABASE_NOT_CONFIGURED');
    }
  });

  it('GET /api/health/database returns 503 DATABASE_NOT_CONFIGURED', async () => {
    const { status, body } = await get('/health/database');
    assert.equal(status, 503);
    assert.equal(body.error.code, 'DATABASE_NOT_CONFIGURED');
  });
});

describe('with PostgreSQL', { skip: !testDatabaseUrl }, () => {
  before(async () => {
    await migrate();
  });

  it('migrate is idempotent and health reports connected', async () => {
    assert.deepEqual(await migrate(), []);
    const { status, body } = await get('/health/database');
    assert.equal(status, 200);
    assert.equal(body.data.status, 'connected');
    assert.equal(body.data.migrationsApplied, 6);
  });

  it('a fresh database returns identified empty states', async () => {
    for (const path of ['/conversations', '/leads', '/appointments', '/business-info', '/usage', '/dashboard/summary']) {
      const { status, body } = await get(path);
      assert.equal(status, 200, path);
      assert.equal(body.meta.dataState, 'empty', path);
    }
    assert.equal((await get('/dashboard/summary')).body.data.kpis.openConversations, 0);
  });

  it('constraints reject invalid data', async () => {
    const client = await pool!.connect();
    const rejects = async (sql: string, params: unknown[], code: string) => {
      await client.query('SAVEPOINT s');
      await assert.rejects(client.query(sql, params), { code });
      await client.query('ROLLBACK TO s');
    };
    try {
      await client.query('BEGIN');
      const insertCustomer = 'INSERT INTO customers (phone_number) VALUES ($1) RETURNING id';
      const customer = (await client.query(insertCustomer, ['+15550000001'])).rows[0].id;
      const staff = (
        await client.query(`INSERT INTO staff_users (email, full_name) VALUES ('a@example.com', 'A') RETURNING id`)
      ).rows[0].id;
      const conversation = (
        await client.query('INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id', [customer])
      ).rows[0].id;
      const insertMessage = `INSERT INTO messages (conversation_id, direction, sender_type, whatsapp_message_id)
                             VALUES ($1, 'inbound', 'customer', $2)`;
      await client.query(insertMessage, [conversation, 'wamid.1']);
      await client.query(insertMessage, [conversation, null]);
      await client.query(insertMessage, [conversation, null]); // NULL IDs must not conflict
      const insertAppointment = `INSERT INTO appointments (customer_id, staff_id, starts_at, ends_at, status, google_calendar_event_id)
                                 VALUES ($1, $2, $3, $4, $5, $6)`;
      await client.query(insertAppointment, [customer, staff, '2030-01-01T10:00Z', '2030-01-01T11:00Z', 'confirmed', 'evt1']);

      await rejects(insertCustomer, ['+15550000001'], '23505'); // duplicate phone
      await rejects(insertCustomer, ['not-a-phone'], '23514');
      await rejects('INSERT INTO conversations (customer_id) VALUES ($1)', [customer], '23505'); // second live thread
      await rejects(insertMessage, [conversation, 'wamid.1'], '23505'); // duplicate WhatsApp ID
      await rejects(insertAppointment, [customer, null, '2030-02-01T11:00Z', '2030-02-01T10:00Z', 'pending', null], '23514'); // ends before start
      await rejects(insertAppointment, [customer, null, '2030-02-01T10:00Z', '2030-02-01T10:00Z', 'pending', null], '23514'); // zero length
      await rejects(insertAppointment, [customer, null, '2030-02-02T10:00Z', '2030-02-02T11:00Z', 'pending', 'evt1'], '23505'); // duplicate calendar event
      await rejects(insertAppointment, [customer, staff, '2030-01-01T10:30Z', '2030-01-01T11:30Z', 'pending', null], '23P01'); // staff overlap
      await rejects(insertAppointment, [customer, null, '2030-03-01T10:00Z', '2030-03-01T11:00Z', 'bogus', null], '23514');
      await rejects(`INSERT INTO webhook_events (source, payload) VALUES ('nope', '{}')`, [], '23514');

      // A cancelled booking frees its slot, and back-to-back bookings do not overlap.
      await client.query(insertAppointment, [customer, staff, '2030-01-01T10:30Z', '2030-01-01T11:30Z', 'cancelled', null]);
      await client.query(insertAppointment, [customer, staff, '2030-01-01T11:00Z', '2030-01-01T12:00Z', 'pending', null]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('updated_at changes on update', async () => {
    const { rows } = await pool!.query(`INSERT INTO customers (phone_number) VALUES ('+15550000099') RETURNING id`);
    // Compared in SQL: a JS Date only has milliseconds, and both writes can land in the same one.
    const updated = await pool!.query(`UPDATE customers SET name = 'x' WHERE id = $1 RETURNING updated_at > created_at AS changed`, [rows[0].id]);
    assert.equal(updated.rows[0].changed, true);
    await pool!.query('DELETE FROM customers WHERE id = $1', [rows[0].id]);
  });

  it('list and summary endpoints return joined rows, filters and pagination', async () => {
    const customer = (
      await pool!.query(`INSERT INTO customers (phone_number, name) VALUES ('+15550000002', 'Test Customer') RETURNING id`)
    ).rows[0].id;
    try {
      const conversation = (
        await pool!.query(`INSERT INTO conversations (customer_id, last_message_at) VALUES ($1, now()) RETURNING id`, [customer])
      ).rows[0].id;
      await pool!.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, content) VALUES ($1, 'inbound', 'customer', 'first'), ($1, 'outbound', 'ai', 'second')`,
        [conversation],
      );
      await pool!.query(`INSERT INTO leads (customer_id, interest) VALUES ($1, 'a'), ($1, 'b')`, [customer]);
      await pool!.query(
        `INSERT INTO appointments (customer_id, starts_at, ends_at) VALUES ($1, now() + interval '1 day', now() + interval '25 hours')`,
        [customer],
      );
      await pool!.query(
        `INSERT INTO usage_logs (provider, operation, model, input_tokens, output_tokens, estimated_cost) VALUES ('openai', 'reply', 'm', 1500, 300, 0.01)`,
      );

      const conversations = await get('/conversations');
      assert.equal(conversations.body.meta.dataState, 'has_data');
      assert.equal(conversations.body.data[0].customerPhone, '+15550000002');
      assert.equal(conversations.body.data[0].messageCount, 2);
      assert.ok(['first', 'second'].includes(conversations.body.data[0].lastMessage));

      const page2 = await get('/leads?limit=1&page=2');
      assert.equal(page2.body.data.length, 1);
      assert.equal(page2.body.meta.total, 2);
      assert.equal((await get('/leads?status=lost')).body.meta.total, 0);

      const summary = (await get('/dashboard/summary')).body.data;
      assert.deepEqual(summary.kpis, {
        openConversations: 1,
        awaitingHandover: 0,
        newLeads: 2,
        upcomingAppointments: 1,
        messagesToday: 2,
      });
      assert.equal(summary.upcomingAppointments.length, 1);

      const usage = (await get('/usage')).body.data;
      assert.equal(usage[0].inputTokens, '1500');
    } finally {
      await pool!.query('DELETE FROM usage_logs');
      await pool!.query('DELETE FROM customers WHERE id = $1', [customer]); // cascades
    }
    assert.equal((await pool!.query('SELECT count(*)::int AS n FROM messages')).rows[0].n, 0);
  });
});

describe('staff authentication', { skip: !testDatabaseUrl }, () => {
  const PROTECTED: [string, string][] = [
    ['GET', ''],
    ['GET', '/auth/me'],
    ['GET', '/health/database'],
    ['GET', '/dashboard/summary'],
    ['GET', '/conversations'],
    ['GET', '/conversations/00000000-0000-4000-8000-000000000000'],
    ['POST', '/conversations/00000000-0000-4000-8000-000000000000/takeover'],
    ['POST', '/conversations/00000000-0000-4000-8000-000000000000/reopen'],
    ['POST', '/conversations/00000000-0000-4000-8000-000000000000/close'],
    ['POST', '/conversations/00000000-0000-4000-8000-000000000000/messages'],
    ['POST', '/conversations/00000000-0000-4000-8000-000000000000/reactivate'],
    ['GET', '/leads'],
    ['GET', '/appointments'],
    ['GET', '/usage'],
    ['GET', '/business-info'],
    ['PUT', '/business-info/profile'],
    ['POST', '/business-info/entries'],
    ['PUT', '/business-info/entries/00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/business-info/entries/00000000-0000-4000-8000-000000000000'],
    ['GET', '/services'],
    ['POST', '/services'],
    ['PUT', '/services/00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/services/00000000-0000-4000-8000-000000000000'],
    ['GET', '/integrations/google/status'],
    ['POST', '/integrations/google/authorize'],
    ['POST', '/integrations/google/test'],
    ['DELETE', '/integrations/google'],
  ];

  it('every dashboard route refuses a request with no session, and only /health stays public', async () => {
    for (const [method, path] of PROTECTED) {
      const { status, body } = await anonymous(path, { method });
      assert.equal(status, 401, `${method} ${path}`);
      assert.equal(body.error.code, 'UNAUTHENTICATED', `${method} ${path}`);
    }
    assert.equal((await anonymous('/health')).status, 200);
  });

  it('a made-up session token is refused', async () => {
    const { status } = await anonymous('/auth/me', { headers: { cookie: 'receptionist_session=made-up' } });
    assert.equal(status, 401);
  });

  it('login sets an HttpOnly, SameSite=Strict cookie and returns no password data', async () => {
    const { status, headers, body } = await attemptLogin('ADMIN@example.test', ADMIN_PASSWORD); // email is case-insensitive
    assert.equal(status, 200);
    const cookie = headers.getSetCookie()[0]!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.deepEqual(Object.keys(body.data).sort(), ['email', 'fullName', 'id', 'role']);
    assert.ok(!JSON.stringify(body).includes('scrypt'));
  });

  it('the database stores a hash of the password and of the session token', async () => {
    const { rows } = await pool!.query(`SELECT password_hash FROM staff_users WHERE email = 'admin@example.test'`);
    assert.ok(!rows[0].password_hash.includes(ADMIN_PASSWORD));
    const token = adminCookie.split('=')[1]!;
    const sessions = await pool!.query('SELECT token_hash FROM staff_sessions');
    assert.ok(sessions.rows.length > 0);
    assert.ok(sessions.rows.every((r) => r.token_hash !== token));
  });

  it('wrong password and unknown email get the same answer', async () => {
    const wrong = await attemptLogin('agent@example.test', 'wrong-password-here');
    const unknown = await attemptLogin('nobody@example.test', 'wrong-password-here');
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('invalid login input is a validation error', async () => {
    for (const body of [{}, { email: 'not-an-email', password: 'x' }, { email: 'a@example.test', password: '' }, { email: 'a@example.test', password: 'x', role: 'admin' }]) {
      const result = await send('POST', '/auth/login', body, '');
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('staff creation refuses a duplicate email in any case and leaves the first account alone', async () => {
    const input = { email: 'first@example.test', fullName: 'First', role: 'agent' as const, password: 'first-account-password' };
    assert.equal(await createStaffAccount(input), true);
    assert.equal(await emailExists('FIRST@example.test'), true);
    assert.equal(await createStaffAccount({ ...input, email: 'FIRST@example.test', role: 'admin', password: 'attacker-chosen-password' }), false);
    const { rows } = await pool!.query(`SELECT role FROM staff_users WHERE lower(email) = 'first@example.test'`);
    assert.deepEqual(rows, [{ role: 'agent' }]);
    assert.equal((await attemptLogin('first@example.test', 'first-account-password')).status, 200);

    assert.equal(await resetStaffPassword('nobody@example.test', 'some-new-password'), false);
    const cookie = await signIn('first@example.test', 'first-account-password');
    assert.equal(await resetStaffPassword('first@example.test', 'replacement-password'), true);
    assert.equal((await anonymous('/auth/me', { headers: { cookie } })).status, 401);
    assert.equal((await attemptLogin('first@example.test', 'replacement-password')).status, 200);
    await pool!.query(`DELETE FROM staff_users WHERE email = 'first@example.test'`);
  });

  it('a staff user with no password set cannot sign in', async () => {
    await pool!.query(`INSERT INTO staff_users (email, full_name) VALUES ('nohash@example.test', 'No Hash')`);
    assert.equal((await attemptLogin('nohash@example.test', 'any-password-here')).status, 401);
    await pool!.query(`DELETE FROM staff_users WHERE email = 'nohash@example.test'`);
  });

  it('repeated failures lock out even the right password', async () => {
    await pool!.query(`INSERT INTO staff_users (email, full_name, password_hash) VALUES ('locked@example.test', 'Locked', $1)`, [
      await hashPassword('the-right-password'),
    ]);
    for (let i = 0; i < 5; i += 1) assert.equal((await attemptLogin('locked@example.test', 'the-wrong-password')).status, 401);
    const blocked = await attemptLogin('locked@example.test', 'the-right-password');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'TOO_MANY_ATTEMPTS');
    await pool!.query(`DELETE FROM staff_users WHERE email = 'locked@example.test'`);
  });

  it('logout ends the session on the server, not just in the browser', async () => {
    const cookie = await signIn('admin@example.test', ADMIN_PASSWORD);
    const me = await get('/auth/me', { headers: { cookie } });
    assert.equal(me.body.data.email, 'admin@example.test');
    const out = await send('POST', '/auth/logout', undefined, cookie);
    assert.equal(out.status, 200);
    assert.match(out.headers.getSetCookie()[0]!, /receptionist_session=;/);
    assert.equal((await anonymous('/auth/me', { headers: { cookie } })).status, 401);
  });

  it('expired sessions and deactivated staff are refused', async () => {
    const expired = await signIn('agent@example.test', AGENT_PASSWORD);
    await pool!.query(`UPDATE staff_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [
      createHash('sha256').update(expired.split('=')[1]!).digest('hex'),
    ]);
    assert.equal((await anonymous('/auth/me', { headers: { cookie: expired } })).status, 401);

    await pool!.query(`UPDATE staff_users SET is_active = false WHERE email = 'agent@example.test'`);
    assert.equal((await anonymous('/auth/me', { headers: { cookie: agentCookie } })).status, 401);
    assert.equal((await attemptLogin('agent@example.test', AGENT_PASSWORD)).status, 401);
    await pool!.query(`UPDATE staff_users SET is_active = true WHERE email = 'agent@example.test'`);
    assert.equal((await anonymous('/auth/me', { headers: { cookie: agentCookie } })).status, 200);
  });

  it('agents can read and handle conversations, but only admins can change anything else', async () => {
    assert.equal((await send('GET', '/services', undefined, agentCookie)).status, 200);
    assert.equal((await send('GET', '/business-info', undefined, agentCookie)).status, 200);
    // Front-line work for any staff member; tested in conversations.test.ts.
    const agentWork = /\/conversations\/[^/]+\/(takeover|reopen|close|messages)$/;
    const writes = PROTECTED.filter(([method, path]) => method !== 'GET' && !agentWork.test(path));
    for (const [method, path] of writes) {
      const { status, body } = await send(method, path, {}, agentCookie);
      assert.equal(status, 403, `${method} ${path}`);
      assert.equal(body.error.code, 'FORBIDDEN', `${method} ${path}`);
    }
  });

  it('writes from a foreign site are refused even with a valid session', async () => {
    const { status, body } = await anonymous('/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'evil', durationMinutes: 5 }),
    });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'FORBIDDEN_ORIGIN');
    const allowed = await anonymous('/auth/me', { headers: { cookie: adminCookie, origin: 'http://localhost:5173' } });
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  });
});

describe('business information', { skip: !testDatabaseUrl }, () => {
  const rowCount = async () => (await pool!.query(`SELECT count(*)::int AS n FROM business_info WHERE category = 'profile'`)).rows[0].n;
  const full = {
    name: 'Test Clinic',
    description: 'A test clinic',
    address: '1 Test Street',
    phone: '+1 555 000 0000',
    email: 'hello@example.test',
    website: 'https://example.test',
    workingHours: 'Mon-Fri 9:00-17:00',
    isPublished: true,
  };

  it('saves, reads and updates the profile in PostgreSQL', async () => {
    const saved = await send('PUT', '/business-info/profile', full);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.data, full);
    assert.equal(await rowCount(), 7);

    const read = await get('/business-info');
    assert.deepEqual(read.body.data.profile, full);
    assert.deepEqual(read.body.data.entries, []); // the profile is not listed twice
    assert.equal(read.body.meta.dataState, 'has_data');

    await send('PUT', '/business-info/profile', { ...full, name: 'Renamed Clinic' });
    const { rows } = await pool!.query(`SELECT content, is_published FROM business_info WHERE key = 'business_name'`);
    assert.deepEqual(rows[0], { content: 'Renamed Clinic', is_published: true });
  });

  it('a blank field removes its row, and a failed save changes nothing', async () => {
    const { body } = await send('PUT', '/business-info/profile', { name: 'Only Name' });
    assert.deepEqual(body.data, { name: 'Only Name', description: '', address: '', phone: '', email: '', website: '', workingHours: '', isPublished: false });
    assert.equal(await rowCount(), 1);

    const rejected = await send('PUT', '/business-info/profile', { name: 'Changed', email: 'nope' });
    assert.equal(rejected.status, 400);
    assert.ok(rejected.body.error.details.email);
    assert.equal((await get('/business-info')).body.data.profile.name, 'Only Name');
  });

  it('rejects invalid profile input with field details', async () => {
    const cases: [object, string][] = [
      [{ name: '   ' }, 'name'],
      [{ name: 'x', phone: 'call me' }, 'phone'],
      [{ name: 'x', website: 'javascript:alert(1)' }, 'website'],
      [{ name: 'x', address: 'y'.repeat(501) }, 'address'],
    ];
    for (const [body, field] of cases) {
      const result = await send('PUT', '/business-info/profile', body);
      assert.equal(result.status, 400, field);
      assert.ok(result.body.error.details[field], field);
    }
    assert.equal((await send('PUT', '/business-info/profile', { name: 'x', admin: true })).status, 400);
  });

  it('creates, updates and deletes policies', async () => {
    const created = await send('POST', '/business-info/entries', { category: 'policy', title: 'Refunds', content: 'Within 7 days' });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.isPublished, false); // nothing reaches the AI until published
    const { id } = created.body.data;

    const updated = await send('PUT', `/business-info/entries/${id}`, { category: 'faq', title: 'Refunds?', content: 'Yes', isPublished: true });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.isPublished, true);
    assert.equal((await get('/business-info')).body.data.entries[0].title, 'Refunds?');

    assert.equal((await send('DELETE', `/business-info/entries/${id}`)).status, 200);
    assert.equal((await send('DELETE', `/business-info/entries/${id}`)).status, 404);
    assert.equal((await send('PUT', `/business-info/entries/${id}`, { category: 'faq', title: 'x', content: 'y' })).status, 404);
    assert.deepEqual((await get('/business-info')).body.data.entries, []);
  });

  it('entries cannot be used to edit the profile, or be created without valid fields', async () => {
    const { rows } = await pool!.query(`SELECT id FROM business_info WHERE key = 'business_name'`);
    const entry = { category: 'policy', title: 'x', content: 'y' };
    assert.equal((await send('PUT', `/business-info/entries/${rows[0].id}`, entry)).status, 404);
    assert.equal((await send('DELETE', `/business-info/entries/${rows[0].id}`)).status, 404);
    assert.equal((await send('POST', '/business-info/entries', { ...entry, category: 'profile' })).status, 400);
    assert.equal((await send('POST', '/business-info/entries', { ...entry, title: '' })).status, 400);
    assert.equal((await send('DELETE', '/business-info/entries/not-a-uuid')).status, 400);
    await pool!.query(`DELETE FROM business_info`);
  });

  it('AI knowledge holds only published entries and active services', async () => {
    const { loadBusinessKnowledge } = await import('../src/services/ai/index.ts');
    await send('PUT', '/business-info/profile', { name: 'Draft Clinic', isPublished: false });
    await send('POST', '/business-info/entries', { category: 'faq', title: 'Parking', content: 'Free parking', isPublished: true });
    await send('POST', '/business-info/entries', { category: 'policy', title: 'Secret', content: 'Unpublished draft' });
    await send('POST', '/services', { name: 'Checkup', durationMinutes: 20, priceAmount: '10.00', currency: 'usd', isActive: true });
    await send('POST', '/services', { name: 'Retired', durationMinutes: 20, isActive: false });
    const knowledge = await loadBusinessKnowledge();
    assert.match(knowledge, /Free parking/);
    assert.match(knowledge, /Checkup \(20 min, 10.00 USD\)/);
    for (const hidden of ['Draft Clinic', 'Unpublished draft', 'Retired']) assert.doesNotMatch(knowledge, new RegExp(hidden));
    await pool!.query(`DELETE FROM business_info`);
    await pool!.query('DELETE FROM services');
  });
});

describe('services management', { skip: !testDatabaseUrl }, () => {
  const consult = { name: 'Consultation', description: 'First visit', durationMinutes: 30, priceAmount: '25.50', currency: 'usd', isActive: true };

  it('creates, reads, updates and deletes a service in PostgreSQL', async () => {
    const created = await send('POST', '/services', consult);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.priceAmount, '25.50');
    assert.equal(created.body.data.currency, 'USD');
    const { id } = created.body.data;

    const listed = await get('/services');
    assert.equal(listed.body.meta.total, 1);
    assert.equal(listed.body.meta.dataState, 'has_data');
    assert.equal(listed.body.data[0].id, id);

    const updated = await send('PUT', `/services/${id}`, { ...consult, name: 'Long consultation', durationMinutes: 60, isActive: false });
    assert.equal(updated.status, 200);
    const { rows } = await pool!.query('SELECT name, duration_minutes, is_active FROM services WHERE id = $1', [id]);
    assert.deepEqual(rows[0], { name: 'Long consultation', duration_minutes: 60, is_active: false });

    assert.equal((await get('/services?status=active')).body.meta.total, 0);
    assert.equal((await get('/services?status=inactive')).body.meta.total, 1);

    assert.equal((await send('DELETE', `/services/${id}`)).status, 200);
    assert.equal((await send('DELETE', `/services/${id}`)).status, 404);
    assert.equal((await send('PUT', `/services/${id}`, consult)).status, 404);
    assert.equal((await get('/services')).body.meta.dataState, 'empty');
  });

  it('a free service has no price or currency', async () => {
    const { status, body } = await send('POST', '/services', { name: 'Free chat', durationMinutes: 10, currency: 'USD' });
    assert.equal(status, 201);
    assert.equal(body.data.priceAmount, null);
    assert.equal(body.data.currency, null);
    await send('DELETE', `/services/${body.data.id}`);
  });

  it('rejects invalid input with field details', async () => {
    const cases: [object, string][] = [
      [{ ...consult, name: ' ' }, 'name'],
      [{ ...consult, durationMinutes: 0 }, 'durationMinutes'],
      [{ ...consult, durationMinutes: 1.5 }, 'durationMinutes'],
      [{ ...consult, durationMinutes: 1441 }, 'durationMinutes'],
      [{ ...consult, durationMinutes: '30' }, 'durationMinutes'],
      [{ ...consult, priceAmount: '-1' }, 'priceAmount'],
      [{ ...consult, priceAmount: '1.999' }, 'priceAmount'],
      [{ ...consult, priceAmount: '12345678901' }, 'priceAmount'],
      [{ ...consult, currency: 'DOLLARS' }, 'currency'],
      [{ ...consult, currency: null }, 'currency'],
    ];
    for (const [body, field] of cases) {
      const result = await send('POST', '/services', body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.ok(result.body.error.details[field], JSON.stringify(body));
    }
    assert.equal((await send('POST', '/services', { ...consult, surprise: 1 })).status, 400);
    assert.equal((await send('PUT', '/services/not-a-uuid', consult)).status, 400);
    assert.equal((await get('/services')).body.meta.total, 0);
  });

  it('a duplicate name is 409, on create and on rename', async () => {
    const a = await send('POST', '/services', consult);
    const b = await send('POST', '/services', { ...consult, name: 'Other' });
    assert.equal(a.status, 201);
    const duplicate = await send('POST', '/services', consult);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'CONFLICT');
    assert.equal((await send('PUT', `/services/${b.body.data.id}`, consult)).status, 409);
    await pool!.query('DELETE FROM services');
  });

  it('deleting a service keeps its leads and appointments', async () => {
    const service = (await send('POST', '/services', consult)).body.data.id;
    const customer = (await pool!.query(`INSERT INTO customers (phone_number) VALUES ('+15550000003') RETURNING id`)).rows[0].id;
    const lead = (await pool!.query('INSERT INTO leads (customer_id, service_id) VALUES ($1, $2) RETURNING id', [customer, service])).rows[0].id;
    await send('DELETE', `/services/${service}`);
    const { rows } = await pool!.query('SELECT service_id FROM leads WHERE id = $1', [lead]);
    assert.equal(rows[0].service_id, null);
    await pool!.query('DELETE FROM customers WHERE id = $1', [customer]);
  });
});
