import type { PoolClient } from 'pg';
import { inTransaction, query, requirePool, transaction, withSendSlot } from '../../database/pool.ts';
import { AppError } from '../../types/errors.ts';
import { deliveryUnknown, isDeliveryUnknown, whatsAppService } from '../whatsapp/index.ts';
import { applyLateStatuses } from '../whatsapp/webhook.ts';
import type { CONVERSATION_STATUSES, ListQuery, Page } from '../../types/api.ts';

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface Conversation {
  id: string;
  customerName: string | null;
  customerPhone: string;
  status: ConversationStatus;
  lastMessageAt: string | null;
  lastMessage: string | null;
  messageCount: number;
  optedOut: boolean;
  assignedStaffName: string | null;
}

export interface ConversationMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  senderType: 'customer' | 'ai' | 'staff' | 'system';
  messageType: string;
  content: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  /** The signed-in staff member who sent it (staff messages only). */
  staffName: string | null;
}

export interface ConversationEvent {
  id: string;
  action: 'staff_reply' | 'takeover' | 'reopen' | 'close' | 'reactivate';
  staffName: string;
  messageId: string | null;
  createdAt: string;
}

export interface ConversationDetail extends Omit<Conversation, 'lastMessage' | 'messageCount'> {
  optedOutAt: string | null;
  /** Why the open handover was requested, e.g. "AI daily limit reached". */
  handoverReason: string | null;
  messages: ConversationMessage[];
  /** Audit trail of staff actions, oldest first. */
  events: ConversationEvent[];
}

const MESSAGE_LIMIT = 100;
const EVENT_LIMIT = 100;
/** A send still 'queued' after this long was interrupted (e.g. a crash mid-send): shown as unknown, never resent. */
export const STUCK_SEND = '2 minutes';

export interface ConversationService {
  list(q: ListQuery<ConversationStatus>): Promise<Page<Conversation>>;
  get(id: string): Promise<ConversationDetail>;
}

export const conversationService: ConversationService = {
  async list({ page, limit, status }) {
    const [rows, count] = await Promise.all([
      query<Conversation & Record<string, unknown>>(
        `SELECT cv.id, c.name AS "customerName", c.phone_number AS "customerPhone", cv.status,
                cv.last_message_at AS "lastMessageAt", last.content AS "lastMessage",
                (SELECT count(*)::int FROM messages m WHERE m.conversation_id = cv.id) AS "messageCount",
                c.opted_out_at IS NOT NULL AS "optedOut", s.full_name AS "assignedStaffName"
         FROM conversations cv
         JOIN customers c ON c.id = cv.customer_id
         LEFT JOIN staff_users s ON s.id = cv.assigned_staff_id
         LEFT JOIN LATERAL (
           SELECT content FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.created_at DESC LIMIT 1
         ) last ON true
         WHERE ($1::text IS NULL OR cv.status = $1)
         ORDER BY cv.last_message_at DESC NULLS LAST, cv.created_at DESC LIMIT $2 OFFSET $3`,
        [status ?? null, limit, (page - 1) * limit],
      ),
      query<{ total: number }>(
        'SELECT count(*)::int AS total FROM conversations WHERE ($1::text IS NULL OR status = $1)',
        [status ?? null],
      ),
    ]);
    return { rows, total: count[0]?.total ?? 0 };
  },

  /** One conversation with its latest messages, oldest first. */
  async get(id) {
    const [conversation] = await query<Omit<ConversationDetail, 'messages' | 'events'> & Record<string, unknown>>(
      `SELECT cv.id, c.name AS "customerName", c.phone_number AS "customerPhone", cv.status,
              cv.last_message_at AS "lastMessageAt", c.opted_out_at IS NOT NULL AS "optedOut",
              c.opted_out_at AS "optedOutAt", s.full_name AS "assignedStaffName",
              (SELECT h.reason FROM handover_logs h WHERE h.conversation_id = cv.id AND h.status IN ('requested', 'accepted')
               ORDER BY h.requested_at DESC LIMIT 1) AS "handoverReason"
       FROM conversations cv
       JOIN customers c ON c.id = cv.customer_id
       LEFT JOIN staff_users s ON s.id = cv.assigned_staff_id
       WHERE cv.id = $1`,
      [id],
    );
    if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversation not found.');
    const messages = await query<ConversationMessage & Record<string, unknown>>(
      `SELECT id, direction, "senderType", "messageType", content, status, "errorMessage", "createdAt", "staffName" FROM (
         SELECT m.id, m.direction, m.sender_type AS "senderType", m.message_type AS "messageType", m.content,
                CASE WHEN m.status = 'queued' AND m.created_at < now() - $3::interval THEN 'unknown' ELSE m.status END AS status,
                m.error_message AS "errorMessage", m.created_at AS "createdAt", s.full_name AS "staffName"
         FROM messages m LEFT JOIN staff_users s ON s.id = m.staff_id
         WHERE m.conversation_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2
       ) m ORDER BY "createdAt", id`,
      [id, MESSAGE_LIMIT, STUCK_SEND],
    );
    const events = await query<ConversationEvent & Record<string, unknown>>(
      `SELECT id, action, "staffName", "messageId", "createdAt" FROM (
         SELECT e.id::text AS id, e.action, s.full_name AS "staffName", e.message_id AS "messageId", e.created_at AS "createdAt", e.id AS seq
         FROM conversation_events e JOIN staff_users s ON s.id = e.staff_id
         WHERE e.conversation_id = $1 ORDER BY e.id DESC LIMIT $2
       ) e ORDER BY seq`,
      [id, EVENT_LIMIT],
    );
    return { ...conversation, messages, events };
  },
};

