import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiIndex, GoogleCalendarStatus } from '../src/lib/api.ts';
import { integrationItems } from '../src/lib/integrations.ts';

const ready = { implementation: 'ready', credentials: 'present_untested', connected: false } as const;
const index: ApiIndex = { name: 'API', environment: 'test', integrations: { whatsapp: ready, ai: { ...ready, provider: 'anthropic' }, googleCalendar: ready } };
const google = (over: Partial<GoogleCalendarStatus>): GoogleCalendarStatus => ({
  configured: true,
  missingConfig: [],
  status: 'not_connected',
  calendarId: 'primary',
  connectedAt: null,
  scopes: [],
  ...over,
});
const calendar = (g?: GoogleCalendarStatus) => integrationItems(index, g).find((i) => i.label === 'Google Calendar')!;

describe('integration status items', () => {
  it('shows Connected from the stored OAuth connection, without claiming booking works', () => {
    const item = calendar(google({ status: 'connected' }));
    assert.equal(item.tone, 'good');
    assert.match(item.detail, /^Connected/);
    assert.match(item.detail, /bookings do not use it yet/);
  });

  it('reports reconnect, not connected, and missing credentials', () => {
    assert.deepEqual(calendar(google({ status: 'reconnect_required' })), { label: 'Google Calendar', tone: 'warn', detail: 'Reconnect needed in Settings' });
    assert.equal(calendar(google({})).detail, 'Not connected · connect it in Settings');
    assert.equal(calendar(google({ configured: false, missingConfig: ['GOOGLE_CLIENT_ID'] })).detail, 'Not connected · credentials missing');
  });

  it('falls back to the credential-only view until the live status loads', () => {
    assert.equal(calendar(undefined).detail, 'Built · connect it in Settings');
    assert.equal(integrationItems(undefined)[0]!.detail, 'Unknown');
  });

  it('leaves WhatsApp unchanged and names the selected AI provider', () => {
    const [whatsapp, ai] = integrationItems(index, google({ status: 'connected' }));
    assert.equal(whatsapp!.detail, 'Built · not connected until Meta verifies the webhook');
    assert.deepEqual(ai, { label: 'AI replies (Claude)', tone: 'neutral', detail: 'Built · not in use until WhatsApp is connected' });
    const openai = { ...index, integrations: { ...index.integrations, ai: { ...ready, provider: 'openai' as const } } };
    assert.equal(integrationItems(openai)[1]!.label, 'AI replies (OpenAI)');
    assert.equal(integrationItems(undefined)[1]!.label, 'AI replies');
  });

  const withAi = (ai: NonNullable<ApiIndex['integrations']['ai']>): ApiIndex => ({ ...index, integrations: { ...index.integrations, ai } });

  it('shows the configured model, and missing credentials under the selected provider only', () => {
    const claude = integrationItems(withAi({ ...ready, provider: 'anthropic', model: 'claude-sonnet-4-6' }))[1]!;
    assert.deepEqual(claude, { label: 'AI replies (Claude · claude-sonnet-4-6)', tone: 'neutral', detail: 'Built · not in use until WhatsApp is connected' });
    const missing = integrationItems(withAi({ ...ready, credentials: 'missing', provider: 'anthropic', model: 'claude-sonnet-4-6' }))[1]!;
    assert.equal(missing.label, 'AI replies (Claude · claude-sonnet-4-6)'); // not OpenAI
    assert.equal(missing.detail, 'Not connected · credentials missing');
    const gpt = integrationItems(withAi({ ...ready, credentials: 'missing', provider: 'openai', model: 'gpt-4.1-mini' }))[1]!;
    assert.equal(gpt.label, 'AI replies (OpenAI · gpt-4.1-mini)');
  });

  it('an older backend without the ai entry shows Unknown instead of crashing', () => {
    const { ai: _ai, ...rest } = index.integrations;
    const [, ai] = integrationItems({ ...index, integrations: rest as ApiIndex['integrations'] });
    assert.deepEqual(ai, { label: 'AI replies', tone: 'neutral', detail: 'Unknown' });
  });
});
