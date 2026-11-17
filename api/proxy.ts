// Same-origin API proxy (Vercel Function). The dashboard calls /api on its own domain, so the SameSite=Strict session
// cookie works, and this forwards each request to BACKEND_URL. It is the only thing the backend trusts for the client's
// address: it sends the platform-derived IP in X-Client-IP, authenticated by the shared secret in X-Proxy-Auth.
// Never log request bodies, cookies, IP addresses, the backend URL or the secret here.
import { ipAddress } from '@vercel/functions/headers';
import { isIP } from 'node:net';

type Env = Record<string, string | undefined>;
export interface ProxyDeps {
  env: Env;
  clientIp: (request: Request) => string | undefined;
  fetch: typeof fetch;
}

/** Under the function's maxDuration (60s, vercel.json). A staff reply's WhatsApp send can take ~46s. */
const UPSTREAM_TIMEOUT_MS = 55_000;
/** Same rule as the backend's VERCEL_PROXY_SECRET: header-safe and long enough not to be guessed. */
const SECRET_PATTERN = /^[\x21-\x7e]{32,}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Never forwarded from the browser: hop-by-hop headers, and every header that could be read as the client's identity
// or as proxy authentication. fetch sets Host and Content-Length itself.
const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect',
  'content-length', 'accept-encoding', 'proxy-authorization', 'forwarded', 'via', 'x-real-ip', 'x-client-ip',
  'x-proxy-auth', 'true-client-ip', 'cf-connecting-ip', 'x-cluster-client-ip', 'fastly-client-ip',
]);
const DROP_REQUEST_PREFIXES = ['x-forwarded-', 'x-vercel-', 'x-middleware-'];
// fetch has already decoded the body, so these no longer describe it. Set-Cookie is copied separately, one per cookie.
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie']);

const fail = (status: number, code: string, message: string) =>
  Response.json({ success: false, error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });

/** The backend origin, or null if BACKEND_URL is unusable. HTTPS only, except a loopback URL outside a deployment. */
export function backendOrigin(env: Env): string | null {
  if (!env.BACKEND_URL) return null;
  let url: URL;
  try {
    url = new URL(env.BACKEND_URL);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  if (url.protocol === 'https:') return url.origin;
  const deployed = Boolean(env.VERCEL) && env.VERCEL_ENV !== 'development';
  return url.protocol === 'http:' && !deployed && LOOPBACK.has(url.hostname) ? url.origin : null;
}

const defaults: ProxyDeps = { env: process.env, clientIp: (request) => ipAddress(request), fetch: (...args) => fetch(...args) };

export async function proxy(request: Request, deps: ProxyDeps = defaults): Promise<Response> {
  const origin = backendOrigin(deps.env);
  const secret = deps.env.BACKEND_PROXY_SECRET;
  // Fail closed: a deployment without its own configuration (e.g. a Preview) reaches no backend at all.
  if (!origin || !secret || !SECRET_PATTERN.test(secret)) {
    console.error('API proxy: BACKEND_URL or BACKEND_PROXY_SECRET is missing or invalid');
    return fail(503, 'PROXY_NOT_CONFIGURED', 'The service is not available.');
  }
  // Read before any header is dropped. Vercel sets this itself; a client cannot supply it.
  const clientIp = deps.clientIp(request);
  if (!clientIp || isIP(clientIp) === 0) {
    console.error('API proxy: the platform supplied no valid client address');
    return fail(503, 'PROXY_CLIENT_IP_UNAVAILABLE', 'The service is not available.');
  }
  const { pathname, search } = new URL(request.url);
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return fail(404, 'NOT_FOUND', 'Not found.');

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!DROP_REQUEST.has(name) && !DROP_REQUEST_PREFIXES.some((p) => name.startsWith(p))) headers.append(name, value);
  }
  headers.set('x-client-ip', clientIp);
  headers.set('x-proxy-auth', secret);

  let upstream: Response;
  try {
    upstream = await deps.fetch(origin + pathname + search, {
      method: request.method,
      headers,
      // Exact bytes: the WhatsApp webhook signature covers the raw body.
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
      redirect: 'manual', // the Google callback's 303 belongs to the browser
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = (err as Error | undefined)?.name === 'TimeoutError';
    console.error(`API proxy: backend ${timedOut ? 'timed out' : 'unreachable'}`);
    return timedOut
      ? fail(504, 'BACKEND_TIMEOUT', 'The service took too long to respond.')
      : fail(502, 'BACKEND_UNAVAILABLE', 'The service is unreachable.');
  }

  const out = new Headers();
  for (const [name, value] of upstream.headers) if (!DROP_RESPONSE.has(name)) out.append(name, value);
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export default { fetch: (request: Request) => proxy(request) };
