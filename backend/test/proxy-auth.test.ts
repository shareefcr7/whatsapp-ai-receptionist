// Step 10.14: only the Vercel proxy (shared secret) may reach the API and supply the client IP. The pool's query method
// is mocked: nothing connects to a database (the URL below points at a closed local port), and Meta is never called.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it, mock } from 'node:test';
import type { Request, RequestHandler } from 'express';

const SECRET = 'proxy-secret-'.padEnd(48, 'x');
const APP_SECRET = 'a'.repeat(32);
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/proxy_auth_test',
  VERCEL_PROXY_SECRET: SECRET,
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_VERIFY_TOKEN: 'verify-token-for-tests',
  AI_AUTO_REPLY_ENABLED: 'false',
});
for (const key of ['OPENAI_API_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']) delete process.env[key];

const { app } = await import('../src/app.ts');
const { pool } = await import('../src/database/pool.ts');
const { parseEnv } = await import('../src/config/env.ts');
const { proxyAuth } = await import('../src/middleware/auth.ts');

let server: Server;
let base: string;
before(async () => {
  // No staff and no sessions: every lookup finds nothing. Anything else would hit the closed port and fail loudly.
  mock.method(pool!, 'query', async () => ({ rows: [] }));
  await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())));
  const address = server.address();
  assert(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});
after(() => {
  server.close();
  mock.restoreAll();
});

const viaProxy = (ip = '203.0.113.9') => ({ 'x-proxy-auth': SECRET, 'x-client-ip': ip });
const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let code: string | undefined;
  try {
    code = JSON.parse(text).error?.code;
  } catch {}
  return { status: res.status, code, text };
};

describe('proxy authentication', () => {
  it('correct secret and client IP: the request reaches the normal session check', async () => {
    for (const ip of ['203.0.113.9', '2001:db8::1']) {
      const r = await call('/api/auth/me', { headers: viaProxy(ip) });
      assert.deepEqual([r.status, r.code], [401, 'UNAUTHENTICATED'], ip);
    }
  });

  const denied = async (headers: Record<string, string>, path = '/api/auth/me', init: RequestInit = {}) => {
    const r = await call(path, { ...init, headers });
    assert.deepEqual([r.status, r.code], [403, 'PROXY_AUTH_REQUIRED'], `${init.method ?? 'GET'} ${path} ${JSON.stringify(headers)}`);
    assert.ok(!r.text.includes(SECRET));
  };

  it('missing secret', () => denied({ 'x-client-ip': '203.0.113.9' }));
  it('incorrect secret of the same length', () => denied({ ...viaProxy(), 'x-proxy-auth': SECRET.slice(0, -1) + 'y' }));
  it('unequal secret lengths (shorter, longer, empty)', async () => {
    await denied({ ...viaProxy(), 'x-proxy-auth': SECRET.slice(0, 10) });
    await denied({ ...viaProxy(), 'x-proxy-auth': SECRET + 'extra' });
    await denied({ ...viaProxy(), 'x-proxy-auth': '' });
  });
  it('missing client IP', () => denied({ 'x-proxy-auth': SECRET }));
  it('invalid client IP', async () => {
    for (const ip of ['', 'not-an-ip', '999.1.1.1', '203.0.113.9, 198.51.100.7', '203.0.113.9:443']) await denied({ ...viaProxy(), 'x-client-ip': ip });
  });
  it('spoofed X-Forwarded-For, X-Real-IP or X-Vercel-ID without the secret', async () => {
    await denied({ 'x-forwarded-for': '203.0.113.9' });
    await denied({ 'x-real-ip': '203.0.113.9', 'x-vercel-id': 'fra1::abc', 'x-vercel-forwarded-for': '203.0.113.9' });
  });
  it('a browser-supplied X-Client-IP without the secret', () => denied({ 'x-client-ip': '198.51.100.7' }));

  it('direct requests to protected endpoints are refused, including login, logout and the Google callback', async () => {
    const post = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } };
    await denied({}, '/api/auth/login', post);
    await denied({}, '/api/auth/logout', post);
    await denied({}, '/api/integrations/google/callback?code=c&state=s');
    for (const path of ['/api', '/api/conversations', '/api/health/database', '/api/nope', '/api/HEALTH', '/api/health/', '/']) await denied({}, path);
  });

  it('without a secret: production refuses everything protected, development falls back to the socket address', () => {
    const run = (handler: RequestHandler, headers: Record<string, string> = {}) => {
      const req = { method: 'GET', path: '/api/auth/me', ip: '127.0.0.1', get: (h: string) => headers[h.toLowerCase()] } as unknown as Request;
      let passed = false;
      try {
        handler(req, {} as never, () => (passed = true));
      } catch (err) {
        return { passed, code: (err as { code?: string }).code, clientIp: req.clientIp };
      }
      return { passed, clientIp: req.clientIp };
    };
    assert.deepEqual(run(proxyAuth(undefined, true), { 'x-forwarded-for': '203.0.113.9' }), { passed: false, code: 'PROXY_AUTH_REQUIRED', clientIp: undefined });
    assert.deepEqual(run(proxyAuth(undefined, false), { 'x-forwarded-for': '203.0.113.9', 'x-client-ip': '203.0.113.9' }), { passed: true, clientIp: '127.0.0.1' });
  });

  it('production cannot start without a valid VERCEL_PROXY_SECRET, and the error never shows the value', () => {
    const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://u@db.example.test/x', FRONTEND_URL: 'https://dashboard.example.test' };
    assert.throws(() => parseEnv(prod), /VERCEL_PROXY_SECRET: is required in production/);
    assert.throws(() => parseEnv({ ...prod, VERCEL_PROXY_SECRET: '' }), /VERCEL_PROXY_SECRET: is required in production/);
    assert.throws(() => parseEnv({ ...prod, VERCEL_PROXY_SECRET: 'too-short-secret' }), (err: Error) => !err.message.includes('too-short-secret') && /VERCEL_PROXY_SECRET/.test(err.message));
    assert.throws(() => parseEnv({ ...prod, VERCEL_PROXY_SECRET: `${SECRET} with spaces` }), /VERCEL_PROXY_SECRET/);
    assert.equal(parseEnv({ ...prod, VERCEL_PROXY_SECRET: SECRET }).VERCEL_PROXY_SECRET, SECRET);
  });
});

