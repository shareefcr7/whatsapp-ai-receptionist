// Meta is mocked: no test contacts WhatsApp. Persistence tests need TEST_DATABASE_URL (a DISPOSABLE database).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const APP_SECRET = 'test-app-secret-0123456789abcdef';
const PHONE_NUMBER_ID = '111111111111111';
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl ?? '',
  WHATSAPP_ACCESS_TOKEN: 'EAAtest-access-token',
  WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
  WHATSAPP_BUSINESS_ACCOUNT_ID: '222222222222222',
  WHATSAPP_VERIFY_TOKEN: 'verify-token-for-tests-0123456789',
  WHATSAPP_APP_SECRET: APP_SECRET,
});

const { app } = await import('../src/app.ts');
const { env } = await import('../src/config/env.ts');
const { closePool, pool } = await import('../src/database/pool.ts');
const { migrate } = await import('../src/database/migrate.ts');
const { whatsAppService, GRAPH_VERSION } = await import('../src/services/whatsapp/index.ts');
const { messageText } = await import('../src/services/whatsapp/webhook.ts');

// --- Meta mock: non-local requests go to `meta` and are recorded.
interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let meta: (call: Call, n: number) => Response | Promise<Response> = () => {
  throw new Error('unexpected Meta call');
};
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (new URL(url).hostname === '127.0.0.1') return realFetch(input, init);
  const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
  calls.push(call);
  return meta(call, calls.length);
}) as typeof fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const networkError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

let server: Server;
let base: string;
before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}/api/webhooks/whatsapp`;
  if (testDatabaseUrl) await migrate();
});
after(async () => {
  server.close();
  if (testDatabaseUrl) {
    await pool!.query(`DELETE FROM webhook_events WHERE source = 'whatsapp'`);
    await pool!.query(`DELETE FROM customers WHERE phone_number LIKE '+1555000%'`); // cascades to conversations and messages
  }
  await closePool();
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  calls = [];
  meta = () => {
    throw new Error('unexpected Meta call');
  };
});

const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
async function post(body: string, signature: string | null = sign(body)) {
  const res = await realFetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature !== null && { 'x-hub-signature-256': signature }) },
    body,
  });
  return { status: res.status, body: (await res.json()) as any };
}
const verify = async (params: Record<string, string>) => {
  const res = await realFetch(`${base}?${new URLSearchParams(params)}`);
  return { status: res.status, text: await res.text() };
};

/** A webhook in Meta's shape. */
function payload(value: object, phoneNumberId = PHONE_NUMBER_ID) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '222222222222222', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...value } }] }],
  });
}
const textMessage = (id: string, from: string, body: string, timestamp = '1762850000') => ({
  contacts: [{ wa_id: from, profile: { name: 'Test Customer' } }],
  messages: [{ id, from, timestamp, type: 'text', text: { body } }],
});

describe('webhook verification (GET)', () => {
  const good = { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token-for-tests-0123456789', 'hub.challenge': '1158201444' };

  it('echoes the challenge as plain text when the token matches', async () => {
    const res = await realFetch(`${base}?${new URLSearchParams(good)}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '1158201444');
    assert.match(res.headers.get('content-type')!, /^text\/plain/);
  });

  it('refuses a wrong token, wrong mode, missing or unsafe challenge', async () => {
    for (const params of [
      { ...good, 'hub.verify_token': 'wrong' },
      { ...good, 'hub.mode': 'unsubscribe' },
      { 'hub.mode': 'subscribe', 'hub.verify_token': good['hub.verify_token'] },
      { ...good, 'hub.challenge': '<script>alert(1)</script>' },
      {},
    ] as Record<string, string>[]) {
      const { status, text } = await verify(params);
      assert.equal(status, 403, JSON.stringify(params));
      assert.ok(!text.includes('script'));
    }
  });
});

