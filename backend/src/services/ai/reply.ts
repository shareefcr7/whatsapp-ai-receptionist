import type { PoolClient } from 'pg';
import { env } from '../../config/env.ts';
import { inTransaction, isDatabaseConfigured, query, requirePool, transaction } from '../../database/pool.ts';
import { AppError } from '../../types/errors.ts';
import { deliver, withConversationSend } from '../conversations/index.ts';
import type { ReceivedMessage } from '../whatsapp/webhook.ts';
import { aiProvider, aiService, loadBusinessKnowledge } from './index.ts';
import type { AiReply } from './index.ts';

const HISTORY_LIMIT = 20;

export type ReplyOutcome =
  | 'disabled'
  | 'not_found'
  | 'closed'
  | 'staff_managed'
  | 'opted_out'
  | 'no_text'
  | 'media_handover'
  | 'outdated'
  | 'stale'
  | 'limit_reached'
  | 'sent'
  | 'handover'
  | 'ai_failed'
  | 'send_failed'
  | 'send_unknown'
  | 'busy'
  | 'error';

interface Target {
  conversationId: string;
  content: string | null;
  messageType: string;
  status: string;
  staffAssigned: boolean;
  optedOut: boolean;
  isLatest: boolean;
  isStale: boolean;
  phone: string;
}

/** The inbound message with the state that decides whether the assistant may answer it. */
async function loadTarget(messageId: string, db: Pick<PoolClient, 'query'> = requirePool()): Promise<Target | undefined> {
  const { rows } = await db.query<Target>(
    `SELECT m.conversation_id AS "conversationId", m.content, m.message_type AS "messageType", cv.status,
            cv.assigned_staff_id IS NOT NULL AS "staffAssigned",
            c.opted_out_at IS NOT NULL AS "optedOut",
            c.phone_number AS phone,
            m.created_at < now() - make_interval(mins => $2) AS "isStale",
            NOT EXISTS (
              SELECT 1 FROM messages n
              -- Strictly newer: Meta timestamps are whole seconds, and a same-second tie must not leave both unanswered.
              -- A reaction (emoji on an earlier message) is not a new request, so it never supersedes one.
              WHERE n.conversation_id = m.conversation_id AND n.direction = 'inbound' AND n.created_at > m.created_at
                AND n.message_type <> 'reaction'
            ) AS "isLatest"
     FROM messages m
     JOIN conversations cv ON cv.id = m.conversation_id
     JOIN customers c ON c.id = cv.customer_id
     WHERE m.id = $1 AND m.direction = 'inbound'`,
    [messageId, env.AI_MAX_MESSAGE_AGE_MINUTES],
  );
  return rows[0];
}

function skipReason(t: Target | undefined): ReplyOutcome | null {
  if (!t) return 'not_found';
  if (t.status === 'closed') return 'closed';
  if (t.status !== 'open' || t.staffAssigned) return 'staff_managed';
  if (t.optedOut) return 'opted_out';
  if (t.messageType === 'reaction') return 'no_text'; // feedback on an earlier message: nothing to answer
  // The newer message gets the reply, with this one in its context.
  if (!t.isLatest) return 'outdated';
  return null; // the latest message; one without text is handed to staff in replyTo
}

/** Images, audio, video, documents, stickers, locations: the AI cannot read them, so staff should. */
export const MEDIA_HANDOVER_REASON = 'Customer sent media without text';

/** The latest text messages, oldest first. Failed outbound messages never reached the customer, so they are left out. */
const loadHistory = (conversationId: string) =>
  query<{ role: 'customer' | 'assistant'; content: string }>(
    `SELECT role, content FROM (
       SELECT CASE WHEN direction = 'inbound' THEN 'customer' ELSE 'assistant' END AS role, content, created_at, id
       FROM messages
       WHERE conversation_id = $1 AND content IS NOT NULL AND btrim(content) <> '' AND status <> 'failed'
       ORDER BY created_at DESC, id DESC
       LIMIT $2
     ) h ORDER BY created_at, id`,
    [conversationId, HISTORY_LIMIT],
  );