describe('public routes keep their own protections', () => {
  it('health answers directly', async () => {
    assert.equal((await call('/api/health')).status, 200);
    assert.equal((await fetch(`${base}/api/health`, { method: 'HEAD' })).status, 200);
  });

  it('webhook verification still needs the verify token', async () => {
    assert.equal((await call('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc')).status, 403);
    const ok = await call('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token-for-tests&hub.challenge=abc');
    assert.deepEqual([ok.status, ok.text], [200, 'abc']);
  });

  it('webhook deliveries still need Meta\'s signature, and a valid one works directly', async () => {
    const body = JSON.stringify({ object: 'page', entry: [] });
    const sign = (b: string) => `sha256=${createHmac('sha256', APP_SECRET).update(b).digest('hex')}`;
    const post = (headers: Record<string, string>) => call('/api/webhooks/whatsapp', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
    assert.deepEqual([(await post({})).status, (await post({})).code], [401, 'INVALID_SIGNATURE']);
    assert.equal((await post({ 'x-hub-signature-256': sign('other body') })).code, 'INVALID_SIGNATURE');
    // The proxy secret is no substitute for the signature.
    assert.equal((await post(viaProxy())).code, 'INVALID_SIGNATURE');
    assert.equal((await post({ 'x-hub-signature-256': sign(body) })).status, 200);
  });
});

describe('login rate limit uses the verified client IP', () => {
  const login = (ip: string, extra: Record<string, string> = {}) =>
    call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...viaProxy(ip), ...extra },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong password' }),
    });

  it('two client IPs get separate keys, and forwarded headers cannot change the key', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login('198.51.100.1')).code, 'INVALID_CREDENTIALS');
    assert.equal((await login('198.51.100.1')).code, 'TOO_MANY_ATTEMPTS');
    // Spoofed forwarding headers do not move the attacker to a fresh key.
    assert.equal((await login('198.51.100.1', { 'x-forwarded-for': '192.0.2.77', 'x-real-ip': '192.0.2.77' })).code, 'TOO_MANY_ATTEMPTS');
    // Another user on another network is unaffected.
    assert.equal((await login('198.51.100.2')).code, 'INVALID_CREDENTIALS');
  });
});
