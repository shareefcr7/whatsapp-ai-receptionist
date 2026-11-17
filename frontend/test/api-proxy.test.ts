// The Vercel API proxy (api/proxy.ts). Vercel's IP resolution and the backend are mocked: no network requests.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { backendOrigin, proxy } from '../../api/proxy.ts';
import type { ProxyDeps } from '../../api/proxy.ts';

const SECRET = 'proxy-secret-'.padEnd(48, 'x');
const BACKEND = 'https://backend.example.test';
const DEPLOYED = { VERCEL: '1', VERCEL_ENV: 'production' };

interface Sent {
  url: string;
  init: RequestInit;
}

function setup(t: TestContext, over: { env?: Record<string, string | undefined>; ip?: string | undefined; respond?: () => Response | Promise<Response> } = {}) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
  const deps: ProxyDeps = {
    env: { ...DEPLOYED, BACKEND_URL: BACKEND, BACKEND_PROXY_SECRET: SECRET, ...over.env },
    clientIp: () => ('ip' in over ? over.ip : '203.0.113.9'),
    fetch: async (url, init) => {
      sent.push({ url: String(url), init: init ?? {} });
      return over.respond ? over.respond() : new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  };
  return { deps, sent, logs };
}

const req = (path: string, init?: RequestInit) => new Request(`https://dashboard.example.test${path}`, init);
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('API proxy configuration (fails closed)', () => {
  for (const [name, env] of [
    ['BACKEND_URL missing', { BACKEND_URL: undefined }],
    ['BACKEND_URL blank', { BACKEND_URL: '' }],
    ['BACKEND_URL not a URL', { BACKEND_URL: 'backend' }],
    ['BACKEND_URL plain http when deployed', { BACKEND_URL: 'http://backend.example.test' }],
    ['BACKEND_URL loopback http when deployed', { BACKEND_URL: 'http://localhost:4000' }],
    ['BACKEND_URL with a path', { BACKEND_URL: `${BACKEND}/api` }],
    ['BACKEND_URL with credentials', { BACKEND_URL: 'https://user:pass@backend.example.test' }],
    ['BACKEND_PROXY_SECRET missing', { BACKEND_PROXY_SECRET: undefined }],
    ['BACKEND_PROXY_SECRET too short', { BACKEND_PROXY_SECRET: 'short' }],
    ['BACKEND_PROXY_SECRET with a space', { BACKEND_PROXY_SECRET: `${SECRET} x` }],
  ] as const) {
    it(`${name}: 503, nothing forwarded, no secret or URL in the log`, async (t) => {
      const { deps, sent, logs } = setup(t, { env });
      const res = await proxy(req('/api/auth/me'), deps);
      assert.equal(res.status, 503);
      assert.equal(await errorCode(res), 'PROXY_NOT_CONFIGURED');
      assert.equal(sent.length, 0);
      assert.ok(logs.every((l) => !l.includes(SECRET) && !l.includes('backend.example')));
    });
  }

  it('accepts https anywhere, and loopback http only outside a deployment', () => {
    assert.equal(backendOrigin({ ...DEPLOYED, BACKEND_URL: `${BACKEND}/` }), BACKEND);
    assert.equal(backendOrigin({ BACKEND_URL: 'http://localhost:4000' }), 'http://localhost:4000');
    assert.equal(backendOrigin({ VERCEL: '1', VERCEL_ENV: 'development', BACKEND_URL: 'http://127.0.0.1:4000' }), 'http://127.0.0.1:4000');
    assert.equal(backendOrigin({ VERCEL: '1', VERCEL_ENV: 'preview', BACKEND_URL: 'http://127.0.0.1:4000' }), null);
    assert.equal(backendOrigin({ BACKEND_URL: 'http://backend.example.test' }), null);
  });

  for (const ip of [undefined, '', 'not-an-ip', '203.0.113.9, 198.51.100.7']) {
    it(`no valid platform client IP (${JSON.stringify(ip)}): 503, nothing forwarded`, async (t) => {
      const { deps, sent } = setup(t, { ip });
      const res = await proxy(req('/api/auth/me'), deps);
      assert.equal(res.status, 503);
      assert.equal(await errorCode(res), 'PROXY_CLIENT_IP_UNAVAILABLE');
      assert.equal(sent.length, 0);
    });
  }
});

