// Google is mocked: no test contacts Google. The OAuth and Calendar suites need TEST_DATABASE_URL (a DISPOSABLE database).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { assertDisposableDatabaseUrl, isDatabaseVerified } from './helpers/db-hygiene.ts';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
assertDisposableDatabaseUrl(testDatabaseUrl); // before any hook: after() hooks still run if before() fails
Object.assign(process.env, {
  PGAPPNAME: 'receptionist-test', // tags this run's sessions; see test/helpers/db-hygiene.ts
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl ?? '',
  FRONTEND_URL: 'http://localhost:5173',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:4000/api/integrations/google/callback',
  GOOGLE_CALENDAR_ID: 'primary',
  GOOGLE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});

const { app } = await import('../src/app.ts');
const { parseEnv } = await import('../src/config/env.ts');
const { closePool, pool } = await import('../src/database/pool.ts');
const { migrate } = await import('../src/database/migrate.ts');
const { prepareTestDatabase } = await import('./helpers/db-hygiene.ts');
const { hashPassword } = await import('../src/services/auth/index.ts');
const { calendarService, CALENDAR_API } = await import('../src/services/calendar/index.ts');
const { decrypt, encrypt, REVOKE_URL, SCOPES, TOKEN_URL } = await import('../src/services/calendar/oauth.ts');

// --- Google mock: every non-local request goes to `google`, and is recorded.
interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
}
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let google: (call: Call) => Response | Promise<Response> = () => {
  throw new Error('unexpected Google call');
};
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const call = { url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? '') };
  calls.push(call);
  return google(call);
}) as typeof fetch;
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const form = (call: Call) => Object.fromEntries(new URLSearchParams(call.body));

describe('token encryption', () => {
  it('round-trips, hides the plaintext and differs every time', () => {
    const a = encrypt('1//refresh-secret', 'refresh_token');
    assert.equal(decrypt(a, 'refresh_token'), '1//refresh-secret');
    assert.ok(!a.includes('refresh-secret'));
    assert.notEqual(a, encrypt('1//refresh-secret', 'refresh_token'));
  });

  it('refuses tampered data, the wrong purpose and garbage', () => {
    const a = encrypt('token', 'access_token');
    const parts = a.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    for (const bad of [parts.join('.'), 'garbage']) assert.throws(() => decrypt(bad, 'access_token'), { code: 'CALENDAR_RECONNECT_REQUIRED' });
    assert.throws(() => decrypt(a, 'refresh_token'), { code: 'CALENDAR_RECONNECT_REQUIRED' });
  });

  it('env validation rejects a weak key without echoing it', () => {
    assert.throws(() => parseEnv({ GOOGLE_TOKEN_ENCRYPTION_KEY: 'short-secret-key' }), (err: Error) =>
      /GOOGLE_TOKEN_ENCRYPTION_KEY/.test(err.message) && !err.message.includes('short-secret-key'),
    );
    assert.equal(parseEnv({}).GOOGLE_CALENDAR_ID, 'primary');
  });
});

