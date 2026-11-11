import { useState } from 'react';
import { Card, ErrorState, FormError, PageHeader, primaryButtonClass, secondaryButtonClass, Skeleton, StatusList, SuccessNotice } from '../components/ui';
import { ApiError, apiRequest, useApi } from '../lib/api';
import type { ApiIndex, GoogleCalendarStatus } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSystemStatus } from '../lib/useSystemStatus';
import { integrationItems } from './Overview';

export function Settings() {
  const { result, error, loading, refetch } = useApi<ApiIndex>('');
  const { api, database } = useSystemStatus();

  return (
    <>
      <PageHeader title="Settings" description="Read-only configuration status. Secrets live in backend/.env on the server and are never sent to this dashboard." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="System">
          <StatusList
            items={[
              api,
              database,
              { label: 'Environment', detail: result?.data.environment ?? '—', tone: 'neutral' },
            ]}
          />
        </Card>
        <Card title="Integrations">
          {loading ? <Skeleton rows={3} /> : error ? <ErrorState error={error} onRetry={refetch} /> : <StatusList items={integrationItems(result?.data)} />}
          <p className="border-t border-stone-100 px-5 py-3 text-xs text-stone-500">
            "Integration pending" means credentials are set but no integration code uses them yet.
          </p>
        </Card>
        <GoogleCalendarCard />
      </div>
    </>
  );
}

// Codes the OAuth callback puts in ?reason=, so the message after Google's redirect is specific.
const CALLBACK_REASONS: Record<string, string> = {
  CALENDAR_ACCESS_DENIED: 'Access was declined on the Google consent screen.',
  CALENDAR_INVALID_STATE: 'The connection request expired or was started in another browser. Try again.',
  CALENDAR_MISSING_SCOPE: 'Not every calendar permission was allowed. Try again and allow all of them.',
  CALENDAR_NO_REFRESH_TOKEN: 'Google did not issue a refresh token. Try again.',
  CALENDAR_NOT_CONFIGURED: 'Google credentials on the server are missing or wrong.',
  CALENDAR_INVALID_GRANT: 'Google rejected the authorization code. Try again.',
};

function GoogleCalendarCard() {
  const { isAdmin } = useAuth();
  const { result, error, loading, refetch } = useApi<GoogleCalendarStatus>('/integrations/google/status');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('google') === 'connected') return 'Google Calendar connected. Use "Test connection" to check it.';
    return null;
  });
  const [callbackError] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('google') === 'error' ? (CALLBACK_REASONS[params.get('reason') ?? ''] ?? 'Connecting Google Calendar failed.') : null;
  });

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'The request failed.'));
    } finally {
      setBusy(false);
      refetch();
    }
  }

  const connect = () =>
    run(async () => {
      const { data } = await apiRequest<{ authorizationUrl: string }>('/integrations/google/authorize', { method: 'POST' });
      window.location.assign(data.authorizationUrl);
    });
  const test = () =>
    run(async () => {
      const { data } = await apiRequest<{ busyPeriodsNext24h: number }>('/integrations/google/test', { method: 'POST' });
      setNotice(`Google Calendar answered. Busy periods in the next 24 hours: ${data.busyPeriodsNext24h}.`);
    });
  const disconnect = () =>
    run(async () => {
      const { data } = await apiRequest<{ revokedAtGoogle: boolean }>('/integrations/google', { method: 'DELETE' });
      setNotice(data.revokedAtGoogle ? 'Disconnected and access revoked at Google.' : 'Disconnected here. Google did not confirm the revocation; remove access in your Google account if needed.');
    });

  const s = result?.data;
  const detail = !s
    ? ''
    : !s.configured
      ? `Not configured · missing ${s.missingConfig.join(', ')}`
      : s.status === 'connected'
        ? `Connected · calendar "${s.calendarId}"`
        : s.status === 'reconnect_required'
          ? 'Access expired or was revoked · reconnect needed'
          : 'Not connected';

  return (
    <Card title="Google Calendar">
      {loading ? (
        <Skeleton rows={2} />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <div className="space-y-3 px-5 py-4 text-sm">
          <p className="text-stone-700">{detail}</p>
          {callbackError && <FormError error={new ApiError(400, 'CALLBACK', callbackError)} />}
          <FormError error={actionError} />
          {notice && <SuccessNotice>{notice}</SuccessNotice>}
          {isAdmin && s?.configured && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={primaryButtonClass} disabled={busy} onClick={() => void connect()}>
                {s.status === 'not_connected' ? 'Connect Google Calendar' : 'Reconnect'}
              </button>
              {s.status === 'connected' && (
                <>
                  <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void test()}>
                    Test connection
                  </button>
                  <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void disconnect()}>
                    Disconnect
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
