import type { ApiIndex, GoogleCalendarStatus } from './api';
import type { StatusItem } from './useSystemStatus';

const READY_DETAIL = {
  whatsapp: 'Built · not connected until Meta verifies the webhook',
  openai: 'Built · not in use until WhatsApp is connected',
  googleCalendar: 'Built · connect it in Settings',
} as const;

const NAMES = { whatsapp: 'WhatsApp', openai: 'OpenAI', googleCalendar: 'Google Calendar' } as const;

/** The stored OAuth connection, the same source as the Settings card. Says nothing about booking, which is not built. */
function googleItem(google: GoogleCalendarStatus): StatusItem {
  const label = NAMES.googleCalendar;
  if (!google.configured) return { label, tone: 'neutral', detail: 'Not connected · credentials missing' };
  if (google.status === 'connected') return { label, tone: 'good', detail: 'Connected · bookings do not use it yet' };
  if (google.status === 'reconnect_required') return { label, tone: 'warn', detail: 'Reconnect needed in Settings' };
  return { label, tone: 'neutral', detail: 'Not connected · connect it in Settings' };
}

/** `google` is /integrations/google/status; until it loads (or if it fails) the credential-only view from /api is shown. */
export function integrationItems(index: ApiIndex | undefined, google?: GoogleCalendarStatus): StatusItem[] {
  return (Object.keys(NAMES) as (keyof typeof NAMES)[]).map((key) => {
    if (key === 'googleCalendar' && google) return googleItem(google);
    const integration = index?.integrations[key];
    return {
      label: NAMES[key],
      tone: 'neutral',
      detail: !integration
        ? 'Unknown'
        : integration.credentials === 'missing'
          ? 'Not connected · credentials missing'
          : integration.implementation === 'ready'
            ? READY_DETAIL[key]
            : 'Not connected · integration pending',
    };
  });
}
