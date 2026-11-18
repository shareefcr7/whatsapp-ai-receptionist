import type { PoolClient } from 'pg';
import { env } from '../../config/env.ts';
import { inTransaction } from '../../database/pool.ts';

// The subset of Meta's webhook payload this code reads. Everything else is ignored.
export interface WaMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
}
export interface WaStatus {
  id: string;
  status: string;
  errors?: { code?: number; title?: string }[];
  /** Our outbound message ID, sent with the message and echoed back by Meta. */
  biz_opaque_callback_data?: string;
}
interface WaValue {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
}
export interface WebhookPayload {
  object?: string;
  entry?: { changes?: { field?: string; value?: WaValue }[] }[];
}

type Outcome = 'processed' | 'duplicate' | 'ignored' | 'failed';
export type WebhookResult = Record<Outcome, number>;
/** Counts for Meta, plus the IDs of inbound messages saved by this delivery (never redeliveries), for internal use only. */
export interface ReceivedMessage {
  messageId: string;
  conversationId: string;
}
export type WebhookOutcome = WebhookResult & { received: ReceivedMessage[] };

const E164 = /^\+[1-9][0-9]{6,14}$/;
// Statuses arrive out of order; a late "delivered" must not overwrite "read".
const STATUS_ORDER = ['queued', 'sent', 'delivered', 'read'];

// Whole-message matches only, so "stop by tomorrow?" is not an opt-out. CANCEL is left out: customers use it for appointments.
const OPT_OUT_KEYWORDS = new Set(['stop', 'stop all', 'stopall', 'unsubscribe', 'opt out', 'opt-out', 'optout', 'end', 'quit']);

/** True when the whole message asks to stop messages, ignoring case, spacing and trailing punctuation. */
export function isOptOut(text: string | null): boolean {
  if (!text) return false;
  return OPT_OUT_KEYWORDS.has(text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!]+$/, ''));
}

/** The readable text of a message, or null for media without a caption, locations, stickers and unknown types. */
export function messageText(m: WaMessage): string | null {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? null;
    case 'button':
      return m.button?.text ?? null;
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    case 'image':
    case 'video':
    case 'document':
      return m[m.type]?.caption ?? null;
    default:
      return null;
  }
}