describe('Google Calendar OAuth and API', { skip: !testDatabaseUrl }, () => {
  let server: Server;
  let base: string;
  let adminCookie = '';
  let agentCookie = '';

  const request = async (method: string, path: string, cookie = adminCookie) => {
    const res = await realFetch(base + path, { method, headers: cookie ? { cookie } : {} });
    return { status: res.status, body: (await res.json()) as any };
  };

  async function signIn(email: string, password: string) {
    const res = await realFetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return res.headers.getSetCookie()[0]!.split(';')[0]!;
  }

  /** Starts the flow as the admin; returns the consent URL and the state cookie. */
  async function authorize() {
    const res = await realFetch(`${base}/integrations/google/authorize`, { method: 'POST', headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('google_oauth_state='))!;
    const url = new URL(((await res.json()) as any).data.authorizationUrl);
    return { url, setCookie, cookie: setCookie.split(';')[0]!, state: url.searchParams.get('state')! };
  }

  async function callback(query: Record<string, string>, cookie: string) {
    const res = await realFetch(`${base}/integrations/google/callback?${new URLSearchParams(query)}`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 303);
    return new URL(res.headers.get('location')!);
  }

  const tokenResponse = (extra: object = {}) =>
    json(200, { access_token: 'ya29.access-1', refresh_token: '1//refresh-1', expires_in: 3599, scope: SCOPES.join(' '), token_type: 'Bearer', ...extra });

  async function connect() {
    const { state, cookie } = await authorize();
    google = () => tokenResponse();
    const location = await callback({ state, code: 'auth-code' }, cookie);
    assert.equal(location.searchParams.get('google'), 'connected');
    calls = [];
  }

  const connection = async () => (await pool!.query('SELECT * FROM google_calendar_connection')).rows[0];
  const expireAccessToken = () => pool!.query(`UPDATE google_calendar_connection SET access_token_expires_at = now() - interval '1 minute'`);

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}/api`;
    await prepareTestDatabase(pool!); // refuses a non-_test database; recovers from an interrupted earlier run
    await migrate();
    await pool!.query(
      `INSERT INTO staff_users (email, full_name, role, password_hash) VALUES
         ('cal-admin@example.test', 'Calendar Admin', 'admin', $1), ('cal-agent@example.test', 'Calendar Agent', 'agent', $1)`,
      [await hashPassword('calendar test password')],
    );
    adminCookie = await signIn('cal-admin@example.test', 'calendar test password');
    agentCookie = await signIn('cal-agent@example.test', 'calendar test password');
  });

  beforeEach(async () => {
    calls = [];
    google = () => {
      throw new Error('unexpected Google call');
    };
    await pool!.query('DELETE FROM google_calendar_connection');
    await pool!.query('DELETE FROM google_oauth_states');
  });

  after(async () => {
    server.close();
    // Only once the server confirmed a _test database: after() still runs when before() failed that check.
    try {
      if (isDatabaseVerified()) {
        await pool!.query('DELETE FROM google_calendar_connection');
        await pool!.query(`DELETE FROM staff_users WHERE email LIKE 'cal-%@example.test'`); // cascades to states and sessions
      }
    } finally {
      globalThis.fetch = realFetch;
      await closePool(); // also when the clean-up fails, so the run cannot hang on open connections
    }
  });

  it('authorize asks for offline access with state, PKCE and only calendar scopes', async () => {
    const { url, setCookie, state } = await authorize();
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4000/api/integrations/google/callback');
    assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(state.length >= 43);
    assert.ok(!url.toString().includes('test-client-secret'));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\/api\/integrations\/google/);
    const { rows } = await pool!.query('SELECT state_hash FROM google_oauth_states');
    assert.deepEqual(rows, [{ state_hash: createHash('sha256').update(state).digest('hex') }]); // never the state itself
  });

  it('only admins can connect, test or disconnect; the callback needs no session', async () => {
    for (const [method, path] of [['POST', '/integrations/google/authorize'], ['POST', '/integrations/google/test'], ['DELETE', '/integrations/google']]) {
      assert.equal((await request(method!, path!, agentCookie)).status, 403, path);
      assert.equal((await request(method!, path!, '')).status, 401, path);
    }
    assert.equal((await request('GET', '/integrations/google/status', agentCookie)).status, 200);
    const location = await callback({ state: 'x', code: 'y' }, '');
    assert.equal(location.origin + location.pathname, 'http://localhost:5173/settings');
  });

  it('the callback rejects a missing, mismatched, unknown, expired or reused state', async () => {
    const { state, cookie } = await authorize();
    for (const [query, cookieHeader] of [
      [{ code: 'c' }, cookie],
      [{ state, code: 'c' }, ''],
      [{ state, code: 'c' }, 'google_oauth_state=someone-else'],
      [{ state: 'unknown', code: 'c' }, 'google_oauth_state=unknown'],
    ] as const) {
      const location = await callback(query, cookieHeader);
      assert.equal(location.searchParams.get('reason'), 'CALENDAR_INVALID_STATE');
    }
    await pool!.query(`UPDATE google_oauth_states SET expires_at = now() - interval '1 second'`);
    assert.equal((await callback({ state, code: 'c' }, cookie)).searchParams.get('reason'), 'CALENDAR_INVALID_STATE');
    assert.equal(calls.length, 0); // Google was never asked
    assert.equal(await connection(), undefined);
  });

  it('a successful callback stores encrypted tokens and the state cannot be replayed', async () => {
    const { url, state, cookie } = await authorize();
    google = () => tokenResponse();
    const location = await callback({ state, code: 'auth-code' }, cookie);
    assert.equal(location.toString(), 'http://localhost:5173/settings?google=connected');

    const [exchange] = calls;
    assert.equal(exchange!.url.toString(), TOKEN_URL);
    const sent = form(exchange!);
    assert.equal(sent.grant_type, 'authorization_code');
    assert.equal(sent.code, 'auth-code');
    assert.equal(sent.redirect_uri, 'http://localhost:4000/api/integrations/google/callback');
    assert.equal(createHash('sha256').update(sent.code_verifier!).digest('base64url'), url.searchParams.get('code_challenge'));

    const row = await connection();
    assert.equal(row.status, 'connected');
    const stored = JSON.stringify(row);
    for (const secret of ['ya29.access-1', '1//refresh-1']) assert.ok(!stored.includes(secret), 'token stored in plaintext');
    assert.equal(decrypt(row.refresh_token_enc, 'refresh_token'), '1//refresh-1');

    const status = await request('GET', '/integrations/google/status');
    assert.equal(status.body.data.status, 'connected');
    assert.equal(status.body.data.configured, true);
    for (const secret of ['ya29', '1//refresh', 'test-client-secret', '_enc']) assert.ok(!JSON.stringify(status.body).includes(secret), secret);

    assert.equal((await callback({ state, code: 'auth-code' }, cookie)).searchParams.get('reason'), 'CALENDAR_INVALID_STATE');
  });

  it('the callback reports a declined consent, missing scopes, no refresh token and bad client credentials', async () => {
    const cases: [object | null, string][] = [
      [null, 'CALENDAR_ACCESS_DENIED'],
      [{ scope: SCOPES[0] }, 'CALENDAR_MISSING_SCOPE'],
      [{ refresh_token: undefined }, 'CALENDAR_NO_REFRESH_TOKEN'],
    ];
    for (const [extra, reason] of cases) {
      const { state, cookie } = await authorize();
      google = () => tokenResponse(extra ?? {});
      const location = await callback(extra ? { state, code: 'c' } : { state, error: 'access_denied' }, cookie);
      assert.equal(location.searchParams.get('reason'), reason);
    }
    const { state, cookie } = await authorize();
    google = () => json(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
    assert.equal((await callback({ state, code: 'c' }, cookie)).searchParams.get('reason'), 'CALENDAR_NOT_CONFIGURED');
    assert.equal(await connection(), undefined); // nothing half-connected
  });

  it('calendar calls refuse clearly when nothing is connected', async () => {
    await assert.rejects(calendarService.listBusy({ start: new Date(), end: new Date() }), { code: 'CALENDAR_NOT_CONNECTED' });
    const { status, body } = await request('POST', '/integrations/google/test');
    assert.equal(status, 409);
    assert.equal(body.error.code, 'CALENDAR_NOT_CONNECTED');
    assert.equal((await request('GET', '/integrations/google/status')).body.data.status, 'not_connected');
  });

  it('a valid access token is reused; an expired one is refreshed first', async () => {
    await connect();
    google = (call) => {
      assert.equal(call.headers.Authorization, 'Bearer ya29.access-1');
      return json(200, { calendars: { primary: { busy: [{ start: '2026-11-12T09:00:00Z', end: '2026-11-12T10:00:00Z' }] } } });
    };
    const busy = await calendarService.listBusy({ start: new Date('2026-11-12T00:00:00Z'), end: new Date('2026-11-13T00:00:00Z') });
    assert.deepEqual(busy, [{ start: new Date('2026-11-12T09:00:00Z'), end: new Date('2026-11-12T10:00:00Z') }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url.toString(), `${CALENDAR_API}/freeBusy`);
    assert.deepEqual(JSON.parse(calls[0]!.body), { timeMin: '2026-11-12T00:00:00.000Z', timeMax: '2026-11-13T00:00:00.000Z', items: [{ id: 'primary' }] });

    await expireAccessToken();
    calls = [];
    google = (call) => {
      if (call.url.toString() === TOKEN_URL) return json(200, { access_token: 'ya29.access-2', expires_in: 3599 });
      assert.equal(call.headers.Authorization, 'Bearer ya29.access-2');
      return json(200, { calendars: { primary: { busy: [] } } });
    };
    assert.deepEqual(await calendarService.listBusy({ start: new Date(), end: new Date() }), []);
    assert.deepEqual(form(calls[0]!), { grant_type: 'refresh_token', refresh_token: '1//refresh-1', client_id: 'test-client.apps.googleusercontent.com', client_secret: 'test-client-secret' });
    const row = await connection();
    assert.equal(decrypt(row.access_token_enc, 'access_token'), 'ya29.access-2');
    assert.equal(decrypt(row.refresh_token_enc, 'refresh_token'), '1//refresh-1'); // kept when Google does not rotate it
    assert.ok(row.access_token_expires_at > new Date());
  });

  it('a 401 from Calendar forces one refresh and retry', async () => {
    await connect();
    let calendarCalls = 0;
    google = (call) => {
      if (call.url.toString() === TOKEN_URL) return json(200, { access_token: 'ya29.access-3', expires_in: 3599, refresh_token: '1//rotated' });
      calendarCalls += 1;
      return calendarCalls === 1 ? json(401, {}) : json(200, { id: 'evt-1' });
    };
    assert.deepEqual(await calendarService.createEvent({ summary: 'x', start: new Date(), end: new Date() }), { eventId: 'evt-1' });
    assert.equal(calendarCalls, 2);
    assert.equal(decrypt((await connection()).refresh_token_enc, 'refresh_token'), '1//rotated');
  });

  it('a revoked refresh token marks the calendar for reconnection and drops the tokens', async () => {
    await connect();
    await expireAccessToken();
    google = () => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    await assert.rejects(calendarService.deleteEvent('evt-1'), { code: 'CALENDAR_RECONNECT_REQUIRED' });
    const row = await connection();
    assert.equal(row.status, 'reconnect_required');
    assert.equal(row.refresh_token_enc, null);
    assert.equal(row.access_token_enc, null);
    calls = [];
    await assert.rejects(calendarService.deleteEvent('evt-1'), { code: 'CALENDAR_RECONNECT_REQUIRED' });
    assert.equal(calls.length, 0); // no further calls with a dead token
    assert.equal((await request('GET', '/integrations/google/status')).body.data.status, 'reconnect_required');
  });

  it('creates, updates and deletes events with the right requests', async () => {
    await connect();
    const event = { summary: 'Consultation', description: 'Booked via WhatsApp', start: new Date('2026-11-12T09:00:00Z'), end: new Date('2026-11-12T09:30:00Z') };
    google = (call) => (call.method === 'DELETE' ? json(204, null) : json(200, { id: 'evt/1' }));
    assert.deepEqual(await calendarService.createEvent(event), { eventId: 'evt/1' });
    await calendarService.updateEvent('evt/1', { ...event, summary: 'Moved' });
    await calendarService.deleteEvent('evt/1');
    assert.deepEqual(
      calls.map((c) => [c.method, c.url.toString()]),
      [
        ['POST', `${CALENDAR_API}/calendars/primary/events`],
        ['PATCH', `${CALENDAR_API}/calendars/primary/events/evt%2F1`],
        ['DELETE', `${CALENDAR_API}/calendars/primary/events/evt%2F1`],
      ],
    );
    assert.deepEqual(JSON.parse(calls[0]!.body), {
      summary: 'Consultation',
      description: 'Booked via WhatsApp',
      start: { dateTime: '2026-11-12T09:00:00.000Z' },
      end: { dateTime: '2026-11-12T09:30:00.000Z' },
    });
    assert.equal(JSON.parse(calls[1]!.body).summary, 'Moved');
  });

  it('maps Google API errors without echoing them', async () => {
    await connect();
    const any = () => calendarService.updateEvent('evt', { summary: 'x', start: new Date(), end: new Date() });
    const cases: [() => Response, string][] = [
      [() => json(404, { error: { message: 'Not Found' } }), 'CALENDAR_NOT_FOUND'],
      [() => json(410, {}), 'CALENDAR_NOT_FOUND'],
      [() => json(429, {}), 'CALENDAR_RATE_LIMITED'],
      [() => json(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }), 'CALENDAR_RATE_LIMITED'],
      [() => json(403, { error: { errors: [{ reason: 'forbidden' }], message: 'secret detail' } }), 'CALENDAR_FORBIDDEN'],
      [() => json(500, { error: { message: 'secret detail' } }), 'CALENDAR_ERROR'],
    ];
    for (const [reply, code] of cases) {
      google = reply;
      await assert.rejects(any(), (err: any) => err.code === code && !err.message.includes('secret detail'));
    }
    google = () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(any(), { code: 'CALENDAR_UNREACHABLE' });
    google = () => json(200, { calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }] } } });
    await assert.rejects(calendarService.listBusy({ start: new Date(), end: new Date() }), { code: 'CALENDAR_ERROR' });
    google = () => json(410, {});
    await calendarService.deleteEvent('already-gone'); // deleting a deleted event is not an error
  });

  it('the test endpoint makes a real (here mocked) Google read', async () => {
    await connect();
    google = () => json(200, { calendars: { primary: { busy: [{ start: '2026-11-12T09:00:00Z', end: '2026-11-12T10:00:00Z' }] } } });
    const { status, body } = await request('POST', '/integrations/google/test');
    assert.equal(status, 200);
    assert.deepEqual(body.data, { ok: true, calendarId: 'primary', busyPeriodsNext24h: 1 });
  });

  it('disconnect revokes at Google and deletes the tokens', async () => {
    await connect();
    google = () => json(200, {});
    const { body } = await request('DELETE', '/integrations/google');
    assert.deepEqual(body.data, { revokedAtGoogle: true });
    assert.equal(calls[0]!.url.toString(), REVOKE_URL);
    assert.deepEqual(form(calls[0]!), { token: '1//refresh-1' });
    assert.equal(await connection(), undefined);

    await connect();
    google = () => {
      throw new TypeError('fetch failed');
    };
    assert.deepEqual((await request('DELETE', '/integrations/google')).body.data, { revokedAtGoogle: false });
    assert.equal(await connection(), undefined); // removed locally even when Google is unreachable
  });
});