/** Moves an open conversation to the staff queue. One statement, and only from 'open': it never undoes a staff takeover. */
const handOver = (conversationId: string, reason: string) =>
  query(
    `WITH moved AS (
       UPDATE conversations SET status = 'handover_requested' WHERE id = $1 AND status = 'open' RETURNING id
     )
     INSERT INTO handover_logs (conversation_id, reason) SELECT id, $2 FROM moved`,
    [conversationId, reason],
  );

/**
 * Reserves one AI call (either provider) against the rolling 24-hour limits by inserting its usage_logs row up front. A global
 * advisory lock makes count-and-insert atomic, so concurrent requests (on any server) cannot overshoot.
 */
function reserveAiCall(conversationId: string): Promise<{ usageId: string } | { limit: 'customer' | 'daily' }> {
  const { provider, model } = aiProvider();
  return inTransaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(2, 0)');
    const { rows: [n] } = await c.query<{ total: number; customer: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE cv.customer_id = (SELECT customer_id FROM conversations WHERE id = $1))::int AS customer
       FROM usage_logs u LEFT JOIN conversations cv ON cv.id = u.conversation_id
       WHERE u.provider IN ('openai', 'anthropic') AND u.occurred_at > clock_timestamp() - interval '24 hours'`,
      [conversationId],
    );
    if (n!.customer >= env.AI_CUSTOMER_DAILY_REPLY_LIMIT) return { limit: 'customer' as const };
    if (n!.total >= env.AI_DAILY_REPLY_LIMIT) return { limit: 'daily' as const };
    const { rows: [row] } = await c.query<{ id: string }>(
      `INSERT INTO usage_logs (provider, operation, model, conversation_id, occurred_at)
       VALUES ($3, 'chat_completion', $2, $1, clock_timestamp()) RETURNING id`,
      [conversationId, model, provider],
    );
    return { usageId: row!.id };
  });
}

/**
 * Saves and sends the reply while holding the conversation lock, after a last check that the AI may still answer.
 * withConversationSend takes a send slot first (bounded connections) and commits the 'queued' row before the send.
 */
function sendReply(conversationId: string, messageId: string, reply: AiReply, usageId: string) {
  return withConversationSend(conversationId, async (c): Promise<{ outcome: ReplyOutcome; failure?: string }> => {
    // Re-read under the lock: staff, an opt-out or a newer message may have arrived while the AI was answering.
    const target = await loadTarget(messageId, c);
    const late = skipReason(target);
    if (late) return { outcome: late };
    const messageRowId = await transaction(c, async () => {
      const { rows: [saved] } = await c.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, direction, sender_type, message_type, content, status)
         VALUES ($1, 'outbound', 'ai', 'text', $2, 'queued') RETURNING id`,
        [conversationId, reply.text],
      );
      await c.query(`UPDATE usage_logs SET message_id = $2 WHERE id = $1`, [usageId, saved!.id]);
      return saved!.id;
    });
    const result = await deliver(c, { id: messageRowId, conversationId, phone: target!.phone, text: reply.text });
    if (result.status === 'sent') return { outcome: 'sent' };
    // Not retried either way: an unknown send may already be on the customer's phone.
    return { outcome: result.status === 'unknown' ? 'send_unknown' : 'send_failed', failure: result.error.code };
  });
}