/**
 * Serialises everything that can message a conversation or change who handles it: the AI send, staff replies,
 * takeover, reopen, close. An advisory lock, not a row lock, so incoming webhooks never wait on a send.
 * This is the transaction-scoped form; withConversationSend takes the same key at session level, and the two exclude
 * each other.
 */
export const lockConversation = (c: PoolClient, id: string) => c.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [id]);

/**
 * Runs `fn` holding the conversation lock across a WhatsApp send without a long-open transaction: a session-level
 * advisory lock on the same key. Writes inside commit as they go, so the outbound message row exists before the send
 * (a crash or database failure after Meta accepted it leaves a 'queued' row, and a delivery-status webhook can find
 * it). Takes a send slot first, then a connection: see withSendSlot.
 */
export function withConversationSend<T>(id: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withSendSlot(async () => {
    const client = await requirePool().connect();
    let reusable = true;
    try {
      // Bounded wait: a waiter holds a send slot and a connection, so one busy conversation must not hold them for
      // the length of another send (~46s). Session-level, so it is reset before anything else runs on this connection.
      try {
        await client.query(`SET lock_timeout = '${ACTION_LOCK_TIMEOUT}'`);
        await client.query('SELECT pg_advisory_lock(1, hashtext($1))', [id]);
      } catch (err) {
        throw busyOnLockTimeout(err); // nothing was saved or sent: a safe "busy", never a delivery failure
      } finally {
        await client.query('RESET lock_timeout').catch(() => (reusable = false));
      }
      try {
        return await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => {}); // a no-op unless fn failed inside a transaction
        // If the unlock fails, the connection is destroyed below, which releases the lock in PostgreSQL.
        await client.query('SELECT pg_advisory_unlock(1, hashtext($1))', [id]).catch(() => (reusable = false));
      }
    } finally {
      client.release(!reusable);
    }
  });
}

export type DeliveryResult =
  | { status: 'sent'; whatsappMessageId: string }
  | { status: 'failed' | 'unknown'; error: AppError };

/**
 * Sends an already-committed 'queued' outbound message and records the outcome: 'sent' (with WhatsApp's ID),
 * 'failed' (WhatsApp definitely refused it) or 'unknown' (no clear answer: it may have reached the customer).
 * Never retries an unknown send. A delivery status that already arrived is kept: only a 'queued' row is downgraded.
 */
export async function deliver(c: PoolClient, m: { id: string; conversationId: string; phone: string; text: string }): Promise<DeliveryResult> {
  let result: DeliveryResult;
  try {
    const { whatsappMessageId } = await whatsAppService.sendText(m.phone, m.text, m.id);
    result = { status: 'sent', whatsappMessageId };
  } catch (err) {
    // Only the sender's own AppErrors say what happened. Anything unexpected may have come after Meta accepted the
    // message, so it is 'unknown' (never resent), not a definite failure that invites a retry.
    const error = err instanceof AppError ? err : deliveryUnknown();
    result = { status: isDeliveryUnknown(error) ? 'unknown' : 'failed', error };
  }
  // From here Meta has answered: a database error must not turn that answer into an error for the caller, or a staff
  // retry could send the message again. The worst case is a row left 'queued', shown as unknown and never resent.
  if (result.status === 'sent') {
    const { whatsappMessageId } = result;
    // A status webhook may already have moved it on (sent/delivered/read): keep that.
    const markSent = () =>
      c.query(
        `UPDATE messages SET status = CASE WHEN status IN ('queued', 'unknown') THEN 'sent' ELSE status END, whatsapp_message_id = $2
         WHERE id = $1`,
        [m.id, whatsappMessageId],
      );
    try {
      await transaction(c, async () => {
        await markSent();
        await c.query(
          `INSERT INTO usage_logs (provider, operation, units, conversation_id, message_id) VALUES ('whatsapp', 'send_text', 1, $1, $2)`,
          [m.conversationId, m.id],
        );
        await c.query(`UPDATE conversations SET last_message_at = GREATEST(last_message_at, now()) WHERE id = $1`, [m.conversationId]);
        await applyLateStatuses(c, whatsappMessageId);
      });
    } catch (err) {
      console.error(`WhatsApp send accepted but not fully recorded: ${dbErrorCode(err)} (message ${m.id})`);
      // At least record that it went out, so a repeat of this submission replays "sent" instead of sending again.
      await markSent().catch((retryErr: unknown) => console.error(`WhatsApp send left queued: ${dbErrorCode(retryErr)} (message ${m.id})`));
    }
  } else {
    // AppError messages are written to be safe: Meta's body is never echoed.
    await c
      .query(`UPDATE messages SET status = $2, error_message = $3 WHERE id = $1 AND status = 'queued'`, [m.id, result.status, result.error.message])
      .catch((err: unknown) => console.error(`WhatsApp send outcome not recorded: ${dbErrorCode(err)} (message ${m.id})`));
  }
  return result;
}

