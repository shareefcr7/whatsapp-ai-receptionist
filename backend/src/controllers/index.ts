import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { allowedOrigins, env } from '../config/env.ts';
import { isDatabaseConfigured, query, requirePool } from '../database/pool.ts';
import { sessionCookie } from '../middleware/auth.ts';
import { endSession, login as startSession } from '../services/auth/index.ts';
import { bookingService } from '../services/booking/index.ts';
import { calendarService } from '../services/calendar/index.ts';
import { completeAuthorization, connectionStatus, disconnect, STATE_COOKIE, startAuthorization } from '../services/calendar/oauth.ts';
import { catalogService } from '../services/catalog/index.ts';
import { whatsAppService } from '../services/whatsapp/index.ts';
import { processWebhook } from '../services/whatsapp/webhook.ts';
import { conversationService } from '../services/conversations/index.ts';
import { integrationStatus } from '../services/integrations.ts';
import { knowledgeService } from '../services/knowledge/index.ts';
import { leadService } from '../services/leads/index.ts';
import {
  APPOINTMENT_STATUSES,
  CONVERSATION_STATUSES,
  entrySchema,
  idParam,
  LEAD_STATUSES,
  listQuerySchema,
  loginSchema,
  profileSchema,
  SERVICE_STATUSES,
  serviceSchema,
} from '../types/api.ts';
import type { DataState, ListQuery, Page } from '../types/api.ts';
import { AppError } from '../types/errors.ts';

function ok(res: Response, data: unknown, meta?: Record<string, unknown>) {
  res.json({ success: true, data, ...(meta && { meta }) });
}

function listEndpoint<S extends string>(
  schema: ZodType<ListQuery<S>>,
  fetch: (q: ListQuery<S>) => Promise<Page<unknown>>,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const q = schema.parse(req.query); // validated even with no database, so errors stay consistent
    const { page, limit } = q;
    if (!isDatabaseConfigured) {
      const dataState: DataState = 'database_not_configured';
      return ok(res, [], { dataState, page, limit, total: 0 });
    }
    const { rows, total } = await fetch(q);
    const dataState: DataState = total > 0 ? 'has_data' : 'empty';
    ok(res, rows, { dataState, page, limit, total });
  };
}

export const apiIndex: RequestHandler = (_req, res) => {
  ok(res, {
    name: 'WhatsApp AI Receptionist API',
    environment: env.NODE_ENV,
    endpoints: [
      '/api',
      '/api/health',
      '/api/health/database',
      '/api/dashboard/summary',
      '/api/conversations',
      '/api/leads',
      '/api/appointments',
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/me',
      '/api/business-info',
      '/api/business-info/profile',
      '/api/business-info/entries',
      '/api/services',
      '/api/usage',
      '/api/integrations/google/status',
    ],
    integrations: integrationStatus(),
  });
};

export const login: RequestHandler = async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const { token, expiresAt, staff } = await startSession(email, password, req.ip ?? 'unknown');
  res.set('Cache-Control', 'no-store');
  res.cookie(sessionCookie.name, token, sessionCookie.options(expiresAt));
  ok(res, staff);
};

export const logout: RequestHandler = async (req, res) => {
  const token = sessionCookie.read(req);
  if (token) await endSession(token);
  res.clearCookie(sessionCookie.name, sessionCookie.clearOptions);
  ok(res, null);
};

export const me: RequestHandler = (_req, res) => {
  requirePool(); // without a database nobody can be signed in, which the dashboard needs to tell apart from "signed out"
  ok(res, res.locals.staff);
};

