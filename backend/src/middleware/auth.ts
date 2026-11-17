import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { CookieOptions, Request, RequestHandler } from 'express';
import { allowedOrigins, env } from '../config/env.ts';
import { isDatabaseConfigured, requirePool } from '../database/pool.ts';
import { staffForSession } from '../services/auth/index.ts';
import { AppError } from '../types/errors.ts';

const SESSION_COOKIE = 'receptionist_session';

const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: env.NODE_ENV === 'production',
  path: '/',
};

export const sessionCookie = {
  name: SESSION_COOKIE,
  read: (req: Request) => req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1],
  options: (expires: Date): CookieOptions => ({ ...cookieOptions, expires }),
  clearOptions: cookieOptions,
};

declare global {
  namespace Express {
    interface Request {
      /** The browser's address as the Vercel proxy saw it, set by requireProxy. Never read from forwarding headers. */
      clientIp?: string;
    }
  }
}

// Reachable without the proxy: Meta calls the webhook itself (it has its own token and signature checks), and
// Render's health check calls /api/health. Exact method and path only; anything else needs the proxy.
const DIRECT_ROUTES = new Set(['GET /api/health', 'HEAD /api/health', 'GET /api/webhooks/whatsapp', 'POST /api/webhooks/whatsapp']);
// Hashing first gives both sides the same length, so timingSafeEqual never throws and the length does not leak.
const digest = (value: string) => createHash('sha256').update(value).digest();
const directAccess = () => new AppError(403, 'PROXY_AUTH_REQUIRED', 'Use the dashboard address.');

/**
 * Only the Vercel proxy, proven by the shared secret, may tell the backend the client's IP (X-Client-IP).
 * X-Forwarded-For, X-Real-IP and X-Vercel-* are never trusted. Without a secret (local development and tests only:
 * production refuses to start without one) the socket address is used, as before.
 */
export function proxyAuth(secret: string | undefined, production: boolean): RequestHandler {
  const expected = secret ? digest(secret) : undefined;
  return (req, _res, next) => {
    if (DIRECT_ROUTES.has(`${req.method} ${req.path}`)) return next();
    if (!expected) {
      if (production) throw directAccess();
      req.clientIp = req.ip ?? 'unknown';
      return next();
    }
    const auth = req.get('x-proxy-auth');
    const ip = req.get('x-client-ip');
    if (!auth || !timingSafeEqual(digest(auth), expected) || !ip || isIP(ip) === 0) throw directAccess();
    req.clientIp = ip;
    next();
  };
}

export const requireProxy = proxyAuth(env.VERCEL_PROXY_SECRET, env.NODE_ENV === 'production');

/** Defence in depth with SameSite: a browser write from another site is refused. Non-browser clients send no Origin. */
export const rejectForeignOrigin: RequestHandler = (req, _res, next) => {
  const { origin } = req.headers;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && !allowedOrigins.includes(origin)) {
    throw new AppError(403, 'FORBIDDEN_ORIGIN', 'This origin may not make changes.');
  }
  next();
};

export const requireAuth: RequestHandler = async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // No database means no records to protect, and every write still fails with 503.
  // Production refuses to start without DATABASE_URL, so this only applies to local development.
  if (!isDatabaseConfigured) return next();
  const token = sessionCookie.read(req);
  const staff = token ? await staffForSession(token) : null;
  if (!staff) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in.');
  res.locals.staff = staff;
  next();
};

export const requireAdmin: RequestHandler = (_req, res, next) => {
  requirePool();
  if (res.locals.staff?.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only an admin can make this change.');
  next();
};
