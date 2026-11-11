import { env } from '../config/env.ts';

/**
 * Reports only whether credentials are present. Nothing is ever "connected" until a
 * real integration exists and has been tested against the provider.
 */
function status(keys: (string | undefined)[], implementation: 'placeholder' | 'ready' = 'placeholder') {
  return {
    implementation,
    credentials: keys.every(Boolean) ? 'present_untested' : 'missing',
    connected: false,
  } as const;
}

export function integrationStatus() {
  return {
    whatsapp: status([
      env.WHATSAPP_ACCESS_TOKEN,
      env.WHATSAPP_PHONE_NUMBER_ID,
      env.WHATSAPP_BUSINESS_ACCOUNT_ID,
      env.WHATSAPP_VERIFY_TOKEN,
      env.WHATSAPP_APP_SECRET,
    ], 'ready'),
    // Ready means the code exists; it only runs once WhatsApp delivers messages to it.
    openai: status([env.OPENAI_API_KEY], 'ready'),
    // Whether it is actually connected comes from /api/integrations/google/status, which reads the database.
    googleCalendar: status([env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI, env.GOOGLE_TOKEN_ENCRYPTION_KEY], 'ready'),
  };
}