export const health: RequestHandler = (_req, res) => {
  ok(res, { status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
};

export const databaseHealth: RequestHandler = async (_req, res) => {
  const db = requirePool();
  const started = performance.now();
  const { rows } = await db.query<{ version: string; tracked: boolean }>(
    `SELECT current_setting('server_version') AS version,
            to_regclass('public.schema_migrations') IS NOT NULL AS tracked`,
  );
  const latencyMs = Math.round(performance.now() - started);
  // A reachable database with no migrations table is connected, just not migrated yet.
  const migrations = rows[0]?.tracked
    ? (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]?.n
    : 0;
  ok(res, { status: 'connected', serverVersion: rows[0]?.version, migrationsApplied: migrations ?? 0, latencyMs });
};

export const listConversations = listEndpoint(listQuerySchema(CONVERSATION_STATUSES), (q) => conversationService.list(q));
export const listLeads = listEndpoint(listQuerySchema(LEAD_STATUSES), (q) => leadService.list(q));
export const listAppointments = listEndpoint(listQuerySchema(APPOINTMENT_STATUSES), (q) => bookingService.list(q));

export const dashboardSummary: RequestHandler = async (_req, res) => {
  if (!isDatabaseConfigured) {
    return ok(
      res,
      {
        kpis: null,
        recentConversations: [],
        upcomingAppointments: [],
        recentLeads: [],
      },
      { dataState: 'database_not_configured' satisfies DataState },
    );
  }
  const [kpis, conversations, appointments, leads] = await Promise.all([
    query<{
      openConversations: number;
      awaitingHandover: number;
      newLeads: number;
      upcomingAppointments: number;
      messagesToday: number;
    }>(`SELECT
      (SELECT count(*)::int FROM conversations WHERE status <> 'closed') AS "openConversations",
      (SELECT count(*)::int FROM conversations WHERE status = 'handover_requested') AS "awaitingHandover",
      (SELECT count(*)::int FROM leads WHERE status = 'new') AS "newLeads",
      (SELECT count(*)::int FROM appointments
        WHERE status IN ('pending', 'confirmed') AND starts_at >= now()) AS "upcomingAppointments",
      (SELECT count(*)::int FROM messages WHERE created_at >= date_trunc('day', now())) AS "messagesToday"`),
    conversationService.list({ page: 1, limit: 5 }),
    bookingService.upcoming(5),
    leadService.list({ page: 1, limit: 5 }),
  ]);
  const empty = conversations.total === 0 && appointments.length === 0 && leads.total === 0;
  ok(
    res,
    {
      kpis: kpis[0],
      recentConversations: conversations.rows,
      upcomingAppointments: appointments,
      recentLeads: leads.rows,
    },
    { dataState: (empty ? 'empty' : 'has_data') satisfies DataState },
  );
};

export const businessInfo: RequestHandler = async (_req, res) => {
  if (!isDatabaseConfigured) {
    return ok(res, { profile: null, entries: [], services: [] }, { dataState: 'database_not_configured' satisfies DataState });
  }
  const [{ profile, entries, hasData }, services] = await Promise.all([
    knowledgeService.read(),
    query(`SELECT id, name, description, duration_minutes AS "durationMinutes", price_amount AS "priceAmount",
                  currency, is_active AS "isActive"
           FROM services ORDER BY name`),
  ]);
  const dataState: DataState = hasData || services.length ? 'has_data' : 'empty';
  ok(res, { profile, entries, services }, { dataState });
};

export const saveBusinessProfile: RequestHandler = async (req, res) => {
  await knowledgeService.saveProfile(profileSchema.parse(req.body));
  ok(res, (await knowledgeService.read()).profile);
};

export const createBusinessEntry: RequestHandler = async (req, res) => {
  res.status(201);
  ok(res, await knowledgeService.createEntry(entrySchema.parse(req.body)));
};

export const updateBusinessEntry: RequestHandler = async (req, res) => {
  ok(res, await knowledgeService.updateEntry(idParam.parse(req.params.id), entrySchema.parse(req.body)));
};

export const deleteBusinessEntry: RequestHandler = async (req, res) => {
  await knowledgeService.deleteEntry(idParam.parse(req.params.id));
  ok(res, null);
};

export const listServices = listEndpoint(listQuerySchema(SERVICE_STATUSES), (q) => catalogService.list(q));

export const createService: RequestHandler = async (req, res) => {
  res.status(201);
  ok(res, await catalogService.create(serviceSchema.parse(req.body)));
};

export const updateService: RequestHandler = async (req, res) => {
  ok(res, await catalogService.update(idParam.parse(req.params.id), serviceSchema.parse(req.body)));
};

export const deleteService: RequestHandler = async (req, res) => {
  await catalogService.remove(idParam.parse(req.params.id));
  ok(res, null);
};

/** Month-to-date totals from usage_logs: recorded activity only, never an estimate of the bill. */
export const usage: RequestHandler = async (_req, res) => {
  if (!isDatabaseConfigured) {
    return ok(res, [], { dataState: 'database_not_configured' satisfies DataState });
  }
  const rows = await query(
    `SELECT provider, model, currency, count(*)::int AS events,
            sum(input_tokens)::bigint::text AS "inputTokens",
            sum(output_tokens)::bigint::text AS "outputTokens",
            sum(units)::bigint::text AS units,
            sum(estimated_cost)::text AS "estimatedCost"
     FROM usage_logs
     WHERE occurred_at >= date_trunc('month', now())
     GROUP BY provider, model, currency
     ORDER BY provider, model`,
  );
  ok(res, rows, { dataState: (rows.length ? 'has_data' : 'empty') satisfies DataState });
};

// --- Google Calendar OAuth ---

// Lax, unlike the session cookie: it must come back on Google's cross-site redirect to the callback.
const stateCookie: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  path: '/api/integrations/google',
};
const readCookie = (req: Request, name: string) => req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
const queryString = (v: unknown) => (typeof v === 'string' ? v : undefined);

export const googleStatus: RequestHandler = async (_req, res) => {
  ok(res, await connectionStatus());
};

/** Returns the consent URL; the dashboard navigates to it. */
export const googleAuthorize: RequestHandler = async (_req, res) => {
  const { authorizationUrl, state } = await startAuthorization(res.locals.staff.id);
  res.cookie(STATE_COOKIE, state, { ...stateCookie, maxAge: 10 * 60_000 });
  ok(res, { authorizationUrl });
};

/** Google redirects the browser here. Always ends on the dashboard Settings page with a result code, never a token. */
export const googleCallback: RequestHandler = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.clearCookie(STATE_COOKIE, stateCookie);
  const target = new URL('/settings', allowedOrigins[0]);
  try {
    const error = queryString(req.query.error);
    if (error) throw new AppError(400, error === 'access_denied' ? 'CALENDAR_ACCESS_DENIED' : 'CALENDAR_ERROR', 'Google returned an error.');
    await completeAuthorization(queryString(req.query.state), readCookie(req, STATE_COOKIE), queryString(req.query.code));
    target.searchParams.set('google', 'connected');
  } catch (err) {
    if (!(err instanceof AppError)) console.error('Google OAuth callback failed:', (err as Error).message);
    target.searchParams.set('google', 'error');
    target.searchParams.set('reason', err instanceof AppError ? err.code : 'CALENDAR_ERROR');
  }
  res.redirect(303, target.toString());
};