/** A database error's code only: its message can quote row values. */
const dbErrorCode = (err: unknown) => (typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'UNEXPECTED');

const notFound = () => new AppError(404, 'NOT_FOUND', 'Conversation not found.');
const closed = () => new AppError(409, 'CONVERSATION_CLOSED', 'This conversation is closed.');

export type ConversationAction = 'takeover' | 'reopen' | 'close';
export type EventAction = ConversationAction | 'staff_reply' | 'reactivate';

/** Audit trail: who (always the signed-in staff member) did what, written in the same transaction as the action. */
const recordEvent = (c: PoolClient, conversationId: string, staffId: string, action: EventAction, messageId: string | null = null) =>
  c.query(`INSERT INTO conversation_events (conversation_id, staff_id, action, message_id) VALUES ($1, $2, $3, $4)`, [
    conversationId,
    staffId,
    action,
    messageId,
  ]);

async function takeOver(c: PoolClient, id: string, staffId: string) {
  await c.query(`UPDATE conversations SET status = 'human_active', assigned_staff_id = $2 WHERE id = $1`, [id, staffId]);
  await c.query(
    `UPDATE handover_logs SET status = 'accepted', staff_id = $2, accepted_at = now() WHERE conversation_id = $1 AND status = 'requested'`,
    [id, staffId],
  );
}

const resolveHandovers = (c: PoolClient, id: string) =>
  c.query(
    `UPDATE handover_logs SET status = 'resolved', resolved_at = now() WHERE conversation_id = $1 AND status IN ('requested', 'accepted')`,
    [id],
  );

/** How long a staff action waits for a conversation another request is using (e.g. a slow WhatsApp send). */
export const ACTION_LOCK_TIMEOUT = '3s';

/** PostgreSQL's lock_timeout error (55P03) becomes a safe 409; every other error passes through unchanged. */
export function busyOnLockTimeout(err: unknown): unknown {
  if ((err as { code?: unknown })?.code === '55P03') {
    return new AppError(409, 'CONVERSATION_BUSY', 'Conversation is busy. Please try again.');
  }
  return err;
}

type State = { id: string; status: ConversationStatus; assignedStaffId: string | null };
const readState = async (c: PoolClient, id: string) =>
  (await c.query<State>(`SELECT id, status, assigned_staff_id AS "assignedStaffId" FROM conversations WHERE id = $1`, [id])).rows[0];

/**
 * takeover: staff handles it and the AI stays silent. reopen: back to the AI. close: ends it; the next message opens a
 * new one. An audit event is written in the same transaction, only when the action changed something.
 */
export function changeConversation(id: string, action: ConversationAction, staffId: string) {
  return inTransaction(async (c) => {
    // Each waiting request holds a pool connection, so it must not wait out a slow send (up to ~46s): give up and say so.
    await c.query(`SET LOCAL lock_timeout = '${ACTION_LOCK_TIMEOUT}'`);
    await lockConversation(c, id);
    const before = await readState(c, id);
    if (!before) throw notFound();
    if (before.status === 'closed') {
      if (action !== 'close') throw closed();
    } else if (action === 'takeover') {
      await takeOver(c, id, staffId);
    } else {
      await c.query(
        action === 'reopen'
          ? `UPDATE conversations SET status = 'open', assigned_staff_id = NULL WHERE id = $1`
          : `UPDATE conversations SET status = 'closed', closed_at = now() WHERE id = $1`,
        [id],
      );
      await resolveHandovers(c, id);
    }
    const after = (await readState(c, id))!;
    if (after.status !== before.status || after.assignedStaffId !== before.assignedStaffId) {
      await recordEvent(c, id, staffId, action);
    }
    return after;
  }).catch((err: unknown) => {
    throw busyOnLockTimeout(err);
  });
}