describe('webhook signature (POST)', () => {
  const body = JSON.stringify({ object: 'page', entry: [] }); // valid but not WhatsApp: needs no database

  it('accepts the exact raw bytes Meta signed, including whitespace', async () => {
    const pretty = JSON.stringify({ object: 'page', entry: [] }, null, 2);
    const { status, body: res } = await post(pretty, sign(pretty));
    assert.equal(status, 200);
    assert.deepEqual(res.data, { processed: 0, duplicate: 0, ignored: 1, failed: 0 });
  });

  const warnings = (fn: { mock: { calls: { arguments: unknown[] }[] } }) => fn.mock.calls.map((c) => String(c.arguments[0]));
  // Nothing from the request or the configuration may reach the log.
  const assertNoSensitiveData = (lines: string[], extra: string[] = []) => {
    for (const line of lines) {
      for (const secret of [APP_SECRET, 'EAAtest-access-token', 'verify-token-for-tests-0123456789', 'sha256=', ...extra]) {
        assert.ok(!line.includes(secret), `log leaked ${secret}: ${line}`);
      }
    }
  };

  it('rejects a missing, malformed, wrong-secret or other-body signature, and logs only the reason', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const signatures = [null, '', 'sha256=', 'sha1=abc', sign(body, 'another-secret'), sign(`${body} `), sign(body).toUpperCase()];
    for (const signature of signatures) {
      const { status, body: res } = await post(body, signature);
      assert.equal(status, 401, String(signature));
      assert.equal(res.error.code, 'INVALID_SIGNATURE');
    }
    assert.deepEqual(warnings(warn), signatures.map(() => 'WhatsApp webhook rejected: invalid signature'));
    assertNoSensitiveData(warnings(warn), [body]);
  });

  it('rejects an empty body and signed non-JSON, and logs only the reason', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    assert.equal((await post('', sign(''))).status, 400);
    assert.equal((await post('not json', sign('not json'))).status, 400);
    assert.deepEqual(warnings(warn), ['WhatsApp webhook rejected: empty body', 'WhatsApp webhook rejected: invalid JSON']);
    assertNoSensitiveData(warnings(warn), ['not json']);
  });

  it('returns 503 and logs the reason when the app secret is not configured', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const saved = env.WHATSAPP_APP_SECRET;
    env.WHATSAPP_APP_SECRET = undefined;
    try {
      const { status, body: res } = await post(body, sign(body));
      assert.equal(status, 503);
      assert.equal(res.error.code, 'WHATSAPP_NOT_CONFIGURED');
    } finally {
      env.WHATSAPP_APP_SECRET = saved;
    }
    assert.deepEqual(warnings(warn), ['WhatsApp webhook rejected: app secret not configured']);
    assertNoSensitiveData(warnings(warn), [body]);
  });

  it('logs no rejection for a valid delivery', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'info', () => {});
    assert.equal((await post(body, sign(body))).status, 200);
    assert.equal(warn.mock.callCount(), 0);
  });

  it('needs no session, and other JSON routes still parse JSON', async () => {
    const res = await realFetch(base.replace('/webhooks/whatsapp', '/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'x' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error.code, 'VALIDATION_ERROR'); // parsed, then validated
  });
});

describe('phone number ID filter and logging', () => {
  const META_SAMPLE_PHONE_NUMBER_ID = '123456123'; // what Meta's dashboard Test sends; test data only
  const lines = (fn: { mock: { calls: { arguments: unknown[] }[] } }) => fn.mock.calls.map((c) => String(c.arguments[0]));

  it("ignores Meta's dashboard sample, saves nothing, and logs the received ID", async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const info = t.mock.method(console, 'info', () => {});
    const { status, body } = await post(payload(textMessage('wamid.SAMPLE', '15550001999', 'sample text'), META_SAMPLE_PHONE_NUMBER_ID));
    assert.equal(status, 200);
    assert.deepEqual(body.data, { processed: 0, duplicate: 0, ignored: 1, failed: 0 });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(lines(warn)[0]!, /ignored a change for phone_number_id "123456123"/);
    assert.deepEqual(lines(info), ['WhatsApp webhook: processed=0 duplicate=0 ignored=1 failed=0']);
    // Never the message content, the sender, or the configured ID.
    for (const line of [...lines(warn), ...lines(info)]) {
      assert.ok(!line.includes('sample text') && !line.includes('15550001999') && !line.includes(PHONE_NUMBER_ID), line);
    }
  });

  it('does not warn for a non-WhatsApp object or another field', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'info', () => {});
    await post(JSON.stringify({ object: 'page', entry: [] }));
    const otherField = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'account_update', value: {} }] }] });
    assert.deepEqual((await post(otherField)).body.data, { processed: 0, duplicate: 0, ignored: 1, failed: 0 });
    assert.equal(warn.mock.callCount(), 0);
  });

  // With a database, the 'message persistence' suite proves the same payload is saved.
  it('lets the configured phone number ID through to persistence', { skip: Boolean(testDatabaseUrl) }, async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const { status, body } = await post(payload(textMessage('wamid.REAL', '15550001000', 'hello')));
    assert.equal(status, 503); // reached the save step: not ignored
    assert.equal(body.error.code, 'DATABASE_NOT_CONFIGURED');
    assert.equal(warn.mock.callCount(), 0);
  });
});