/** The unique (source, external_event_id) key decides: null means Meta already delivered this event. */
async function recordEvent(c: PoolClient, externalId: string, type: string, payload: unknown): Promise<string | null> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO webhook_events (source, external_event_id, event_type, payload) VALUES ('whatsapp', $1, $2, $3)
     ON CONFLICT (source, external_event_id) DO NOTHING RETURNING id`,
    [externalId, type, payload],
  );
  return rows[0]?.id ?? null;
}

const finish = (c: PoolClient, id: string, status: 'processed' | 'ignored' | 'failed', error: string | null = null) =>
  c.query(`UPDATE webhook_events SET status = $2, error_message = $3, processed_at = now() WHERE id = $1`, [id, status, error]);

/** The customer's open conversation, created if needed. The partial unique index settles a race between two webhooks. */
async function openConversation(c: PoolClient, customerId: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { rows } = await c.query<{ id: string }>(
      `WITH created AS (
         INSERT INTO conversations (customer_id) VALUES ($1)
         ON CONFLICT (customer_id) WHERE status <> 'closed' DO NOTHING RETURNING id
       )
       SELECT id FROM created UNION ALL SELECT id FROM conversations WHERE customer_id = $1 AND status <> 'closed' LIMIT 1`,
      [customerId],
    );
    if (rows[0]) return rows[0].id;
  }
  throw new Error('Could not open a conversation');
}

function handleMessage(m: WaMessage, profileName: string | undefined): Promise<{ outcome: Outcome; received?: ReceivedMessage }> {
  return inTransaction(async (c) => {
    const eventId = await recordEvent(c, `message:${m.id}`, `message.${m.type}`, m);
    if (!eventId) return { outcome: 'duplicate' };
    const phone = `+${m.from}`;
    if (!E164.test(phone)) {
      await finish(c, eventId, 'failed', 'Sender is not a valid international phone number.');
      return { outcome: 'failed' };
    }
    const seconds = Number(m.timestamp);
    const sentAt = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO customers (phone_number, name) VALUES ($1, $2)
       ON CONFLICT (phone_number) DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name)
       RETURNING id`,
      [phone, profileName?.slice(0, 200) || null],
    );
    const conversationId = await openConversation(c, rows[0]!.id);
    // Only staff can undo this (POST /api/conversations/:id/reactivate); no keyword re-subscribes.
    if (isOptOut(messageText(m))) {
      await c.query(`UPDATE customers SET opted_out_at = COALESCE(opted_out_at, now()) WHERE id = $1`, [rows[0]!.id]);
    }
    const saved = await c.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, direction, sender_type, message_type, content, whatsapp_message_id, status, created_at)
       VALUES ($1, 'inbound', 'customer', $2, $3, $4, 'received', $5)
       ON CONFLICT (whatsapp_message_id) DO NOTHING RETURNING id`,
      [conversationId, m.type, messageText(m), m.id, sentAt],
    );
    await c.query(
      `UPDATE conversations SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1`,
      [conversationId, sentAt],
    );
    await finish(c, eventId, 'processed');
    const messageId = saved.rows[0]?.id;
    return { outcome: 'processed', received: messageId ? { messageId, conversationId } : undefined };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applies one delivery status to its outbound message. Matched by WhatsApp's message ID, or by our own message ID that
 * Meta echoes back (biz_opaque_callback_data), which works even before the send result and its WhatsApp ID are saved.
 * A message whose delivery was 'queued' or 'unknown' takes any status: this is how an unknown send is resolved.
 * Returns whether a message was updated.
 */
export async function applyStatus(c: PoolClient, s: WaStatus): Promise<boolean> {
  const rank = STATUS_ORDER.indexOf(s.status);
  if (rank < 0 && s.status !== 'failed') return false;
  // Meta's error code and title only: they describe the failure, never the message content.
  const error = s.status === 'failed' ? (s.errors?.[0] ? `${s.errors[0].code ?? ''} ${s.errors[0].title ?? ''}`.trim() : 'Delivery failed.') : null;
  const ourId = s.biz_opaque_callback_data && UUID.test(s.biz_opaque_callback_data) ? s.biz_opaque_callback_data : null;
  const { rowCount } = await c.query(
    `UPDATE messages SET status = $2, error_message = COALESCE($3, error_message), whatsapp_message_id = COALESCE(whatsapp_message_id, $1)
     WHERE direction = 'outbound'
       AND (whatsapp_message_id = $1 OR (id = $6::uuid AND (whatsapp_message_id IS NULL OR whatsapp_message_id = $1)))
       AND ($2 = 'failed' OR status IN ('queued', 'unknown') OR array_position($4::text[], status) < $5)`,
    [s.id, s.status, error, STATUS_ORDER, rank + 1, ourId],
  );
  return Boolean(rowCount);
}

function handleStatus(s: WaStatus): Promise<Outcome> {
  return inTransaction(async (c) => {
    const eventId = await recordEvent(c, `status:${s.id}:${s.status}`, `status.${s.status}`, s);
    if (!eventId) return 'duplicate';
    if (STATUS_ORDER.indexOf(s.status) < 0 && s.status !== 'failed') {
      await finish(c, eventId, 'ignored', 'Unknown status.');
      return 'ignored';
    }
    const applied = await applyStatus(c, s);
    // An ignored status is kept: applyLateStatuses replays it if its message's WhatsApp ID is saved later.
    await finish(c, eventId, applied ? 'processed' : 'ignored', applied ? null : 'No matching outbound message, or a later status was already recorded.');
    return applied ? 'processed' : 'ignored';
  });
}

/**
 * Replays statuses that arrived before their message's WhatsApp ID was saved and carried no callback ID (so nothing
 * matched them then). Called right after a send saves the ID; a status Meta sends later matches directly.
 */
export async function applyLateStatuses(c: PoolClient, whatsappMessageId: string): Promise<void> {
  const { rows } = await c.query<{ id: string; payload: WaStatus }>(
    `SELECT id, payload FROM webhook_events
     WHERE source = 'whatsapp' AND status = 'ignored' AND event_type LIKE 'status.%' AND payload->>'id' = $1
     ORDER BY received_at, id`,
    [whatsappMessageId],
  );
  for (const event of rows) if (await applyStatus(c, event.payload)) await finish(c, event.id, 'processed');
}

/**
 * Processes every message and status in a verified webhook. Each item has its own transaction, so a database
 * error rolls back only that item and is thrown: Meta then retries, and items already saved count as duplicates.
 */
export async function processWebhook(payload: WebhookPayload): Promise<WebhookOutcome> {
  const result: WebhookOutcome = { processed: 0, duplicate: 0, ignored: 0, failed: 0, received: [] };
  if (payload.object !== 'whatsapp_business_account') {
    result.ignored += 1;
    return result;
  }
  for (const change of (payload.entry ?? []).flatMap((e) => e.changes ?? [])) {
    const value = change.value;
    // Other fields (account updates, template reviews) and other phone numbers are not ours to handle.
    if (change.field !== 'messages' || !value || (env.WHATSAPP_PHONE_NUMBER_ID && value.metadata?.phone_number_id !== env.WHATSAPP_PHONE_NUMBER_ID)) {
      // A phone number ID is an identifier, not a secret; logging the received one makes a misconfigured
      // WHATSAPP_PHONE_NUMBER_ID visible. Never the message content.
      if (change.field === 'messages' && value) {
        console.warn(
          `WhatsApp webhook: ignored a change for phone_number_id ${JSON.stringify(value.metadata?.phone_number_id ?? null)}: ` +
            `it is not the configured WHATSAPP_PHONE_NUMBER_ID (Meta's dashboard Test sends a placeholder ID).`,
        );
      }
      result.ignored += 1;
      continue;
    }
    const names = new Map((value.contacts ?? []).map((ct) => [ct.wa_id, ct.profile?.name]));
    for (const m of value.messages ?? []) {
      if (typeof m?.id !== 'string' || typeof m.from !== 'string' || typeof m.type !== 'string') {
        result.ignored += 1;
        continue;
      }
      const { outcome, received } = await handleMessage(m, names.get(m.from));
      result[outcome] += 1;
      if (received) result.received.push(received);
    }
    for (const s of value.statuses ?? []) {
      if (typeof s?.id !== 'string' || typeof s.status !== 'string') {
        result.ignored += 1;
        continue;
      }
      result[await handleStatus(s)] += 1;
    }
  }
  return result;
}
