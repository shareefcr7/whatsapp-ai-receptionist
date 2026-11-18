import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConversationMessage } from '../src/lib/api.ts';
import { actionErrorMessage, afterReplyAttempt, availableActions, deliveryDisplay, EVENT_LABELS, handledBy, keyForSubmit, newDraftKey, outsideReplyWindow } from '../src/lib/conversations.ts';

const sorted = (s: Set<string>) => [...s].sort();

describe('conversation actions', () => {
  it('offer only what the backend accepts in each state', () => {
    assert.deepEqual(sorted(availableActions({ status: 'open', optedOut: false }, false)), ['close', 'reply', 'takeover']);
    assert.deepEqual(sorted(availableActions({ status: 'handover_requested', optedOut: false }, false)), ['close', 'reopen', 'reply', 'takeover']);
    assert.deepEqual(sorted(availableActions({ status: 'human_active', optedOut: false }, false)), ['close', 'reopen', 'reply']);
    assert.deepEqual(sorted(availableActions({ status: 'closed', optedOut: false }, true)), []);
  });

  it('never offer a reply to an opted-out customer, and reactivation only to admins', () => {
    assert.deepEqual(sorted(availableActions({ status: 'human_active', optedOut: true }, false)), ['close', 'reopen']);
    assert.deepEqual(sorted(availableActions({ status: 'human_active', optedOut: true }, true)), ['close', 'reactivate', 'reopen']);
    assert.deepEqual(sorted(availableActions({ status: 'closed', optedOut: true }, true)), ['reactivate']);
    assert.ok(!availableActions({ status: 'open', optedOut: false }, true).has('reactivate'));
  });
});

describe('handled-by indicator', () => {
  it('names who is answering', () => {
    assert.deepEqual(handledBy('open', null), { label: 'AI', tone: 'ai' });
    assert.deepEqual(handledBy('handover_requested', null), { label: 'Waiting for staff', tone: 'waiting' });
    assert.deepEqual(handledBy('human_active', 'Sam'), { label: 'Staff · Sam', tone: 'staff' });
    assert.deepEqual(handledBy('human_active', null), { label: 'Staff', tone: 'staff' });
    assert.deepEqual(handledBy('closed', 'Sam'), { label: 'Closed', tone: 'closed' });
  });
});

describe('24-hour reply window', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const msg = (direction: 'inbound' | 'outbound', iso: string): ConversationMessage => ({
    id: iso,
    direction,
    senderType: direction === 'inbound' ? 'customer' : 'staff',
    messageType: 'text',
    content: 'x',
    status: 'sent',
    errorMessage: null,
    createdAt: iso,
  });

  it('is judged from the last customer message, not the last staff one', () => {
    assert.equal(outsideReplyWindow([msg('inbound', '2026-11-13T13:00:00Z')], now), false);
    assert.equal(outsideReplyWindow([msg('inbound', '2026-11-13T11:00:00Z')], now), true);
    assert.equal(outsideReplyWindow([msg('inbound', '2026-11-13T11:00:00Z'), msg('outbound', '2026-11-14T11:00:00Z')], now), true);
    assert.equal(outsideReplyWindow([], now), true);
  });
});

describe('action errors', () => {
  it('explain the 24-hour window and opt-out in plain words, and keep unknown messages', () => {
    assert.match(actionErrorMessage({ code: 'WHATSAPP_WINDOW_CLOSED', message: 'x' }), /24 hours/);
    assert.match(actionErrorMessage({ code: 'CUSTOMER_OPTED_OUT', message: 'x' }), /opted out/);
    // Unreachable now means it never left (a timeout is a separate "delivery unknown" state).
    assert.match(actionErrorMessage({ code: 'WHATSAPP_UNREACHABLE', message: 'x' }), /^Not sent: could not connect/);
    assert.match(actionErrorMessage({ code: 'CONVERSATION_BUSY', message: 'x' }), /busy/);
    assert.equal(actionErrorMessage({ code: 'SOMETHING_NEW', message: 'Server says no.' }), 'Server says no.');
  });
});

describe('delivery display', () => {
  it('shows sent, failed and delivery unknown distinctly, and explains unknown', () => {
    assert.deepEqual(deliveryDisplay('sent'), { label: 'Sent', tone: 'ok' });
    assert.deepEqual(deliveryDisplay('delivered'), { label: 'Delivered', tone: 'ok' });
    assert.deepEqual(deliveryDisplay('read'), { label: 'Read', tone: 'ok' });
    assert.deepEqual(deliveryDisplay('queued'), { label: 'Sending…', tone: 'pending' });
    assert.deepEqual(deliveryDisplay('failed'), { label: 'Not delivered', tone: 'bad' });
    const unknown = deliveryDisplay('unknown');
    assert.equal(unknown.label, 'Delivery unknown');
    assert.equal(unknown.tone, 'warn');
    assert.match(unknown.note!, /may already have reached the customer/);
  });
});