describe('API proxy forwarding', () => {
  it('preserves method, path, query string and body bytes, and replaces identity headers', async (t) => {
    const { deps, sent } = setup(t);
    const body = new Uint8Array([0x7b, 0x00, 0xff, 0xfe, 0x22, 0x7d]); // not valid UTF-8: must survive byte for byte
    const res = await proxy(
      req('/api/auth/login?next=%2Fsettings&a=1&a=2', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          cookie: 'receptionist_session=abc; other=1',
          origin: 'https://dashboard.example.test',
          'x-forwarded-for': '198.51.100.7',
          'x-forwarded-host': 'evil.example',
          'x-real-ip': '198.51.100.7',
          'x-client-ip': '198.51.100.7',
          'x-proxy-auth': 'guess',
          'x-vercel-id': 'spoofed',
          forwarded: 'for=198.51.100.7',
          'true-client-ip': '198.51.100.7',
          'cf-connecting-ip': '198.51.100.7',
        },
      }),
      deps,
    );
    assert.equal(res.status, 200);
    const [call] = sent;
    assert.equal(call!.url, `${BACKEND}/api/auth/login?next=%2Fsettings&a=1&a=2`);
    assert.equal(call!.init.method, 'POST');
    assert.equal(call!.init.redirect, 'manual');
    assert.deepEqual(new Uint8Array(call!.init.body as ArrayBuffer), body);
    const h = call!.init.headers as Headers;
    assert.equal(h.get('x-client-ip'), '203.0.113.9', 'the platform IP, not the browser-supplied one');
    assert.equal(h.get('x-proxy-auth'), SECRET);
    assert.equal(h.get('cookie'), 'receptionist_session=abc; other=1');
    assert.equal(h.get('origin'), 'https://dashboard.example.test');
    assert.equal(h.get('content-type'), 'application/json');
    for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'x-vercel-id', 'forwarded', 'true-client-ip', 'cf-connecting-ip', 'host']) {
      assert.equal(h.get(name), null, `${name} is not forwarded`);
    }
  });

  it('sends no body for GET, and forwards /api itself', async (t) => {
    const { deps, sent } = setup(t);
    await proxy(req('/api'), deps);
    assert.equal(sent[0]!.url, `${BACKEND}/api`);
    assert.equal(sent[0]!.init.method, 'GET');
    assert.equal(sent[0]!.init.body, undefined);
  });

  it('refuses paths outside /api', async (t) => {
    const { deps, sent } = setup(t);
    assert.equal((await proxy(req('/apiary'), deps)).status, 404);
    assert.equal(sent.length, 0);
  });

  it('preserves status, body, content type, other headers and every Set-Cookie', async (t) => {
    const { deps } = setup(t, {
      respond: () => {
        const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-encoding': 'gzip' });
        headers.append('set-cookie', 'receptionist_session=tok; Path=/; HttpOnly; Secure; SameSite=Strict');
        headers.append('set-cookie', 'google_oauth_state=; Path=/api/integrations/google; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        return new Response('{"success":false,"error":{"code":"INVALID_CREDENTIALS"}}', { status: 401, headers });
      },
    });
    const res = await proxy(req('/api/auth/login', { method: 'POST', body: '{}' }), deps);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-encoding'), null, 'fetch already decoded the body');
    assert.deepEqual(res.headers.getSetCookie(), [
      'receptionist_session=tok; Path=/; HttpOnly; Secure; SameSite=Strict',
      'google_oauth_state=; Path=/api/integrations/google; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ]);
    assert.equal(await res.text(), '{"success":false,"error":{"code":"INVALID_CREDENTIALS"}}');
  });

  it('passes a redirect through to the browser unchanged', async (t) => {
    const { deps } = setup(t, { respond: () => new Response(null, { status: 303, headers: { location: 'https://dashboard.example.test/settings?google=connected' } }) });
    const res = await proxy(req('/api/integrations/google/callback?code=c&state=s'), deps);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'https://dashboard.example.test/settings?google=connected');
  });

  it('backend unreachable: 502 with a generic message, no details, secret, IP or URL', async (t) => {
    const { deps, logs } = setup(t, {
      respond: () => {
        throw new TypeError(`fetch failed: connect ECONNREFUSED ${BACKEND} ${SECRET}`);
      },
    });
    const res = await proxy(req('/api/auth/me', { headers: { cookie: 'receptionist_session=abc' } }), deps);
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.match(text, /BACKEND_UNAVAILABLE/);
    for (const leak of [SECRET, 'backend.example', 'ECONNREFUSED', '203.0.113.9', 'abc']) {
      assert.ok(!text.includes(leak) && logs.every((l) => !l.includes(leak)), `${leak} leaked`);
    }
  });

  it('backend timeout: 504', async (t) => {
    const { deps } = setup(t, {
      respond: () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    });
    const res = await proxy(req('/api/auth/me'), deps);
    assert.equal(res.status, 504);
    assert.equal(await errorCode(res), 'BACKEND_TIMEOUT');
  });

  it('the default client-IP source is Vercel\'s ipAddress (x-real-ip, set by the platform)', async () => {
    const { ipAddress } = await import('@vercel/functions/headers');
    assert.equal(ipAddress(new Request('https://x.test', { headers: { 'x-real-ip': '203.0.113.9' } })), '203.0.113.9');
  });
});
