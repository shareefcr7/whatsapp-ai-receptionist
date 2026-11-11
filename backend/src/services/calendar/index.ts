import { env } from '../../config/env.ts';
import { AppError } from '../../types/errors.ts';
import { getAccessToken, unreachable } from './oauth.ts';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface CalendarEvent extends TimeRange {
  summary: string;
  description?: string;
}

export interface CalendarService {
  listBusy(range: TimeRange): Promise<TimeRange[]>;
  createEvent(event: CalendarEvent): Promise<{ eventId: string }>;
  updateEvent(eventId: string, event: CalendarEvent): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
}

/** Google error bodies are read for their reason only and never echoed. */
async function calendarError(res: Response): Promise<AppError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[] } };
  const reason = body.error?.errors?.[0]?.reason;
  if (res.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return new AppError(503, 'CALENDAR_RATE_LIMITED', 'Google Calendar rate limit reached. Try again shortly.');
  }
  if (res.status === 401) return new AppError(409, 'CALENDAR_RECONNECT_REQUIRED', 'Google rejected the calendar access token. Reconnect Google Calendar.');
  if (res.status === 403) {
    return new AppError(502, 'CALENDAR_FORBIDDEN', `The connected Google account cannot use calendar "${env.GOOGLE_CALENDAR_ID}". Check GOOGLE_CALENDAR_ID and its sharing settings.`);
  }
  if (res.status === 404) return new AppError(404, 'CALENDAR_NOT_FOUND', 'The calendar or event was not found in Google Calendar.');
  return new AppError(502, 'CALENDAR_ERROR', `Google Calendar request failed (HTTP ${res.status}).`);
}

/** Retries once with a fresh token on 401, which covers a token revoked or expired early. */
async function google(path: string, init: { method: string; body?: unknown }): Promise<Response> {
  for (const force of [false, true]) {
    const token = await getAccessToken(force);
    let res: Response;
    try {
      res = await fetch(CALENDAR_API + path, {
        method: init.method,
        headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw unreachable();
    }
    if (res.status === 401 && !force) continue;
    if (res.ok || res.status === 410) return res; // 410: event already deleted
    throw await calendarError(res);
  }
  throw new Error('unreachable');
}

const eventsPath = (eventId?: string) =>
  `/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;

const eventBody = (e: CalendarEvent) => ({
  summary: e.summary,
  description: e.description,
  start: { dateTime: e.start.toISOString() },
  end: { dateTime: e.end.toISOString() },
});

export const calendarService: CalendarService = {
  async listBusy({ start, end }) {
    const res = await google('/freeBusy', {
      method: 'POST',
      body: { timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: env.GOOGLE_CALENDAR_ID }] },
    });
    const body = (await res.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }> };
    const calendar = body.calendars?.[env.GOOGLE_CALENDAR_ID];
    // Google reports a calendar problem inside a 200 response, not as an HTTP error.
    if (!calendar || calendar.errors?.length) {
      const reason = calendar?.errors?.[0]?.reason ?? 'missing';
      throw new AppError(502, 'CALENDAR_ERROR', `Google could not read calendar "${env.GOOGLE_CALENDAR_ID}" (${reason}).`);
    }
    return (calendar.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  },

  async createEvent(event) {
    const res = await google(eventsPath(), { method: 'POST', body: eventBody(event) });
    const { id } = (await res.json()) as { id?: string };
    if (!id) throw new AppError(502, 'CALENDAR_ERROR', 'Google Calendar did not return an event ID.');
    return { eventId: id };
  },

  async updateEvent(eventId, event) {
    const res = await google(eventsPath(eventId), { method: 'PATCH', body: eventBody(event) });
    if (res.status === 410) throw new AppError(404, 'CALENDAR_NOT_FOUND', 'That event was deleted from Google Calendar.');
  },

  /** Deleting an event that is already gone (410) counts as success. */
  async deleteEvent(eventId) {
    await google(eventsPath(eventId), { method: 'DELETE' });
  },
};