describe('message parsing', () => {
  it('extracts text from text, button, interactive and captioned media; null otherwise', () => {
    const base = { id: 'w', from: '15550001000' };
    assert.equal(messageText({ ...base, type: 'text', text: { body: 'Hello' } }), 'Hello');
    assert.equal(messageText({ ...base, type: 'button', button: { text: 'Yes' } }), 'Yes');
    assert.equal(messageText({ ...base, type: 'interactive', interactive: { button_reply: { title: 'Book' } } }), 'Book');
    assert.equal(messageText({ ...base, type: 'interactive', interactive: { list_reply: { title: 'Haircut' } } }), 'Haircut');
    assert.equal(messageText({ ...base, type: 'image', image: { caption: 'Look' } }), 'Look');
    assert.equal(messageText({ ...base, type: 'image' }), null);
    for (const type of ['sticker', 'location', 'audio', 'unsupported', 'reaction']) assert.equal(messageText({ ...base, type }), null);
  });
});

describe('sending (Meta mocked)', () => {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  it('sendText posts the Cloud API shape with the token only in the header', async () => {
    meta = () => json(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.OUT1' }] });
    assert.deepEqual(await whatsAppService.sendText('+15550001000', 'Hi there'), { whatsappMessageId: 'wamid.OUT1' });
    assert.equal(calls[0]!.url, url);
    assert.equal(calls[0]!.headers.Authorization, 'Bearer EAAtest-access-token');
    assert.deepEqual(calls[0]!.body, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550001000',
      type: 'text',
      text: { body: 'Hi there', preview_url: false },
    });
  });

  it('sendTemplate sends name, language and body parameters', async () => {
    meta = () => json(200, { messages: [{ id: 'wamid.T1' }] });
    await whatsAppService.sendTemplate('15550001000', 'appointment_reminder', 'en_US', ['Sam', '10:00']);
    await whatsAppService.sendTemplate('15550001000', 'hello_world', 'en_US', []);
    assert.deepEqual(calls[0]!.body.template, {
      name: 'appointment_reminder',
      language: { code: 'en_US' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Sam' }, { type: 'text', text: '10:00' }] }],
    });
    assert.deepEqual(calls[1]!.body.template, { name: 'hello_world', language: { code: 'en_US' } });
  });

  it('retries a 503 and a connection that never opened, then succeeds', async () => {
    meta = (_c, n) => (n === 1 ? json(503, {}) : json(200, { messages: [{ id: 'wamid.R1' }] }));
    assert.equal((await whatsAppService.sendText('+15550001000', 'x')).whatsappMessageId, 'wamid.R1');
    assert.equal(calls.length, 2);
    calls = [];
    meta = (_c, n) => {
      if (n === 1) throw networkError('ECONNREFUSED');
      return json(200, { messages: [{ id: 'wamid.R2' }] });
    };
    assert.equal((await whatsAppService.sendText('+15550001000', 'x')).whatsappMessageId, 'wamid.R2');
  });

  it('never retries a timeout, which may already have sent the message', async () => {
    meta = () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    await assert.rejects(whatsAppService.sendText('+15550001000', 'x'), { code: 'WHATSAPP_UNREACHABLE' });
    assert.equal(calls.length, 1);
  });

  it('gives up after three attempts on a persistent rate limit', async () => {
    meta = () => json(429, { error: { code: 130429 } });
    await assert.rejects(whatsAppService.sendText('+15550001000', 'x'), { code: 'WHATSAPP_RATE_LIMITED' });
    assert.equal(calls.length, 3);
  });

  it('maps Meta errors without echoing them, and does not retry them', async () => {
    const cases: [number, number, string][] = [
      [401, 190, 'WHATSAPP_AUTH_FAILED'],
      [400, 131030, 'WHATSAPP_RECIPIENT_NOT_ALLOWED'],
      [400, 131047, 'WHATSAPP_WINDOW_CLOSED'],
      [404, 132001, 'WHATSAPP_TEMPLATE_ERROR'],
      [400, 100, 'WHATSAPP_ERROR'],
    ];
    for (const [status, code, expected] of cases) {
      calls = [];
      meta = () => json(status, { error: { code, message: 'secret detail +15550001000' } });
      await assert.rejects(whatsAppService.sendText('+15550001000', 'x'), (err: any) => err.code === expected && !err.message.includes('secret detail'));
      assert.equal(calls.length, 1, expected);
    }
  });

  it('refuses an invalid recipient before calling Meta', async () => {
    for (const to of ['', '+0123', 'abc', '+1 555 000']) await assert.rejects(whatsAppService.sendText(to, 'x'), { code: 'WHATSAPP_INVALID_RECIPIENT' });
    assert.equal(calls.length, 0);
  });
});

describe('message persistence', { skip: !testDatabaseUrl }, () => {
  const count = async (sql: string, params: unknown[] = []) => (await pool!.query(sql, params)).rows[0].n as number;
  const messagesFor = (phone: string) =>
    pool!.query(
      `SELECT m.direction, m.sender_type, m.message_type, m.content, m.whatsapp_message_id, m.status, m.created_at, cv.id AS conversation_id
       FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN customers c ON c.id = cv.customer_id
       WHERE c.phone_number = $1 ORDER BY m.created_at`,
      [phone],
    );

  beforeEach(async () => {
    await pool!.query(`DELETE FROM webhook_events WHERE source = 'whatsapp'`);
    await pool!.query(`DELETE FROM customers WHERE phone_number LIKE '+1555000%'`);
  });

  it('saves the customer, an open conversation, the message and the webhook event', async () => {
    const { status, body } = await post(payload(textMessage('wamid.IN1', '15550001001', 'Do you open on Saturday?')));
    assert.equal(status, 200);
    assert.deepEqual(body.data, { processed: 1, duplicate: 0, ignored: 0, failed: 0 });

    const { rows: [customer] } = await pool!.query(`SELECT name FROM customers WHERE phone_number = '+15550001001'`);
    assert.equal(customer.name, 'Test Customer');
    const { rows } = await messagesFor('+15550001001');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].direction, 'inbound');
    assert.equal(rows[0].sender_type, 'customer');
    assert.equal(rows[0].content, 'Do you open on Saturday?');
    assert.equal(rows[0].status, 'received');
    assert.deepEqual(rows[0].created_at, new Date(1762850000 * 1000)); // Meta's timestamp, not arrival time

    const { rows: [conversation] } = await pool!.query(`SELECT status, last_message_at FROM conversations WHERE id = $1`, [rows[0].conversation_id]);
    assert.equal(conversation.status, 'open');
    assert.deepEqual(conversation.last_message_at, new Date(1762850000 * 1000));
    const { rows: [event] } = await pool!.query(`SELECT external_event_id, event_type, status FROM webhook_events WHERE source = 'whatsapp'`);
    assert.deepEqual(event, { external_event_id: 'message:wamid.IN1', event_type: 'message.text', status: 'processed' });
  });

  it('a redelivered webhook changes nothing', async () => {
    const body = payload(textMessage('wamid.DUP', '15550001002', 'Hi'));
    await post(body);
    const again = await post(body);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.data, { processed: 0, duplicate: 1, ignored: 0, failed: 0 });
    assert.equal(await count(`SELECT count(*)::int AS n FROM messages WHERE whatsapp_message_id = 'wamid.DUP'`), 1);
    assert.equal(await count(`SELECT count(*)::int AS n FROM webhook_events WHERE external_event_id = 'message:wamid.DUP'`), 1);
    assert.equal(await count(`SELECT count(*)::int AS n FROM conversations cv JOIN customers c ON c.id = cv.customer_id WHERE c.phone_number = '+15550001002'`), 1);
  });

  it('the same message batched differently is still a duplicate', async () => {
    await post(payload(textMessage('wamid.B1', '15550001003', 'one')));
    const both = { messages: [...textMessage('wamid.B1', '15550001003', 'one').messages, ...textMessage('wamid.B2', '15550001003', 'two', '1762850100').messages] };
    const { body } = await post(payload(both));
    assert.deepEqual(body.data, { processed: 1, duplicate: 1, ignored: 0, failed: 0 });
    const { rows } = await messagesFor('+15550001003');
    assert.deepEqual(rows.map((r) => r.content), ['one', 'two']);
    assert.equal(new Set(rows.map((r) => r.conversation_id)).size, 1); // one thread per customer
  });

  it('keeps unsupported types safely, with no invented content', async () => {
    const { body } = await post(payload({ messages: [
      { id: 'wamid.S1', from: '15550001004', timestamp: '1762850000', type: 'sticker', sticker: { id: 'media-1' } },
      { id: 'wamid.S2', from: '15550001004', timestamp: '1762850001', type: 'unsupported', errors: [{ code: 131051 }] },
    ] }));
    assert.deepEqual(body.data, { processed: 2, duplicate: 0, ignored: 0, failed: 0 });
    const { rows } = await messagesFor('+15550001004');
    assert.deepEqual(rows.map((r) => [r.message_type, r.content]), [['sticker', null], ['unsupported', null]]);
  });

  it('ignores other phone numbers, other fields and malformed items; records a bad sender as failed', async () => {
    const other = await post(payload(textMessage('wamid.X1', '15550001005', 'hi'), '999999999999999'));
    assert.deepEqual(other.body.data, { processed: 0, duplicate: 0, ignored: 1, failed: 0 });
    const field = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'account_update', value: {} }] }] });
    assert.deepEqual((await post(field)).body.data, { processed: 0, duplicate: 0, ignored: 1, failed: 0 });
    const malformed = await post(payload({ messages: [{ from: '15550001006', type: 'text' }] }));
    assert.deepEqual(malformed.body.data, { processed: 0, duplicate: 0, ignored: 1, failed: 0 });

    const bad = await post(payload(textMessage('wamid.BAD', '0123', 'hi')));
    assert.deepEqual(bad.body.data, { processed: 0, duplicate: 0, ignored: 0, failed: 1 });
    const { rows: [event] } = await pool!.query(`SELECT status, error_message FROM webhook_events WHERE external_event_id = 'message:wamid.BAD'`);
    assert.equal(event.status, 'failed');
    assert.ok(!event.error_message.includes('0123'));
    assert.equal(await count(`SELECT count(*)::int AS n FROM customers WHERE phone_number LIKE '+1555000100%'`), 0);
  });

  it('delivery statuses move forward only, and failures keep Meta’s reason', async () => {
    await post(payload(textMessage('wamid.SEED', '15550001007', 'hello')));
    const { rows: [{ conversation_id }] } = await messagesFor('+15550001007');
    await pool!.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, content, whatsapp_message_id, status)
       VALUES ($1, 'outbound', 'ai', 'reply', 'wamid.OUT', 'queued'), ($1, 'outbound', 'ai', 'reply 2', 'wamid.OUT2', 'sent')`,
      [conversation_id],
    );
    const status = (id: string, s: string, extra = {}) => post(payload({ statuses: [{ id, status: s, timestamp: '1762850000', recipient_id: '15550001007', ...extra }] }));
    const current = async (id: string) => (await pool!.query(`SELECT status, error_message FROM messages WHERE whatsapp_message_id = $1`, [id])).rows[0];

    for (const s of ['sent', 'delivered', 'read']) assert.equal((await status('wamid.OUT', s)).body.data.processed, 1);
    assert.equal((await current('wamid.OUT')).status, 'read');
    // A late "delivered" (new event id, so not a duplicate) must not move "read" backwards.
    await pool!.query(`DELETE FROM webhook_events WHERE external_event_id = 'status:wamid.OUT:delivered'`);
    assert.deepEqual((await status('wamid.OUT', 'delivered')).body.data, { processed: 0, duplicate: 0, ignored: 1, failed: 0 });
    assert.equal((await current('wamid.OUT')).status, 'read');
    assert.equal((await status('wamid.OUT', 'read')).body.data.duplicate, 1);

    await status('wamid.OUT2', 'failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] });
    assert.deepEqual(await current('wamid.OUT2'), { status: 'failed', error_message: '131026 Message undeliverable' });

    assert.equal((await status('wamid.UNKNOWN', 'delivered')).body.data.ignored, 1); // e.g. sent from Meta's own console
    assert.equal((await status('wamid.SEED', 'read')).body.data.ignored, 1); // inbound messages have no delivery status
    assert.equal((await current('wamid.SEED')).status, 'received');
  });
});
