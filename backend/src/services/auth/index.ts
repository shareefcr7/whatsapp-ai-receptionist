import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import { query } from '../../database/pool.ts';
import { AppError } from '../../types/errors.ts';

export interface Staff {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'agent';
}

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, length: number, options: ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 }; // OWASP's recommended minimum
const KEY_LENGTH = 64;
const scryptOptions = (s: typeof SCRYPT) => ({ ...s, maxmem: 256 * s.N * s.r });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, scryptOptions(SCRYPT));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Cost settings live in the stored hash, so they can be raised without breaking existing passwords. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, scryptOptions(params));
  return timingSafeEqual(actual, expected);
}

// Unknown emails still pay for one hash, so response time does not reveal who has an account.
let decoyHash: Promise<string> | undefined;
const decoy = () => (decoyHash ??= hashPassword(randomBytes(32).toString('hex')));

// ponytail: in-memory and per-process, resets on restart. Move to PostgreSQL if the API ever runs as several instances.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_ACCOUNT = 5;
const MAX_FAILURES_PER_IP = 30;
const failures = new Map<string, { count: number; resetAt: number }>();

function tooManyFailures(key: string, limit: number): boolean {
  const entry = failures.get(key);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= limit);
}

function recordFailure(key: string) {
  const now = Date.now();
  for (const [k, entry] of failures) if (entry.resetAt <= now) failures.delete(k);
  const entry = failures.get(key);
  if (entry) entry.count += 1;
  else failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
}

const SESSION_TTL_MS = 12 * 60 * 60_000; // one working day, then sign in again
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Throws 401 for any bad login, with one message, so an attacker cannot tell which part was wrong. */
export async function login(email: string, password: string, ip: string) {
  const normalized = email.toLowerCase();
  const accountKey = `account:${ip}:${normalized}`;
  const ipKey = `ip:${ip}`;
  if (tooManyFailures(accountKey, MAX_FAILURES_PER_ACCOUNT) || tooManyFailures(ipKey, MAX_FAILURES_PER_IP)) {
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again in 15 minutes.');
  }

  const [row] = await query<Staff & { passwordHash: string | null }>(
    `SELECT id, email, full_name AS "fullName", role, password_hash AS "passwordHash"
     FROM staff_users WHERE lower(email) = $1 AND is_active`,
    [normalized],
  );
  const verified = await verifyPassword(password, row?.passwordHash ?? (await decoy()));
  if (!row?.passwordHash || !verified) {
    recordFailure(accountKey);
    recordFailure(ipKey);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  }
  failures.delete(accountKey);

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query('DELETE FROM staff_sessions WHERE expires_at <= now()');
  await query('INSERT INTO staff_sessions (token_hash, staff_id, expires_at) VALUES ($1, $2, $3)', [hashToken(token), row.id, expiresAt]);
  const { passwordHash: _omit, ...staff } = row;
  return { token, expiresAt, staff: staff as Staff };
}

export async function staffForSession(token: string): Promise<Staff | null> {
  const [row] = await query<Staff & Record<string, unknown>>(
    `SELECT u.id, u.email, u.full_name AS "fullName", u.role
     FROM staff_sessions s JOIN staff_users u ON u.id = s.staff_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
    [hashToken(token)],
  );
  return row ?? null;
}

export async function endSession(token: string): Promise<void> {
  await query('DELETE FROM staff_sessions WHERE token_hash = $1', [hashToken(token)]);
}
