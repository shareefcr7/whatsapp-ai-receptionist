import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.ts';
import { query } from '../../database/pool.ts';
import { AppError } from '../../types/errors.ts';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
// Events read/write, plus free/busy. Nothing else: no access to contacts, mail or other calendars' details.
export const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'];
const STATE_TTL_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 60_000; // refresh a minute early, so a token never expires mid-request

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// --- Configuration -------------------------------------------------------------------------------

const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_TOKEN_ENCRYPTION_KEY'] as const;

/** Variable names only, never values. */
export const missingConfig = () => REQUIRED.filter((key) => !env[key]);

function requireConfig() {
  const missing = missingConfig();
  if (missing.length) throw new AppError(503, 'CALENDAR_NOT_CONFIGURED', `Google Calendar is not configured. Missing: ${missing.join(', ')}.`);
  return { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, redirectUri: env.GOOGLE_REDIRECT_URI! };
}

// --- Encryption at rest: AES-256-GCM, so a tampered or wrong-key ciphertext fails instead of decrypting to garbage.

export function encrypt(plain: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(env.GOOGLE_TOKEN_ENCRYPTION_KEY!, 'base64'), iv);
  cipher.setAAD(Buffer.from(purpose)); // a refresh token cannot be swapped in where an access token is expected
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(stored: string, purpose: string): string {
  try {
    const [version, iv, tag, data] = stored.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('bad format');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(env.GOOGLE_TOKEN_ENCRYPTION_KEY!, 'base64'), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw reconnectRequired('Stored Google tokens cannot be decrypted (was GOOGLE_TOKEN_ENCRYPTION_KEY changed?). Reconnect Google Calendar.');
  }
}

// --- Errors --------------------------------------------------------------------------------------

const notConnected = () => new AppError(409, 'CALENDAR_NOT_CONNECTED', 'Google Calendar is not connected. An admin can connect it in Settings.');
const reconnectRequired = (message = 'Google Calendar access was revoked or expired. An admin must reconnect it in Settings.') =>
  new AppError(409, 'CALENDAR_RECONNECT_REQUIRED', message);
export const unreachable = () => new AppError(503, 'CALENDAR_UNREACHABLE', 'Could not reach Google (network error or timeout).');

/** Google token endpoint. Its responses are never logged or echoed: they carry tokens. */
async function tokenRequest(params: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw unreachable();
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  return { ok: res.ok && Boolean(body.access_token), status: res.status, body };
}

function tokenError(status: number, error: string | undefined): AppError {
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return new AppError(503, 'CALENDAR_NOT_CONFIGURED', 'Google rejected the client ID or secret. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
  if (error === 'invalid_grant') return new AppError(400, 'CALENDAR_INVALID_GRANT', 'The Google authorization code was invalid or already used. Try connecting again.');
  if (error === 'redirect_uri_mismatch') return new AppError(503, 'CALENDAR_NOT_CONFIGURED', 'GOOGLE_REDIRECT_URI does not match Google Cloud Console.');
  return new AppError(502, 'CALENDAR_ERROR', `Google token request failed (HTTP ${status}).`);
}

// --- OAuth flow ----------------------------------------------------------------------------------

export const STATE_COOKIE = 'google_oauth_state';

/** Returns the Google consent URL and the state, which the caller also puts in a cookie to bind the flow to this browser. */
export async function startAuthorization(staffId: string): Promise<{ authorizationUrl: string; state: string }> {
  const { clientId, redirectUri } = requireConfig();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  await query('DELETE FROM google_oauth_states WHERE expires_at < now()');
  await query('INSERT INTO google_oauth_states (state_hash, staff_id, code_verifier, expires_at) VALUES ($1, $2, $3, $4)', [
    sha256(state),
    staffId,
    verifier,
    new Date(Date.now() + STATE_TTL_MS),
  ]);
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // Google only issues a refresh token on consent, so ask every time
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return { authorizationUrl: url.toString(), state };
}

/**
 * Single use: the state row is deleted whether or not the rest succeeds.
 * `cookieState` must equal `state`, so a link started in another browser cannot be completed here.
 */
export async function completeAuthorization(state: string | undefined, cookieState: string | undefined, code: string | undefined): Promise<void> {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const invalid = new AppError(400, 'CALENDAR_INVALID_STATE', 'The connection request expired or did not start in this browser. Try again.');
  if (!state || !cookieState || state !== cookieState) throw invalid;
  const [row] = await query<{ staffId: string; verifier: string; live: boolean }>(
    `DELETE FROM google_oauth_states WHERE state_hash = $1
     RETURNING staff_id AS "staffId", code_verifier AS verifier, expires_at > now() AS live`,
    [sha256(state)],
  );
  if (!row?.live) throw invalid;
  if (!code) throw new AppError(400, 'CALENDAR_INVALID_GRANT', 'Google did not return an authorization code.');

  const { ok, status, body } = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: row.verifier,
  });
  if (!ok) throw tokenError(status, body.error);
  const granted = (body.scope ?? '').split(' ');
  if (!SCOPES.every((s) => granted.includes(s))) {
    throw new AppError(400, 'CALENDAR_MISSING_SCOPE', 'Calendar permissions were not granted. Connect again and allow every requested permission.');
  }
  if (!body.refresh_token) throw new AppError(502, 'CALENDAR_NO_REFRESH_TOKEN', 'Google did not issue a refresh token. Connect again.');

  await query(
    `INSERT INTO google_calendar_connection
       (id, status, refresh_token_enc, access_token_enc, access_token_expires_at, scopes, connected_by, connected_at)
     VALUES (true, 'connected', $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET status = 'connected', refresh_token_enc = $1, access_token_enc = $2,
       access_token_expires_at = $3, scopes = $4, connected_by = $5, connected_at = now()`,
    [
      encrypt(body.refresh_token, 'refresh_token'),
      encrypt(body.access_token!, 'access_token'),
      new Date(Date.now() + (body.expires_in ?? 0) * 1000),
      granted.join(' '),
      row.staffId,
    ],
  );
}

