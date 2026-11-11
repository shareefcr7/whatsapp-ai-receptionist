import { useCallback, useEffect, useState } from 'react';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export type DataState = 'has_data' | 'empty' | 'database_not_configured';

export interface Meta {
  dataState?: DataState;
  page?: number;
  limit?: number;
  total?: number;
}

export interface ApiResult<T> {
  data: T;
  meta: Meta;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Per-field messages on validation errors. */
  readonly details: Record<string, string[]> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, string[]>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Fired when a signed-in request comes back 401, so the dashboard returns to the login page. */
export const SESSION_EXPIRED = 'receptionist:session-expired';

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal | undefined;
}

export async function apiRequest<T>(path: string, { method = 'GET', body, signal }: RequestOptions = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(BASE_URL + path, {
      method,
      signal: signal ?? null,
      credentials: 'include', // the session cookie, also when VITE_API_BASE_URL is another origin
      headers: { accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the API. Check that the backend is running.');
  }
  // A dead backend behind a proxy answers with a non-JSON 5xx.
  const parsed = await res.json().catch(() => null);
  if (!parsed) throw new ApiError(res.status, 'NETWORK_ERROR', 'Cannot reach the API. Check that the backend is running.');
  if (!res.ok || !parsed.success) {
    const code = parsed.error?.code ?? 'UNKNOWN';
    // /auth/* answers for itself; re-checking the session on its 401 would loop.
    if (code === 'UNAUTHENTICATED' && !path.startsWith('/auth/')) window.dispatchEvent(new Event(SESSION_EXPIRED));
    throw new ApiError(res.status, code, parsed.error?.message ?? 'The request failed.', parsed.error?.details);
  }
  return { data: parsed.data as T, meta: parsed.meta ?? {} };
}

export const apiGet = <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal });

export interface ApiState<T> {
  result: ApiResult<T> | null;
  error: ApiError | null;
  loading: boolean;
  refetch: () => void;
}

export function useApi<T>(path: string, pollMs?: number): ApiState<T> {
  const [state, setState] = useState<{ path: string; result: ApiResult<T> | null; error: ApiError | null } | null>(null);
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => {
    setState(null);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      apiGet<T>(path, controller.signal)
        .then((result) => setState({ path, result, error: null }))
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const error = err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'The request failed.');
          setState({ path, result: null, error });
        });
    void load();
    const timer = pollMs ? setInterval(load, pollMs) : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, pollMs, tick]);

  // A result for an older path is treated as loading, so a filter change never shows stale rows.
  const current = state?.path === path ? state : null;
  return { result: current?.result ?? null, error: current?.error ?? null, loading: !current, refetch };
}

export interface IntegrationStatus {
  implementation: 'placeholder' | 'ready';
  credentials: 'missing' | 'present_untested';
  connected: false;
}

export interface GoogleCalendarStatus {
  configured: boolean;
  missingConfig: string[];
  status: 'not_connected' | 'connected' | 'reconnect_required';
  calendarId: string;
  connectedAt: string | null;
  scopes: string[];
}

export interface ApiIndex {
  name: string;
  environment: string;
  integrations: Record<'whatsapp' | 'openai' | 'googleCalendar', IntegrationStatus>;
}

export interface DatabaseHealth {
  status: 'connected';
  serverVersion: string;
  migrationsApplied: number;
  latencyMs: number;
}

export interface Conversation {
  id: string;
  customerName: string | null;
  customerPhone: string;
  status: string;
  lastMessageAt: string | null;
  lastMessage: string | null;
  messageCount: number;
}

export interface Lead {
  id: string;
  customerName: string | null;
  customerPhone: string;
  serviceName: string | null;
  interest: string | null;
  source: string;
  status: string;
  createdAt: string;
}

export interface Appointment {
  id: string;
  customerName: string | null;
  customerPhone: string;
  serviceName: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  googleCalendarEventId: string | null;
}

export interface DashboardSummary {
  kpis: {
    openConversations: number;
    awaitingHandover: number;
    newLeads: number;
    upcomingAppointments: number;
    messagesToday: number;
  } | null;
  recentConversations: Conversation[];
  upcomingAppointments: Appointment[];
  recentLeads: Lead[];
}

export interface Staff {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'agent';
}

export interface BusinessProfile {
  name: string;
  description: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  workingHours: string;
  isPublished: boolean;
}

export interface BusinessEntry {
  id: string;
  key: string;
  category: string;
  title: string;
  content: string;
  isPublished: boolean;
}

export interface Service {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceAmount: string | null;
  currency: string | null;
  isActive: boolean;
}

export interface BusinessInfo {
  /** Null only when no database is configured. */
  profile: BusinessProfile | null;
  entries: BusinessEntry[];
  services: Service[];
}

export interface UsageRow {
  provider: string;
  model: string | null;
  currency: string;
  events: number;
  inputTokens: string;
  outputTokens: string;
  units: string;
  estimatedCost: string | null;
}
