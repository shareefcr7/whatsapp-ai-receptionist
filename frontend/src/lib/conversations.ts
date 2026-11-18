import type { ConversationEventAction, ConversationMessage, ConversationStatus } from './api';

export type Tone = 'ai' | 'staff' | 'waiting' | 'closed';

/** Who is answering this customer right now. */
export function handledBy(status: string, assignedStaffName: string | null): { label: string; tone: Tone } {
  switch (status) {
    case 'open':
      return { label: 'AI', tone: 'ai' };
    case 'handover_requested':
      return { label: 'Waiting for staff', tone: 'waiting' };
    case 'human_active':
      return { label: assignedStaffName ? `Staff · ${assignedStaffName}` : 'Staff', tone: 'staff' };
    default:
      return { label: 'Closed', tone: 'closed' };
  }
}

export type ConversationAction = 'takeover' | 'reopen' | 'close' | 'reply' | 'reactivate';

/** The actions the backend will accept in this state. The backend still checks every one. */
export function availableActions(c: { status: ConversationStatus; optedOut: boolean }, isAdmin: boolean): Set<ConversationAction> {
  const actions = new Set<ConversationAction>();
  if (c.optedOut && isAdmin) actions.add('reactivate');
  if (c.status === 'closed') return actions;
  actions.add('close');
  if (c.status !== 'human_active') actions.add('takeover');
  if (c.status !== 'open') actions.add('reopen');
  if (!c.optedOut) actions.add('reply');
  return actions;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True when the customer last wrote more than 24 hours ago (or never), so WhatsApp will refuse a free-form reply.
 * Meta decides; this only warns before staff type a message.
 */
export function outsideReplyWindow(messages: ConversationMessage[], now = Date.now()): boolean {
  const lastInbound = messages.findLast((m) => m.direction === 'inbound');
  return !lastInbound || now - new Date(lastInbound.createdAt).getTime() > DAY_MS;
}

const FRIENDLY: Record<string, string> = {
  WHATSAPP_WINDOW_CLOSED:
    'Not sent: the customer last wrote more than 24 hours ago, and WhatsApp only allows replies within 24 hours of their last message. The reply is saved as failed. You can reply once they message again.',
  CUSTOMER_OPTED_OUT: 'Not sent: this customer opted out of messages. An admin must reactivate them before anyone can message them.',
  CONVERSATION_CLOSED: 'This conversation is closed. A new one starts when the customer writes again.',
  FORBIDDEN: 'Only an admin can do this.',
  NOT_FOUND: 'This conversation no longer exists.',
  WHATSAPP_RECIPIENT_NOT_ALLOWED: 'Not sent: this number is not on the WhatsApp test recipient list. Add it in Meta API Setup.',
  WHATSAPP_NOT_CONFIGURED: 'Not sent: WhatsApp is not configured on the server.',
  WHATSAPP_AUTH_FAILED: 'Not sent: the WhatsApp access token was rejected. An admin must replace it.',
  WHATSAPP_RATE_LIMITED: 'Not sent: WhatsApp is rate limiting messages. Try again in a minute.',
  WHATSAPP_UNREACHABLE: 'Not sent: could not connect to WhatsApp. Your draft is kept; try again shortly.',
  CONVERSATION_BUSY: 'This conversation is busy (a message is being sent). Try again in a few seconds.',
  DUPLICATE_SUBMISSION: 'This message was already submitted. Refresh the page to see it.',
  DRAFT_CHANGED: 'This draft was already submitted with different text. Press Send again to send the edited text as a new message.',
};

/** A message staff can act on, for an error from a conversation action. Unknown codes keep the server's safe message. */
export function actionErrorMessage(error: { code: string; message: string }): string {
  return FRIENDLY[error.code] ?? error.message;
}

export const SENDER_LABELS: Record<ConversationMessage['senderType'], string> = {
  customer: 'Customer',
  ai: 'AI',
  staff: 'Staff',
  system: 'System',
};

/**
 * What the conversation page shows for a load error. A refresh failure with data already on screen is only a warning,
 * so the reply form (and its unsent draft) stays mounted; the full error screen is for a first load that never worked.
 */
export function errorDisplay(hasData: boolean, error: unknown): 'none' | 'warning' | 'full' {
  if (!error) return 'none';
  return hasData ? 'warning' : 'full';
}

export type DeliveryTone = 'pending' | 'ok' | 'warn' | 'bad';

/** How an outbound message's delivery is shown. 'unknown' gets an explanation, because it may have arrived. */
export function deliveryDisplay(status: string): { label: string; tone: DeliveryTone; note?: string } {
  switch (status) {
    case 'queued':
      return { label: 'Sending…', tone: 'pending' };
    case 'sent':
      return { label: 'Sent', tone: 'ok' };
    case 'delivered':
      return { label: 'Delivered', tone: 'ok' };
    case 'read':
      return { label: 'Read', tone: 'ok' };
    case 'failed':
      return { label: 'Not delivered', tone: 'bad' };
    case 'unknown':
      return {
        label: 'Delivery unknown',
        tone: 'warn',
        note: 'WhatsApp did not confirm this message. It may already have reached the customer, so check before sending it again.',
      };
    default:
      return { label: status, tone: 'pending' };
  }
}

export const EVENT_LABELS: Record<ConversationEventAction, string> = {
  staff_reply: 'sent a reply',
  takeover: 'took over the conversation',
  reopen: 'handed it back to the AI',
  close: 'closed the conversation',
  reactivate: 'reactivated the customer',
};

/** What a send attempt returned: the message's status, or an error code (NETWORK_ERROR when nothing usable came back). */
export type ReplyAttempt = { ok: true; status: string } | { ok: false; code: string };
export type ReplyOutcome = 'sent' | 'unconfirmed' | 'failed' | 'refused';

const CONFIRMED_STATUSES = new Set(['sent', 'delivered', 'read']);
/** WhatsApp definitely refused it, and a failed message now holds the key: a retry must be a new message. */
const SEND_FAILED_CODES = new Set([
  'SEND_FAILED',
  'WHATSAPP_WINDOW_CLOSED',
  'WHATSAPP_RECIPIENT_NOT_ALLOWED',
  'WHATSAPP_AUTH_FAILED',
  'WHATSAPP_RATE_LIMITED',
  'WHATSAPP_UNREACHABLE',
  'WHATSAPP_NOT_CONFIGURED',
  'WHATSAPP_INVALID_RECIPIENT',
  'WHATSAPP_TEMPLATE_ERROR',
  'WHATSAPP_ERROR',
]);
/** Refused before anything was saved or sent: the key is still unused, so keeping it is harmless. */
const NOT_ATTEMPTED_CODES = new Set([
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'CUSTOMER_OPTED_OUT',
  'CONVERSATION_CLOSED',
  'CONVERSATION_BUSY',
  'NOT_FOUND',
  'FORBIDDEN',
  'FORBIDDEN_ORIGIN',
  'UNAUTHENTICATED',
  'DUPLICATE_SUBMISSION',
  'DATABASE_NOT_CONFIGURED',
]);

/**
 * What a send attempt means for the draft and its key. Only a confirmed send clears the draft, and only a definite
 * WhatsApp refusal (or edited text) gets a new key. Everything ambiguous (no response, a proxy error page, a server or
 * database error, 'unknown', still 'queued') keeps the draft AND the key: resubmitting it unchanged returns the first
 * message from the server instead of sending it again.
 */
export function afterReplyAttempt(attempt: ReplyAttempt): { outcome: ReplyOutcome; clearDraft: boolean; newKey: boolean } {
  if (attempt.ok) {
    if (CONFIRMED_STATUSES.has(attempt.status)) return { outcome: 'sent', clearDraft: true, newKey: true };
    if (attempt.status === 'failed') return { outcome: 'failed', clearDraft: false, newKey: true };
    return { outcome: 'unconfirmed', clearDraft: false, newKey: false };
  }
  if (attempt.code === 'DRAFT_CHANGED') return { outcome: 'refused', clearDraft: false, newKey: true };
  if (SEND_FAILED_CODES.has(attempt.code)) return { outcome: 'failed', clearDraft: false, newKey: true };
  if (NOT_ATTEMPTED_CODES.has(attempt.code)) return { outcome: 'refused', clearDraft: false, newKey: false };
  return { outcome: 'unconfirmed', clearDraft: false, newKey: false };
}

/** A draft's key, and the text it was last submitted with (null: never submitted). */
export interface DraftKey {
  key: string;
  text: string | null;
}

/** The key to submit `text` with: the same one for the same text (a safe repeat), a new one once the text changed. */
export function keyForSubmit(draft: DraftKey, text: string): DraftKey {
  const trimmed = text.trim(); // the server compares trimmed text
  return draft.text !== null && draft.text !== trimmed ? { key: newDraftKey(), text: trimmed } : { key: draft.key, text: trimmed };
}

/** A random UUID for a draft. crypto.randomUUID needs a secure context, so plain-http development falls back. */
export function newDraftKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