/** A real read from Google, so "connected" in the dashboard can be checked rather than assumed. */
export const googleTest: RequestHandler = async (_req, res) => {
  const now = new Date();
  const busy = await calendarService.listBusy({ start: now, end: new Date(now.getTime() + 24 * 60 * 60_000) });
  ok(res, { ok: true, calendarId: env.GOOGLE_CALENDAR_ID, busyPeriodsNext24h: busy.length });
};

export const googleDisconnect: RequestHandler = async (_req, res) => {
  ok(res, await disconnect());
};

// --- WhatsApp webhook (public: Meta cannot sign in, so the signature authenticates each request) ---

/** Meta's subscription handshake: echo hub.challenge only when the verify token matches. */
export const whatsappVerify: RequestHandler = (req, res) => {
  const mode = queryString(req.query['hub.mode']);
  const token = queryString(req.query['hub.verify_token']);
  const challenge = queryString(req.query['hub.challenge']);
  res.set('Cache-Control', 'no-store').type('text/plain');
  if (mode === 'subscribe' && token && whatsAppService.verifyToken(token) && challenge && /^[A-Za-z0-9_-]{1,256}$/.test(challenge)) {
    res.send(challenge);
    return;
  }
  res.status(403).send('Forbidden');
};

export const whatsappWebhook: RequestHandler = async (req, res) => {
  if (!env.WHATSAPP_APP_SECRET) throw new AppError(503, 'WHATSAPP_NOT_CONFIGURED', 'WHATSAPP_APP_SECRET is not set.');
  const raw: unknown = req.body;
  if (!Buffer.isBuffer(raw) || raw.length === 0) throw new AppError(400, 'BAD_REQUEST', 'Expected a JSON body.');
  if (!whatsAppService.verifySignature(raw, req.get('x-hub-signature-256') ?? '')) {
    throw new AppError(401, 'INVALID_SIGNATURE', 'The webhook signature is missing or wrong.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(400, 'BAD_REQUEST', 'The webhook body is not valid JSON.');
  }
  const result = await processWebhook(payload as Parameters<typeof processWebhook>[0]);
  // Counts only: never the payload, which holds customer messages and phone numbers.
  if (result.failed) console.warn(`WhatsApp webhook: ${result.failed} item(s) could not be saved (see webhook_events.error_message).`);
  ok(res, result);
};
