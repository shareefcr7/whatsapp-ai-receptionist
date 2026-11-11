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
