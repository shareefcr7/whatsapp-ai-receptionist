import { query } from '../../database/pool.ts';
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
}

export interface ConversationService {
  list(q: ListQuery<ConversationStatus>): Promise<Page<Conversation>>;
}

export const conversationService: ConversationService = {
  async list({ page, limit, status }) {
    const [rows, count] = await Promise.all([
      query<Conversation & Record<string, unknown>>(
        `SELECT cv.id, c.name AS "customerName", c.phone_number AS "customerPhone", cv.status,
                cv.last_message_at AS "lastMessageAt", last.content AS "lastMessage",
                (SELECT count(*)::int FROM messages m WHERE m.conversation_id = cv.id) AS "messageCount"
         FROM conversations cv
         JOIN customers c ON c.id = cv.customer_id
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
};