describe('reply drafts and duplicate protection (Step 10.5)', () => {
  const sent = (status: string) => afterReplyAttempt({ ok: true, status });
  const error = (code: string) => afterReplyAttempt({ ok: false, code });

  it('only a confirmed send clears the draft and shows success', () => {
    for (const status of ['sent', 'delivered', 'read']) assert.deepEqual(sent(status), { outcome: 'sent', clearDraft: true, newKey: true }, status);
  });

  it('every ambiguous outcome keeps the draft AND its key, so resending can only replay the first message', () => {
    const keep = { outcome: 'unconfirmed', clearDraft: false, newKey: false };
    assert.deepEqual(sent('unknown'), keep, 'WhatsApp did not confirm');
    assert.deepEqual(sent('queued'), keep, 'still sending');
    for (const code of ['NETWORK_ERROR', 'INTERNAL_ERROR', 'DATABASE_UNAVAILABLE', 'DATABASE_NOT_MIGRATED', 'UNKNOWN', 'SOMETHING_NEW']) {
      assert.deepEqual(error(code), keep, code); // no response, proxy page, or a server/database fault after Meta may have sent it
    }
  });

  it('a definite WhatsApp refusal (including a replayed one) keeps the text; retrying is a new message with a new key', () => {
    for (const code of ['SEND_FAILED', 'WHATSAPP_WINDOW_CLOSED', 'WHATSAPP_UNREACHABLE', 'WHATSAPP_RATE_LIMITED', 'WHATSAPP_ERROR', 'WHATSAPP_NOT_CONFIGURED']) {
      assert.deepEqual(error(code), { outcome: 'failed', clearDraft: false, newKey: true }, code);
    }
    assert.deepEqual(sent('failed'), { outcome: 'failed', clearDraft: false, newKey: true });
  });

  it('a refusal before anything was sent keeps the draft and the (unused) key; a changed draft gets a new key', () => {
    for (const code of ['CONVERSATION_BUSY', 'CUSTOMER_OPTED_OUT', 'CONVERSATION_CLOSED', 'VALIDATION_ERROR', 'UNAUTHENTICATED']) {
      assert.deepEqual(error(code), { outcome: 'refused', clearDraft: false, newKey: false }, code);
    }
    assert.deepEqual(error('DRAFT_CHANGED'), { outcome: 'refused', clearDraft: false, newKey: true });
  });

  it('never shows success for anything but a confirmed send', () => {
    const statuses = ['queued', 'unknown', 'failed', 'received', ''];
    const codes = ['NETWORK_ERROR', 'INTERNAL_ERROR', 'DATABASE_UNAVAILABLE', 'SEND_FAILED', 'DRAFT_CHANGED', 'CONVERSATION_BUSY', 'WHATSAPP_WINDOW_CLOSED', 'X'];
    for (const s of statuses) assert.notEqual(sent(s).outcome, 'sent', s);
    for (const c of codes) assert.notEqual(error(c).outcome, 'sent', c);
  });

  it('the same text keeps its key (a safe repeat); edited text gets a new key, so an edit is never replaced by the original', () => {
    const fresh = { key: 'k1', text: null };
    const first = keyForSubmit(fresh, 'Hello');
    assert.deepEqual(first, { key: 'k1', text: 'Hello' }); // a never-submitted draft keeps its key
    assert.deepEqual(keyForSubmit(first, '  Hello '), { key: 'k1', text: 'Hello' }); // same text after trimming
    const edited = keyForSubmit(first, 'Hello, see you at 9');
    assert.notEqual(edited.key, 'k1');
    assert.equal(edited.text, 'Hello, see you at 9');
  });

  it('draft keys are unique UUIDs, also without crypto.randomUUID (plain-http development)', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const keys = new Set(Array.from({ length: 200 }, newDraftKey));
    assert.equal(keys.size, 200);
    for (const k of keys) assert.match(k, UUID);
    const real = crypto.randomUUID;
    try {
      (crypto as { randomUUID?: unknown }).randomUUID = undefined;
      const fallback = new Set(Array.from({ length: 200 }, newDraftKey));
      assert.equal(fallback.size, 200);
      for (const k of fallback) assert.match(k, UUID);
    } finally {
      crypto.randomUUID = real;
    }
  });
});

describe('audit labels', () => {
  it('describe every recorded action', () => {
    assert.deepEqual(Object.keys(EVENT_LABELS).sort(), ['close', 'reactivate', 'reopen', 'staff_reply', 'takeover']);
  });
});