// --- Tokens in use -------------------------------------------------------------------------------

interface ConnectionRow {
  status: 'connected' | 'reconnect_required';
  refreshTokenEnc: string | null;
  accessTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string;
  connectedAt: Date;
}

const loadConnection = async () =>
  (
    await query<ConnectionRow & Record<string, unknown>>(
      `SELECT status, refresh_token_enc AS "refreshTokenEnc", access_token_enc AS "accessTokenEnc",
              access_token_expires_at AS "accessTokenExpiresAt", scopes, connected_at AS "connectedAt"
       FROM google_calendar_connection`,
    )
  )[0];

/** Google said the refresh token is dead: drop the tokens so nothing keeps using them. */
const markReconnectRequired = () =>
  query(`UPDATE google_calendar_connection SET status = 'reconnect_required', refresh_token_enc = NULL, access_token_enc = NULL, access_token_expires_at = NULL`);

/**
 * A valid access token, refreshed when within a minute of expiry or when `force` is set (after a 401).
 * ponytail: two simultaneous refreshes both succeed and the last write wins; fine for one API process.
 */
export async function getAccessToken(force = false): Promise<string> {
  const { clientId, clientSecret } = requireConfig();
  const row = await loadConnection();
  if (!row) throw notConnected();
  if (row.status !== 'connected' || !row.refreshTokenEnc) throw reconnectRequired();
  if (!force && row.accessTokenEnc && row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() - EXPIRY_MARGIN_MS > Date.now()) {
    return decrypt(row.accessTokenEnc, 'access_token');
  }
  const { ok, status, body } = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: decrypt(row.refreshTokenEnc, 'refresh_token'),
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (!ok && body.error === 'invalid_grant') {
    await markReconnectRequired();
    throw reconnectRequired();
  }
  if (!ok) throw tokenError(status, body.error);
  await query(
    `UPDATE google_calendar_connection SET access_token_enc = $1, access_token_expires_at = $2,
       refresh_token_enc = COALESCE($3, refresh_token_enc)`,
    [
      encrypt(body.access_token!, 'access_token'),
      new Date(Date.now() + (body.expires_in ?? 0) * 1000),
      body.refresh_token ? encrypt(body.refresh_token, 'refresh_token') : null, // Google may rotate it
    ],
  );
  return body.access_token!;
}

// --- Status and disconnect -----------------------------------------------------------------------

/** Safe for the dashboard: no tokens, no secrets, only variable names. */
export async function connectionStatus() {
  const missing = missingConfig();
  const row = await loadConnection();
  return {
    configured: missing.length === 0,
    missingConfig: missing,
    status: row?.status ?? ('not_connected' as const),
    calendarId: env.GOOGLE_CALENDAR_ID,
    connectedAt: row?.connectedAt ?? null,
    scopes: row?.scopes.split(' ') ?? [],
  };
}

/** Deletes the stored tokens even if Google cannot be reached, and reports whether Google confirmed the revocation. */
export async function disconnect(): Promise<{ revokedAtGoogle: boolean }> {
  const [row] = await query<{ refreshTokenEnc: string | null }>(
    `DELETE FROM google_calendar_connection RETURNING refresh_token_enc AS "refreshTokenEnc"`,
  );
  if (!row?.refreshTokenEnc || missingConfig().length) return { revokedAtGoogle: false };
  try {
    const token = decrypt(row.refreshTokenEnc, 'refresh_token');
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    return { revokedAtGoogle: res.ok };
  } catch {
    return { revokedAtGoogle: false };
  }
}
