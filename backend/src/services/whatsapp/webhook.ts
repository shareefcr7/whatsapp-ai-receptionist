import type { PoolClient } from 'pg';
import { env } from '../../config/env.ts';
import { requirePool } from '../../database/pool.ts';

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
interface WaStatus {
  id: string;
  status: string;
  errors?: { code?: number; title?: string }[];
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

const E164 = /^\+[1-9][0-9]{6,14}$/;
// Statuses arrive out of order; a late "delivered" must not overwrite "read".
const STATUS_ORDER = ['queued', 'sent', 'delivered', 'read'];

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

async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
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

function handleMessage(m: WaMessage, profileName: string | undefined): Promise<Outcome> {
  return inTransaction(async (c) => {
    const eventId = await recordEvent(c, `message:${m.id}`, `message.${m.type}`, m);
    if (!eventId) return 'duplicate';
    const phone = `+${m.from}`;
    if (!E164.test(phone)) {
      await finish(c, eventId, 'failed', 'Sender is not a valid international phone number.');
      return 'failed';
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
    await c.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, message_type, content, whatsapp_message_id, status, created_at)
       VALUES ($1, 'inbound', 'customer', $2, $3, $4, 'received', $5)
       ON CONFLICT (whatsapp_message_id) DO NOTHING`,
      [conversationId, m.type, messageText(m), m.id, sentAt],
    );
    await c.query(
      `UPDATE conversations SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1`,
      [conversationId, sentAt],
    );
    await finish(c, eventId, 'processed');
    return 'processed';
  });
}

function handleStatus(s: WaStatus): Promise<Outcome> {
  return inTransaction(async (c) => {
    const eventId = await recordEvent(c, `status:${s.id}:${s.status}`, `status.${s.status}`, s);
    if (!eventId) return 'duplicate';
    const rank = STATUS_ORDER.indexOf(s.status);
    if (rank < 0 && s.status !== 'failed') {
      await finish(c, eventId, 'ignored', 'Unknown status.');
      return 'ignored';
    }
    // Meta's error code and title only: they describe the failure, never the message content.
    const error = s.status === 'failed' ? (s.errors?.[0] ? `${s.errors[0].code ?? ''} ${s.errors[0].title ?? ''}`.trim() : 'Delivery failed.') : null;
    const { rowCount } = await c.query(
      `UPDATE messages SET status = $2, error_message = COALESCE($3, error_message)
       WHERE whatsapp_message_id = $1 AND direction = 'outbound'
         AND ($2 = 'failed' OR array_position($4::text[], status) < $5)`,
      [s.id, s.status, error, STATUS_ORDER, rank + 1],
    );
    await finish(c, eventId, rowCount ? 'processed' : 'ignored', rowCount ? null : 'No matching outbound message, or a later status was already recorded.');
    return rowCount ? 'processed' : 'ignored';
  });
}

/**
 * Processes every message and status in a verified webhook. Each item has its own transaction, so a database
 * error rolls back only that item and is thrown: Meta then retries, and items already saved count as duplicates.
 */
export async function processWebhook(payload: WebhookPayload): Promise<WebhookResult> {
  const result: WebhookResult = { processed: 0, duplicate: 0, ignored: 0, failed: 0 };
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
      result[await handleMessage(m, names.get(m.from))] += 1;
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