async function replyTo(messageId: string): Promise<ReplyOutcome> {
  const target = await loadTarget(messageId);
  const skip = skipReason(target);
  if (skip) return skip;
  const { conversationId, isStale } = target!;
  if (!target!.content?.trim()) {
    await handOver(conversationId, MEDIA_HANDOVER_REASON); // no AI call
    return 'media_handover';
  }
  if (isStale) {
    await handOver(conversationId, `Message older than ${env.AI_MAX_MESSAGE_AGE_MINUTES} minutes; not answered by AI`);
    return 'stale';
  }

  const [history, businessKnowledge] = await Promise.all([loadHistory(conversationId), loadBusinessKnowledge()]);
  const reservation = await reserveAiCall(conversationId);
  if ('limit' in reservation) {
    await handOver(conversationId, `AI ${reservation.limit === 'customer' ? 'per-customer' : 'daily'} limit reached`);
    return 'limit_reached';
  }
  let reply: AiReply;
  try {
    reply = await aiService.generateReply({ conversationId, history, businessKnowledge });
  } catch (err) {
    // Nothing was billed: release the reservation.
    await query(`DELETE FROM usage_logs WHERE id = $1`, [reservation.usageId]);
    await handOver(conversationId, `AI reply failed: ${err instanceof AppError ? err.code : 'AI_ERROR'}`);
    return 'ai_failed';
  }
  await query(`UPDATE usage_logs SET model = $2, input_tokens = $3, output_tokens = $4 WHERE id = $1`, [
    reservation.usageId,
    reply.model,
    reply.inputTokens,
    reply.outputTokens,
  ]);

  if (!reply.text) {
    await handOver(conversationId, 'AI requested a handover');
    return 'handover';
  }
  let sent: { outcome: ReplyOutcome; failure?: string };
  try {
    sent = await sendReply(conversationId, messageId, reply, reservation.usageId);
  } catch (err) {
    // The conversation lock was not free in time (a staff action or another send). Nothing was saved or sent, so this
    // is not a delivery failure; if the message stays unanswered, the recovery sweep hands it to staff.
    if (err instanceof AppError && err.code === 'CONVERSATION_BUSY') return 'busy';
    throw err;
  }
  const { outcome, failure } = sent;
  if (outcome === 'send_failed') await handOver(conversationId, `WhatsApp send failed: ${failure}`);
  // Staff should check with the customer before anything is sent again.
  if (outcome === 'send_unknown') await handOver(conversationId, 'WhatsApp did not confirm the AI reply (delivery unknown)');
  if (outcome === 'sent' && reply.requestsHandover) {
    await handOver(conversationId, 'AI requested a handover');
    return 'handover';
  }
  return outcome;
}

// ponytail: in-process queue keeps one reply per conversation in flight on this server. The conversation lock in
// sendReply keeps sends safe across servers; a second server could still make a duplicate AI call.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/** Error codes only: a database or network error message can quote customer data. */
const errorCode = (err: unknown) =>
  err instanceof AppError ? err.code : typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'UNEXPECTED';

/**
 * Answers newly received messages when AI_AUTO_REPLY_ENABLED is true. One message per conversation at a time;
 * never rejects. Logs carry the outcome and conversation ID only, never content or phone numbers.
 */
export async function replyToMessages(received: ReceivedMessage[]): Promise<ReplyOutcome[]> {
  if (!env.AI_AUTO_REPLY_ENABLED) return received.map(() => 'disabled');
  return Promise.all(
    received.map(({ messageId, conversationId }) =>
      enqueue(conversationId, () => replyTo(messageId)).then(
        (outcome) => {
          console.info(`AI auto-reply: ${outcome} (conversation ${conversationId})`);
          return outcome;
        },
        async (err: unknown): Promise<ReplyOutcome> => {
          const code = errorCode(err);
          console.error(`AI auto-reply: error ${code} (conversation ${conversationId})`);
          // Never leave the customer with "Handled by AI" and no answer: staff take it.
          try {
            await handOver(conversationId, `AI reply failed: unexpected error (${code})`);
          } catch (handoverErr) {
            console.error(`AI auto-reply: handover after error also failed: ${errorCode(handoverErr)} (conversation ${conversationId})`);
          }
          return 'error';
        },
      ),
    ),
  );
}

// --- Recovery: replies queued in memory are lost on a restart or deploy, and Meta's redelivery is a duplicate,
// so nothing would ever answer them. This finds them and hands them to staff.

/** Long enough for an in-flight reply on another server (AI call up to 30s with retries + WhatsApp retries) to finish first. */
export const RECOVERY_GRACE_MINUTES = 5;
const RECOVERY_INTERVAL_MS = 5 * 60_000;
export const RECOVERY_REASON = 'No AI reply was recorded (recovered after a restart or error)';
export const INTERRUPTED_REASON = 'AI reply was interrupted (delivery unknown)';
const INTERRUPTED_MESSAGE = 'Sending was interrupted. WhatsApp may or may not have delivered this message.';

/**
 * Step 1 marks sends left 'queued' past the grace period as unknown and hands interrupted AI replies to staff.
 * Step 2 hands over open, AI-handled conversations whose latest message (text or media, not a reaction) is from the customer, between
 * RECOVERY_GRACE_MINUTES and 24 hours old (older ones cannot be answered on WhatsApp anyway). Skips closed,
 * staff-managed and opted-out conversations, and ones this process is still answering. Idempotent: a conversation
 * moves from 'open' only once, and only then gets a handover_logs row. Returns how many were handed over.
 */