export interface StaffMessage {
  id: string;
  status: string;
  whatsappMessageId: string | null;
}

/**
 * Sends a staff message and takes the conversation over, so the AI stops answering. The message row, the takeover and
 * the audit event commit together before the send; the outcome is then recorded. Returns the message with status
 * 'sent' or 'unknown'. A definite failure is saved and then thrown, so the dashboard can show Meta's reason.
 * A `clientMessageId` already used returns that message (replayed: true) and never sends again: 'queued' past
 * STUCK_SEND reads as 'unknown', a failed one throws SEND_FAILED, and different text throws DRAFT_CHANGED.
 */
export function staffReply(id: string, staffId: string, text: string, clientMessageId?: string): Promise<StaffMessage & { replayed: boolean }> {
  return withConversationSend(id, async (c) => {
    // Under the conversation lock, so two copies of the same submission cannot both pass this check.
    if (clientMessageId) {
      const { rows: [existing] } = await c.query<StaffMessage & { conversationId: string; content: string; errorMessage: string | null }>(
        `SELECT id, whatsapp_message_id AS "whatsappMessageId", conversation_id AS "conversationId", content,
                error_message AS "errorMessage",
                CASE WHEN status = 'queued' AND created_at < now() - $2::interval THEN 'unknown' ELSE status END AS status
         FROM messages WHERE client_message_id = $1`,
        [clientMessageId, STUCK_SEND],
      );
      if (existing) {
        // Never sent again, whatever happened to it. The caller learns its real state.
        if (existing.conversationId !== id) throw new AppError(409, 'DUPLICATE_SUBMISSION', 'This message was already submitted elsewhere.');
        if (existing.content !== text) {
          throw new AppError(409, 'DRAFT_CHANGED', 'This draft was already submitted with different text. Send the edited text as a new message.');
        }
        if (existing.status === 'failed') {
          throw new AppError(409, 'SEND_FAILED', `Not sent: ${existing.errorMessage ?? 'WhatsApp refused this message.'}`);
        }
        return { id: existing.id, status: existing.status, whatsappMessageId: existing.whatsappMessageId, replayed: true };
      }
    }
    const { rows } = await c.query<{ status: string; phone: string; optedOut: boolean }>(
      `SELECT cv.status, cu.phone_number AS phone, cu.opted_out_at IS NOT NULL AS "optedOut"
       FROM conversations cv JOIN customers cu ON cu.id = cv.customer_id WHERE cv.id = $1`,
      [id],
    );
    const cv = rows[0];
    if (!cv) throw notFound();
    if (cv.status === 'closed') throw closed();
    if (cv.optedOut) throw new AppError(409, 'CUSTOMER_OPTED_OUT', 'This customer opted out of messages. An admin must reactivate them first.');

    const messageId = await transaction(c, async () => {
      const { rows: [saved] } = await c.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, direction, sender_type, message_type, content, status, staff_id, client_message_id)
         VALUES ($1, 'outbound', 'staff', 'text', $2, 'queued', $3, $4) RETURNING id`,
        [id, text, staffId, clientMessageId ?? null],
      );
      await takeOver(c, id, staffId);
      await recordEvent(c, id, staffId, 'staff_reply', saved!.id);
      return saved!.id;
    });
    const result = await deliver(c, { id: messageId, conversationId: id, phone: cv.phone, text });
    if (result.status === 'failed') throw result.error;
    return {
      id: messageId,
      status: result.status,
      whatsappMessageId: result.status === 'sent' ? result.whatsappMessageId : null,
      replayed: false,
    };
  });
}

/** Staff-only undo of an opt-out, with an audit event. Nothing a customer sends can do this. */
export function reactivateCustomer(conversationId: string, staffId: string) {
  return inTransaction(async (c) => {
    const { rows: [target] } = await c.query<{ customerId: string; wasOptedOut: boolean }>(
      `SELECT cu.id AS "customerId", cu.opted_out_at IS NOT NULL AS "wasOptedOut"
       FROM conversations cv JOIN customers cu ON cu.id = cv.customer_id WHERE cv.id = $1 FOR UPDATE OF cu`,
      [conversationId],
    );
    if (!target) throw notFound();
    if (target.wasOptedOut) {
      await c.query(`UPDATE customers SET opted_out_at = NULL WHERE id = $1`, [target.customerId]);
      await recordEvent(c, conversationId, staffId, 'reactivate');
    }
    return { customerId: target.customerId, optedOut: false };
  });
}