export async function recoverUnanswered(): Promise<number> {
  if (!env.AI_AUTO_REPLY_ENABLED) return 0; // with the AI off, it never took these conversations on
  const inFlight = [...queues.keys()];
  // 1. Sends interrupted mid-way (crash or deploy during the WhatsApp call) are left 'queued' for good. Mark them
  //    unknown (never resent: they may have arrived) and hand an AI one to staff. Row locks make concurrent sweeps safe:
  //    a second sweep re-checks status = 'queued' after the first commits and finds nothing.
  const interrupted = await query<{ conversation_id: string }>(
    `WITH stuck AS (
       UPDATE messages SET status = 'unknown', error_message = $3
       WHERE direction = 'outbound' AND status = 'queued' AND created_at < now() - make_interval(mins => $2)
         AND NOT (conversation_id::text = ANY($1::text[]))
       RETURNING conversation_id, sender_type
     ),
     moved AS (
       UPDATE conversations cv SET status = 'handover_requested'
       FROM customers c
       WHERE cv.id IN (SELECT conversation_id FROM stuck WHERE sender_type = 'ai') AND c.id = cv.customer_id
         AND cv.status = 'open' AND cv.assigned_staff_id IS NULL AND c.opted_out_at IS NULL
       RETURNING cv.id
     )
     INSERT INTO handover_logs (conversation_id, reason) SELECT id, $4 FROM moved RETURNING conversation_id`,
    [inFlight, RECOVERY_GRACE_MINUTES, INTERRUPTED_MESSAGE, INTERRUPTED_REASON],
  );
  // 2. Customer messages nobody answered (the in-memory queue was lost).
  const rows = await query<{ conversation_id: string }>(
    `WITH unanswered AS (
       SELECT cv.id
       FROM conversations cv
       JOIN customers c ON c.id = cv.customer_id
       CROSS JOIN LATERAL (
         SELECT m.direction, m.created_at FROM messages m
         -- Any customer message except a reaction (media without text included); outbound only with text.
         WHERE m.conversation_id = cv.id AND m.status <> 'failed' AND m.message_type <> 'reaction'
           AND (m.direction = 'inbound' OR (m.content IS NOT NULL AND btrim(m.content) <> ''))
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1
       ) last
       WHERE cv.status = 'open' AND cv.assigned_staff_id IS NULL AND c.opted_out_at IS NULL
         AND NOT (cv.id::text = ANY($1::text[]))
         AND last.direction = 'inbound'
         AND last.created_at < now() - make_interval(mins => $2)
         AND last.created_at > now() - interval '24 hours'
         -- Staff handed it back to the AI after this message: their decision stands until the customer writes again.
         AND NOT EXISTS (
           SELECT 1 FROM conversation_events e
           WHERE e.conversation_id = cv.id AND e.action = 'reopen' AND e.created_at >= last.created_at
         )
     ),
     moved AS (
       UPDATE conversations SET status = 'handover_requested'
       WHERE id IN (SELECT id FROM unanswered) AND status = 'open' AND assigned_staff_id IS NULL
       RETURNING id
     )
     INSERT INTO handover_logs (conversation_id, reason) SELECT id, $3 FROM moved RETURNING conversation_id`,
    [inFlight, RECOVERY_GRACE_MINUTES, RECOVERY_REASON],
  );
  return interrupted.length + rows.length;
}

async function runRecovery() {
  try {
    const n = await recoverUnanswered();
    if (n) console.warn(`AI recovery: handed ${n} unanswered conversation(s) to staff`); // a count only
  } catch (err) {
    console.error(`AI recovery: error ${errorCode(err)}`);
  }
}

/** Runs recovery at startup and every 5 minutes. Does nothing unless auto-reply is on and a database is set. */
export function startRecovery(): void {
  if (!env.AI_AUTO_REPLY_ENABLED || !isDatabaseConfigured) return;
  void runRecovery();
  setInterval(() => void runRecovery(), RECOVERY_INTERVAL_MS).unref();
}
