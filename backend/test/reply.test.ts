// AI auto-reply. OpenAI, Anthropic and Meta are mocked through fetch: no test contacts any of them, and nothing is billed.
// Persistence tests need TEST_DATABASE_URL (a DISPOSABLE database).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { assertDisposableDatabaseUrl, isDatabaseVerified } from './helpers/db-hygiene.ts';
import type { WaMessage } from '../src/services/whatsapp/webhook.ts';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
assertDisposableDatabaseUrl(testDatabaseUrl); // before any hook: after() hooks still run if before() fails
const APP_SECRET = 'test-app-secret-0123456789abcdef';
const PHONE_NUMBER_ID = '111111111111111';
const OPENAI_KEY = 'sk-test-not-a-real-key';
const ACCESS_TOKEN = 'EAAtest-access-token';
Object.assign(process.env, {
  PGAPPNAME: 'receptionist-test', // tags this run's sessions; see test/helpers/db-hygiene.ts
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl ?? '',
  OPENAI_API_KEY: OPENAI_KEY,
  OPENAI_MODEL: 'test-model',
  AI_AUTO_REPLY_ENABLED: '', // the default must be off
  WHATSAPP_ACCESS_TOKEN: ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN: 'verify-token-for-tests-0123456789',
  WHATSAPP_APP_SECRET: APP_SECRET,
});

const { app } = await import('../src/app.ts');
const { env, parseEnv } = await import('../src/config/env.ts');
const { closePool, concurrencyLimit, MAX_CONCURRENT_SENDS, pool } = await import('../src/database/pool.ts');
const { migrate } = await import('../src/database/migrate.ts');
const { processWebhook } = await import('../src/services/whatsapp/webhook.ts');
const { INTERRUPTED_REASON, MEDIA_HANDOVER_REASON, recoverUnanswered, RECOVERY_REASON, replyToMessages } = await import('../src/services/ai/reply.ts');
const { prepareTestDatabase } = await import('./helpers/db-hygiene.ts');

// --- fetch mock: OpenAI and Meta calls are recorded and answered by the handlers below.
interface Call {
  body: any;
}
const realFetch = globalThis.fetch;
let openaiCalls: Call[] = [];
let metaCalls: Call[] = [];
let openai: (call: Call) => Response | Promise<Response>;
let anthropicCalls: Call[] = [];
let anthropic: (call: Call) => Response | Promise<Response>;
let meta: (call: Call) => Response | Promise<Response>;
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const call = { body: JSON.parse(String(init.body)) };
  if (url.hostname === 'api.openai.com') {
    openaiCalls.push(call);
    return openai(call);
  }
  if (url.hostname === 'api.anthropic.com') {
    anthropicCalls.push(call);
    return anthropic(call);
  }
  if (url.hostname === 'graph.facebook.com') {
    metaCalls.push(call);
    return meta(call);
  }
  throw new Error(`unexpected request to ${url.hostname}`);
}) as typeof fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const aiSays = (content: string) =>
  json(200, { model: 'test-model', choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 15 } });
let outSeq = 0; // unique like Meta's IDs, even for sends released in the same millisecond
const metaAccepts = () => json(200, { messages: [{ id: `wamid.OUT.${++outSeq}.${Date.now()}` }] });

let server: Server;
let base: string;
before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}/api/webhooks/whatsapp`;
  if (testDatabaseUrl) {
    await prepareTestDatabase(pool!); // refuses a non-_test database; recovers from an interrupted earlier run
    await migrate();
  }
});
const cleanup = async () => {
  await pool!.query(`DELETE FROM usage_logs WHERE conversation_id IN (
    SELECT cv.id FROM conversations cv JOIN customers c ON c.id = cv.customer_id WHERE c.phone_number LIKE '+15550002%')`);
  await pool!.query(`DELETE FROM webhook_events WHERE source = 'whatsapp' AND external_event_id LIKE 'message:wamid.AI%'`);
  // Test customers have audit history, which ordinary deletes refuse (005): use the documented erasure procedure.
  const c = await pool!.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL receptionist.audit_maintenance = 'on'`);
    await c.query(`DELETE FROM conversation_events WHERE conversation_id IN (
      SELECT cv.id FROM conversations cv JOIN customers cu ON cu.id = cv.customer_id WHERE cu.phone_number LIKE '+15550002%')`);
    await c.query(`DELETE FROM customers WHERE phone_number LIKE '+15550002%'`); // cascades to conversations and messages
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
  await pool!.query(`DELETE FROM business_info WHERE key = 'test_reply_faq'`);
};
after(async () => {
  server.close();
  // Only once the server confirmed a _test database: after() still runs when before() failed that check.
  try {
    if (testDatabaseUrl && isDatabaseVerified()) await cleanup();
  } finally {
    globalThis.fetch = realFetch;
    await closePool(); // also when the clean-up fails, so the run cannot hang on open connections
  }
});
beforeEach(() => {
  openaiCalls = [];
  metaCalls = [];
  openai = () => {
    throw new Error('unexpected OpenAI call');
  };
  anthropicCalls = [];
  anthropic = () => {
    throw new Error('unexpected Anthropic call');
  };
  meta = () => {
    throw new Error('unexpected Meta call');
  };
  env.AI_AUTO_REPLY_ENABLED = true;
});
const LIMIT_DEFAULTS = {
  AI_DAILY_REPLY_LIMIT: env.AI_DAILY_REPLY_LIMIT,
  AI_CUSTOMER_DAILY_REPLY_LIMIT: env.AI_CUSTOMER_DAILY_REPLY_LIMIT,
  AI_MAX_MESSAGE_AGE_MINUTES: env.AI_MAX_MESSAGE_AGE_MINUTES,
};
afterEach(() => {
  env.AI_AUTO_REPLY_ENABLED = false;
  Object.assign(env, LIMIT_DEFAULTS);
});

// --- webhook payloads in Meta's shape
function payload(messages: WaMessage[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, messages } }] }],
  };
}
let seq = 0;
// Meta timestamps (seconds) a few minutes old: inside AI_MAX_MESSAGE_AGE_MINUTES. T0 is for older history.
const NOW = Math.floor(Date.now() / 1000) - 120;
const T0 = NOW - 600;
const text = (from: string, body: string, timestamp = NOW + seq) => ({
  id: `wamid.AI${++seq}`,
  from,
  timestamp: String(timestamp),
  type: 'text',
  text: { body },
});
/** Saves inbound messages the way the webhook does, and returns what it hands to the reply service. */
const receive = async (...messages: WaMessage[]) => (await processWebhook(payload(messages))).received;

describe('AI_AUTO_REPLY_ENABLED', () => {
  it('defaults to off, and accepts only true or false', () => {
    assert.equal(parseEnv({}).AI_AUTO_REPLY_ENABLED, false);
    assert.equal(parseEnv({ AI_AUTO_REPLY_ENABLED: '' }).AI_AUTO_REPLY_ENABLED, false);
    assert.equal(parseEnv({ AI_AUTO_REPLY_ENABLED: 'false' }).AI_AUTO_REPLY_ENABLED, false);
    assert.equal(parseEnv({ AI_AUTO_REPLY_ENABLED: 'true' }).AI_AUTO_REPLY_ENABLED, true);
    assert.equal(parseEnv({ AI_AUTO_REPLY_ENABLED: ' TRUE ' }).AI_AUTO_REPLY_ENABLED, true);
    for (const v of ['yes', '1', 'on', 'ture']) {
      assert.throws(() => parseEnv({ AI_AUTO_REPLY_ENABLED: v }), /AI_AUTO_REPLY_ENABLED: must be "true" or "false"/);
    }
  });

  it('was off in this process until a test turned it on', () => {
    assert.equal(parseEnv(process.env).AI_AUTO_REPLY_ENABLED, false);
  });

  it('when off, nothing is read, called or logged', async (t) => {
    const info = t.mock.method(console, 'info', () => {});
    env.AI_AUTO_REPLY_ENABLED = false;
    const outcomes = await replyToMessages([{ messageId: '00000000-0000-4000-8000-000000000000', conversationId: 'c' }]);
    assert.deepEqual(outcomes, ['disabled']);
    assert.equal(openaiCalls.length + metaCalls.length, 0);
    assert.equal(info.mock.callCount(), 0);
  });

  it('background errors are caught and logged by code only', { skip: !testDatabaseUrl }, async (t) => {
    const error = t.mock.method(console, 'error', () => {});
    // Not a UUID: the database rejects the query.
    const outcomes = await replyToMessages([{ messageId: 'not-a-uuid +15550002999', conversationId: 'conv-x' }]);
    assert.deepEqual(outcomes, ['error']);
    // It then tries to hand over; with a made-up conversation ID that fails too, and says so by code only.
    assert.deepEqual(error.mock.calls.map((c) => c.arguments[0]), [
      'AI auto-reply: error 22P02 (conversation conv-x)',
      'AI auto-reply: handover after error also failed: 22P02 (conversation conv-x)',
    ]);
  });
});

describe('auto-reply (database)', { skip: !testDatabaseUrl }, () => {
  const q = async (sql: string, params: unknown[] = []) => (await pool!.query(sql, params)).rows;
  const conversationOf = async (phone: string) =>
    (await q(`SELECT cv.* FROM conversations cv JOIN customers c ON c.id = cv.customer_id WHERE c.phone_number = $1`, [phone]))[0];
  const messagesOf = (conversationId: string) =>
    q(`SELECT direction, sender_type, content, status, whatsapp_message_id, error_message, id FROM messages
       WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId]);
  const usageOf = (conversationId: string) =>
    q(`SELECT provider, operation, model, input_tokens, output_tokens, units, message_id FROM usage_logs
       WHERE conversation_id = $1 ORDER BY provider`, [conversationId]);
  const handoversOf = async (conversationId: string) =>
    (await q(`SELECT reason, status FROM handover_logs WHERE conversation_id = $1 ORDER BY created_at`, [conversationId])).map((r) => r.reason);

  beforeEach(cleanup);

  it('answers a text message from knowledge, sends it, and records the message and usage', async (t) => {
    t.mock.method(console, 'info', () => {});
    await q(`INSERT INTO business_info (key, category, title, content, is_published) VALUES ('test_reply_faq', 'faq', 'Parking', 'Free parking behind the building', true)`);
    openai = () => aiSays('Yes, parking is free behind the building.');
    meta = () => json(200, { messages: [{ id: 'wamid.OUT.ok' }] });

    const received = await receive(text('15550002001', 'Is there parking?'));
    assert.deepEqual(await replyToMessages(received), ['sent']);

    assert.equal(openaiCalls.length, 1);
    const [system, ...history] = openaiCalls[0]!.body.messages;
    assert.match(system.content, /Parking: Free parking behind the building/);
    assert.deepEqual(history, [{ role: 'user', content: 'Is there parking?' }]);
    assert.equal(metaCalls.length, 1);
    assert.equal(metaCalls[0]!.body.to, '15550002001');
    assert.deepEqual(metaCalls[0]!.body.text, { body: 'Yes, parking is free behind the building.', preview_url: false });

    const cv = await conversationOf('+15550002001');
    assert.equal(cv.status, 'open');
    const out = (await messagesOf(cv.id)).at(-1)!;
    assert.deepEqual(
      { ...out, id: undefined },
      { direction: 'outbound', sender_type: 'ai', content: 'Yes, parking is free behind the building.', status: 'sent', whatsapp_message_id: 'wamid.OUT.ok', error_message: null, id: undefined },
    );
    assert.deepEqual(await usageOf(cv.id), [
      { provider: 'openai', operation: 'chat_completion', model: 'test-model', input_tokens: 120, output_tokens: 15, units: 1, message_id: out.id },
      { provider: 'whatsapp', operation: 'send_text', model: null, input_tokens: 0, output_tokens: 0, units: 1, message_id: out.id },
    ]);
    assert.deepEqual(await handoversOf(cv.id), []);
  });

  it('AI_PROVIDER=anthropic: Claude answers through the same workflow, usage is recorded as anthropic, and the daily limits count both providers', async (t) => {
    t.mock.method(console, 'info', () => {});
    Object.assign(env, { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key', ANTHROPIC_MODEL: 'claude-sonnet-5-5' });
    t.after(() => Object.assign(env, { AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: undefined }));
    anthropic = () =>
      new Response(
        JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'We open at 9.' }], stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 30 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    meta = metaAccepts;

    assert.deepEqual(await replyToMessages(await receive(text('15550002090', 'When do you open?'))), ['sent']);
    assert.deepEqual([anthropicCalls.length, openaiCalls.length], [1, 0]);
    assert.deepEqual(anthropicCalls[0]!.body.messages, [{ role: 'user', content: 'When do you open?' }]);
    const cv = await conversationOf('+15550002090');
    const out = (await messagesOf(cv.id)).at(-1)!;
    assert.deepEqual([out.sender_type, out.content, out.status], ['ai', 'We open at 9.', 'sent']);
    assert.deepEqual((await usageOf(cv.id))[0], { provider: 'anthropic', operation: 'chat_completion', model: 'claude-sonnet-5-5', input_tokens: 200, output_tokens: 30, units: 1, message_id: out.id });

    // An earlier OpenAI call by the same customer counts towards the per-customer limit too.
    await q(`INSERT INTO usage_logs (provider, operation, conversation_id) VALUES ('openai', 'chat_completion', $1)`, [cv.id]);
    env.AI_CUSTOMER_DAILY_REPLY_LIMIT = 2;
    assert.deepEqual(await replyToMessages(await receive(text('15550002090', 'And on Sunday?'))), ['limit_reached']);
    assert.equal(anthropicCalls.length, 1);
  });

  it('sends the latest 20 text messages as context, oldest first, without media or failed replies', async (t) => {
    t.mock.method(console, 'info', () => {});
    const [first] = await receive(text('15550002002', 'message 0', T0));
    const cid = first!.conversationId;
    for (let i = 1; i <= 24; i++) {
      await q(
        `INSERT INTO messages (conversation_id, direction, sender_type, content, status, created_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
        [cid, i % 2 ? 'outbound' : 'inbound', i % 2 ? 'ai' : 'customer', `message ${i}`, i % 2 ? 'sent' : 'received', T0 + i],
      );
    }
    await q(`INSERT INTO messages (conversation_id, direction, sender_type, content, status, created_at)
             VALUES ($1, 'outbound', 'ai', 'never delivered', 'failed', to_timestamp(${T0 + 100}))`, [cid]);
    const latest = await receive(
      { id: `wamid.AI${++seq}`, from: '15550002002', timestamp: String(T0 + 200), type: 'image', image: {} },
      text('15550002002', 'latest question', T0 + 300),
    );
    openai = () => aiSays('Answer.');
    meta = metaAccepts;
    assert.deepEqual(await replyToMessages(latest), ['outdated', 'sent']); // the image is superseded by the later text

    const history = openaiCalls[0]!.body.messages.slice(1);
    assert.equal(history.length, 20);
    assert.deepEqual(history.at(-1), { role: 'user', content: 'latest question' });
    assert.deepEqual(history[0], { role: 'user', content: 'message 6' });
    assert.deepEqual(history[1], { role: 'assistant', content: 'message 7' });
    assert.ok(!history.some((m: any) => m.content === 'never delivered' || m.content === null));
  });

  it('a redelivered webhook is not answered twice', async (t) => {
    t.mock.method(console, 'info', () => {});
    const m = text('15550002003', 'Hello');
    const firstTime = await receive(m);
    assert.equal(firstTime.length, 1);
    assert.deepEqual(await receive(m), []);
    openai = () => aiSays('Hi!');
    meta = metaAccepts;
    await replyToMessages(firstTime);
    assert.equal(openaiCalls.length, 1);
  });

  it('skips closed, staff-managed and opted-out conversations, and media without text, without calling anyone', async (t) => {
    t.mock.method(console, 'info', () => {});
    const cases: [string, string, ReplyOutcomeName][] = [
      ['15550002010', `UPDATE customers SET opted_out_at = now() WHERE phone_number = '+15550002010'`, 'opted_out'],
      ['15550002011', `UPDATE conversations SET status = 'human_active' WHERE customer_id = (SELECT id FROM customers WHERE phone_number = '+15550002011')`, 'staff_managed'],
      ['15550002012', `UPDATE conversations SET status = 'handover_requested' WHERE customer_id = (SELECT id FROM customers WHERE phone_number = '+15550002012')`, 'staff_managed'],
      ['15550002013', `UPDATE conversations SET assigned_staff_id = (SELECT id FROM staff_users LIMIT 1) WHERE customer_id = (SELECT id FROM customers WHERE phone_number = '+15550002013')`, 'staff_managed'],
      ['15550002014', `UPDATE conversations SET status = 'closed', closed_at = now() WHERE customer_id = (SELECT id FROM customers WHERE phone_number = '+15550002014')`, 'closed'],
    ];
    // assigned_staff_id needs a staff row.
    await q(`DELETE FROM staff_users WHERE email = 'reply-test@example.test'`);
    await q(`INSERT INTO staff_users (email, full_name) VALUES ('reply-test@example.test', 'Reply Test')`);
    try {
      for (const [from, setup, expected] of cases) {
        const received = await receive(text(from, 'hello'));
        await q(setup);
        assert.deepEqual(await replyToMessages(received), [expected], from);
      }
      const media = await receive({ id: `wamid.AI${++seq}`, from: '15550002015', timestamp: String(NOW), type: 'sticker' });
      assert.deepEqual(await replyToMessages(media), ['media_handover']);
      assert.equal((await q(`SELECT cv.status FROM conversations cv JOIN customers c ON c.id = cv.customer_id WHERE c.phone_number = '+15550002015'`))[0].status, 'handover_requested');
      assert.equal(openaiCalls.length + metaCalls.length, 0);
    } finally {
      await q(`DELETE FROM staff_users WHERE email = 'reply-test@example.test'`);
    }
  });

  it('two messages in one delivery get one reply, to the latest, with both in context', async (t) => {
    t.mock.method(console, 'info', () => {});
    const received = await receive(text('15550002020', 'Hi', NOW), text('15550002020', 'Are you open today?', NOW + 1));
    openai = () => aiSays('Yes, until 5.');
    meta = metaAccepts;
    assert.deepEqual(await replyToMessages(received), ['outdated', 'sent']);
    assert.equal(openaiCalls.length, 1);
    assert.deepEqual(openaiCalls[0]!.body.messages.slice(1).map((m: any) => m.content), ['Hi', 'Are you open today?']);
    assert.equal(metaCalls.length, 1);
  });

  it('two messages in the same second, delivered separately, are both answered', async (t) => {
    t.mock.method(console, 'info', () => {});
    openai = () => aiSays('Answer.');
    meta = metaAccepts;
    const second = Math.floor(Date.now() / 1000) - 30;
    assert.deepEqual(await replyToMessages(await receive(text('15550002021', 'first', second))), ['sent']);
    assert.deepEqual(await replyToMessages(await receive(text('15550002021', 'second', second))), ['sent']);
  });

  it('handles one message per conversation at a time; a reply overtaken by a newer message is not sent', async (t) => {
    t.mock.method(console, 'info', () => {});
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    openai = async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      if (openaiCalls.length === 1) await gate;
      inFlight--;
      return aiSays(`reply ${openaiCalls.length}`);
    };
    meta = metaAccepts;

    const a = await receive(text('15550002030', 'first', NOW));
    const firstRun = replyToMessages(a);
    await until(() => openaiCalls.length > 0);
    const b = await receive(text('15550002030', 'second', NOW + 5));
    const secondRun = replyToMessages(b);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(openaiCalls.length, 1, 'the second message waits for the first');
    release();
    assert.deepEqual([...(await firstRun), ...(await secondRun)], ['outdated', 'sent']);
    assert.equal(maxInFlight, 1);
    assert.equal(metaCalls.length, 1);
    assert.equal(metaCalls[0]!.body.text.body, 'reply 2');
    const cv = await conversationOf('+15550002030');
    // Both OpenAI calls were billed: two usage rows, the unsent one tied to no message.
    const usage = await usageOf(cv.id);
    assert.equal(usage.filter((u) => u.provider === 'openai').length, 2);
    assert.equal(usage.filter((u) => u.provider === 'openai' && u.message_id === null).length, 1);
  });

  it('a staff takeover while OpenAI is answering stops the send', async (t) => {
    t.mock.method(console, 'info', () => {});
    const received = await receive(text('15550002031', 'Can I speak to someone?'));
    openai = async () => {
      await q(`UPDATE conversations SET status = 'human_active' WHERE id = $1`, [received[0]!.conversationId]);
      return aiSays('Sure.');
    };
    assert.deepEqual(await replyToMessages(received), ['staff_managed']);
    assert.equal(metaCalls.length, 0);
    assert.equal((await conversationOf('+15550002031')).status, 'human_active'); // left as staff set it
  });

  it('a handover request is sent without the marker and moves the conversation to staff', async (t) => {
    t.mock.method(console, 'info', () => {});
    const received = await receive(text('15550002040', 'I want to book'));
    openai = () => aiSays('A team member will follow up shortly.\n[HANDOVER]');
    meta = metaAccepts;
    assert.deepEqual(await replyToMessages(received), ['handover']);
    assert.equal(metaCalls[0]!.body.text.body, 'A team member will follow up shortly.');
    const cv = await conversationOf('+15550002040');
    assert.equal(cv.status, 'handover_requested');
    assert.deepEqual(await handoversOf(cv.id), ['AI requested a handover']);
  });

  it('an empty AI reply sends nothing and hands over', async (t) => {
    t.mock.method(console, 'info', () => {});
    const received = await receive(text('15550002041', 'hmm'));
    openai = () => aiSays('[HANDOVER]');
    assert.deepEqual(await replyToMessages(received), ['handover']);
    assert.equal(metaCalls.length, 0);
    const cv = await conversationOf('+15550002041');
    assert.equal(cv.status, 'handover_requested');
    assert.equal((await messagesOf(cv.id)).length, 1);
    assert.equal((await usageOf(cv.id)).length, 1); // OpenAI still billed
  });

  it('an OpenAI failure records the reason and hands over, with nothing sent', async (t) => {
    t.mock.method(console, 'info', () => {});
    const received = await receive(text('15550002050', 'Hello?'));
    openai = () => json(429, { error: { code: 'insufficient_quota', message: `key ${OPENAI_KEY}` } });
    assert.deepEqual(await replyToMessages(received), ['ai_failed']);
    assert.equal(metaCalls.length, 0);
    const cv = await conversationOf('+15550002050');
    assert.equal(cv.status, 'handover_requested');
    assert.deepEqual(await handoversOf(cv.id), ['AI reply failed: AI_NO_CREDITS']);
    assert.equal((await messagesOf(cv.id)).length, 1);
    assert.deepEqual(await usageOf(cv.id), []);
  });

  it('a WhatsApp failure saves the reply as failed, records OpenAI usage only, and hands over', async (t) => {
    t.mock.method(console, 'info', () => {});
    const received = await receive(text('15550002051', 'Hello?'));
    openai = () => aiSays('Hello! How can I help?');
    meta = () => json(400, { error: { code: 131047, message: 'detail +15550002051' } });
    assert.deepEqual(await replyToMessages(received), ['send_failed']);
    const cv = await conversationOf('+15550002051');
    const out = (await messagesOf(cv.id)).at(-1)!;
    assert.equal(out.status, 'failed');
    assert.equal(out.whatsapp_message_id, null);
    assert.match(out.error_message, /24 hours/);
    assert.ok(!out.error_message.includes('15550002051'));
    assert.deepEqual((await usageOf(cv.id)).map((u) => [u.provider, u.message_id]), [['openai', out.id]]);
    assert.equal(cv.status, 'handover_requested');
    assert.deepEqual(await handoversOf(cv.id), ['WhatsApp send failed: WHATSAPP_WINDOW_CLOSED']);
  });

  it('the webhook answers Meta first, with the same body, then replies in the background; logs hold no customer data', async (t) => {
    const lines: string[] = [];
    for (const level of ['info', 'warn', 'error', 'log'] as const) t.mock.method(console, level, (...args: unknown[]) => lines.push(args.map(String).join(' ')));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    openai = async () => {
      await gate; // OpenAI cannot answer until the test has Meta's response in hand
      return aiSays('Secret reply text');
    };
    meta = metaAccepts;
    const body = JSON.stringify(payload([text('15550002060', 'my private question')]));
    const res = await realFetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as any).data, { processed: 1, duplicate: 0, ignored: 0, failed: 0 });
    release();
    for (let i = 0; i < 100 && metaCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 100 && !lines.some((l) => l.startsWith('AI auto-reply')); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(metaCalls.length, 1);
    const cv = await conversationOf('+15550002060');
    assert.ok(lines.includes(`AI auto-reply: sent (conversation ${cv.id})`), lines.join('\n'));
    for (const line of lines) {
      for (const secret of ['my private question', 'Secret reply text', '15550002060', OPENAI_KEY, ACCESS_TOKEN, APP_SECRET]) {
        assert.ok(!line.includes(secret), `log leaked ${secret}: ${line}`);
      }
    }
  });

  it('with the switch off, the webhook saves the message and nothing else happens', async (t) => {
    t.mock.method(console, 'info', () => {});
    env.AI_AUTO_REPLY_ENABLED = false;
    const body = JSON.stringify(payload([text('15550002061', 'hello')]));
    const res = await realFetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
      body,
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(openaiCalls.length + metaCalls.length, 0);
    const cv = await conversationOf('+15550002061');
    assert.equal((await messagesOf(cv.id)).length, 1);
  });
});

describe('limit and age settings', () => {
  it('default to conservative values and reject nonsense', () => {
    const d = parseEnv({});
    assert.deepEqual([d.AI_DAILY_REPLY_LIMIT, d.AI_CUSTOMER_DAILY_REPLY_LIMIT, d.AI_MAX_MESSAGE_AGE_MINUTES], [200, 20, 15]);
    const set = parseEnv({ AI_DAILY_REPLY_LIMIT: '50', AI_CUSTOMER_DAILY_REPLY_LIMIT: '0', AI_MAX_MESSAGE_AGE_MINUTES: '5' });
    assert.deepEqual([set.AI_DAILY_REPLY_LIMIT, set.AI_CUSTOMER_DAILY_REPLY_LIMIT, set.AI_MAX_MESSAGE_AGE_MINUTES], [50, 0, 5]);
    for (const bad of [{ AI_DAILY_REPLY_LIMIT: '-1' }, { AI_CUSTOMER_DAILY_REPLY_LIMIT: 'lots' }, { AI_MAX_MESSAGE_AGE_MINUTES: '0' }, { AI_MAX_MESSAGE_AGE_MINUTES: '1.5' }]) {
      assert.throws(() => parseEnv(bad), /Invalid environment configuration/, JSON.stringify(bad));
    }
  });
});

describe('cost limits and stale messages (database)', { skip: !testDatabaseUrl }, () => {
  const q = async (sql: string, params: unknown[] = []) => (await pool!.query(sql, params)).rows;
  const statusOf = async (conversationId: string) => (await q(`SELECT status FROM conversations WHERE id = $1`, [conversationId]))[0].status;
  const handoverReasons = async (conversationId: string) =>
    (await q(`SELECT reason FROM handover_logs WHERE conversation_id = $1`, [conversationId])).map((r) => r.reason);
  const openAiCallsInLastDay = async () =>
    (await q(`SELECT count(*)::int AS n FROM usage_logs WHERE provider = 'openai' AND occurred_at > now() - interval '24 hours'`))[0].n as number;

  beforeEach(async (ctx) => {
    const t = ctx as TestContext;
    await cleanup();
    t.mock.method(console, 'info', () => {});
  });

  it('a message delivered later than the maximum age goes to staff without calling OpenAI; its redelivery is ignored', async () => {
    const late = text('15550002070', 'Are you open?', Math.floor(Date.now() / 1000) - 16 * 60); // default limit: 15 minutes
    const received = await receive(late);
    assert.deepEqual(await replyToMessages(received), ['stale']);
    assert.equal(openaiCalls.length + metaCalls.length, 0);
    const cid = received[0]!.conversationId;
    assert.equal(await statusOf(cid), 'handover_requested');
    assert.deepEqual(await handoverReasons(cid), ['Message older than 15 minutes; not answered by AI']);
    // Meta redelivers the same event: nothing new to answer, nothing logged twice.
    assert.deepEqual(await receive(late), []);
    assert.equal((await handoverReasons(cid)).length, 1);
  });

  it('the maximum age is configurable, and a message within it is answered', async () => {
    env.AI_MAX_MESSAGE_AGE_MINUTES = 1;
    const twoMinutesOld = Math.floor(Date.now() / 1000) - 120;
    assert.deepEqual(await replyToMessages(await receive(text('15550002071', 'hi', twoMinutesOld))), ['stale']);
    env.AI_MAX_MESSAGE_AGE_MINUTES = 5;
    openai = () => aiSays('Hello!');
    meta = metaAccepts;
    assert.deepEqual(await replyToMessages(await receive(text('15550002072', 'hi', twoMinutesOld))), ['sent']);
  });

  it('stops at the per-customer limit, before calling OpenAI, and hands over', async () => {
    env.AI_CUSTOMER_DAILY_REPLY_LIMIT = 2;
    openai = () => aiSays('Answer.');
    meta = metaAccepts;
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push(...(await replyToMessages(await receive(text('15550002073', `question ${i}`)))));
    assert.deepEqual(outcomes, ['sent', 'sent', 'limit_reached']);
    assert.equal(openaiCalls.length, 2);
    const [{ id: cid }] = await q(`SELECT cv.id FROM conversations cv JOIN customers c ON c.id = cv.customer_id WHERE c.phone_number = '+15550002073'`);
    assert.equal(await statusOf(cid), 'handover_requested');
    assert.deepEqual(await handoverReasons(cid), ['AI per-customer limit reached']);
    // Another customer is unaffected.
    assert.deepEqual(await replyToMessages(await receive(text('15550002074', 'hi'))), ['sent']);
  });

  it('stops at the daily limit across all customers; 0 turns AI replies off', async () => {
    openai = () => aiSays('Answer.');
    meta = metaAccepts;
    env.AI_DAILY_REPLY_LIMIT = (await openAiCallsInLastDay()) + 1;
    assert.deepEqual(await replyToMessages(await receive(text('15550002075', 'hi'))), ['sent']);
    const blocked = await receive(text('15550002076', 'hi'));
    assert.deepEqual(await replyToMessages(blocked), ['limit_reached']);
    assert.deepEqual(await handoverReasons(blocked[0]!.conversationId), ['AI daily limit reached']);
    env.AI_DAILY_REPLY_LIMIT = 0;
    assert.deepEqual(await replyToMessages(await receive(text('15550002077', 'hi'))), ['limit_reached']);
    assert.equal(openaiCalls.length, 1);
  });

  it('concurrent replies cannot overshoot the limit', async () => {
    env.AI_DAILY_REPLY_LIMIT = (await openAiCallsInLastDay()) + 2;
    openai = async () => {
      await new Promise((r) => setTimeout(r, 30)); // all requests overlap
      return aiSays('Answer.');
    };
    meta = metaAccepts;
    const received = [];
    for (let i = 0; i < 6; i++) received.push(...(await receive(text(`1555000208${i}`, 'hi'))));
    const outcomes = await replyToMessages(received); // six conversations, all at once
    assert.equal(outcomes.filter((o) => o === 'sent').length, 2, outcomes.join());
    assert.equal(outcomes.filter((o) => o === 'limit_reached').length, 4);
    assert.equal(openaiCalls.length, 2);
  });

  it('a failed OpenAI call does not use up the limit; a reservation for a completed call does', async () => {
    env.AI_CUSTOMER_DAILY_REPLY_LIMIT = 1;
    openai = () => json(500, {});
    assert.deepEqual(await replyToMessages(await receive(text('15550002090', 'hi'))), ['ai_failed']);
    await q(`UPDATE conversations SET status = 'open' WHERE customer_id = (SELECT id FROM customers WHERE phone_number = '+15550002090')`);
    openai = () => aiSays('Hello!');
    meta = metaAccepts;
    assert.deepEqual(await replyToMessages(await receive(text('15550002090', 'hi again'))), ['sent']);
    assert.deepEqual(await replyToMessages(await receive(text('15550002090', 'and again'))), ['limit_reached']);
  });
});

/** Waits for a condition, failing (not hanging) after `ms`. */
async function until(condition: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('send concurrency limit (H1)', () => {
  it('runs at most N tasks at once and hands slots on in order', async () => {
    const limit = concurrencyLimit(2);
    let active = 0;
    let max = 0;
    const order: number[] = [];
    const releases: (() => void)[] = [];
    const runs = [0, 1, 2, 3, 4].map((i) =>
      limit(async () => {
        max = Math.max(max, ++active);
        await new Promise<void>((r) => releases.push(r));
        order.push(i);
        active--;
        return i;
      }),
    );
    await until(() => releases.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(releases.length, 2, 'only two started');
    for (let i = 0; i < 5; i++) {
      await until(() => releases.length > i);
      releases[i]!();
    }
    assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3, 4]);
    assert.equal(max, 2);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it('a failing task frees its slot', async () => {
    const limit = concurrencyLimit(1);
    await assert.rejects(limit(async () => {
      throw new Error('x');
    }));
    assert.equal(await limit(async () => 'next'), 'next');
  });
});

describe('robustness (database)', { skip: !testDatabaseUrl }, () => {
  const q = async (sql: string, params: unknown[] = []) => (await pool!.query(sql, params)).rows;
  const conversation = async (phone: string) =>
    (await q(`SELECT cv.id, cv.status FROM conversations cv JOIN customers c ON c.id = cv.customer_id WHERE c.phone_number = $1 ORDER BY cv.created_at DESC LIMIT 1`, [phone]))[0];
  const reasons = async (cid: string) => (await q(`SELECT reason FROM handover_logs WHERE conversation_id = $1`, [cid])).map((r) => r.reason);
  const minutesAgo = (m: number) => Math.floor(Date.now() / 1000) - m * 60;

  beforeEach(async (ctx) => {
    await cleanup();
    (ctx as TestContext).mock.method(console, 'info', () => {});
  });

  it('H1: slow WhatsApp sends use at most 3 connections, and webhooks keep working meanwhile', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    openai = () => aiSays('Answer.');
    meta = async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await gate; // Meta is stuck
      inFlight--;
      return metaAccepts();
    };
    const received = [];
    for (let i = 0; i < 8; i++) received.push(...(await receive(text(`155500021${i}0`, 'hi'))));
    const replies = replyToMessages(received); // eight conversations at once
    try {
      await until(() => metaCalls.length === MAX_CONCURRENT_SENDS);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(metaCalls.length, MAX_CONCURRENT_SENDS, 'the other sends wait for a slot, holding no connection');
      // Connections in use (idle ones kept from earlier tests do not count): only the stuck sends.
      assert.equal(pool!.totalCount - pool!.idleCount, MAX_CONCURRENT_SENDS);
      // While Meta hangs, a new webhook is still saved promptly and no request waits for a connection.
      const started = Date.now();
      assert.equal((await receive(text('15550002190', 'still there?'))).length, 1);
      assert.ok(Date.now() - started < 1000);
      assert.equal(pool!.waitingCount, 0);
    } finally {
      release(); // even on failure: stuck sends would hold locks the next test's cleanup needs
    }
    assert.deepEqual(await replies, Array(8).fill('sent'));
    assert.equal(maxInFlight, MAX_CONCURRENT_SENDS);
  });

  it('H2: an unexpected error hands the conversation to staff and logs only a code', async (t) => {
    const lines: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const [m] = await receive(text('15550002200', 'my private question'));
    // The history query fails with a database error whose message quotes customer data.
    const original = pool!.query.bind(pool!) as (...args: unknown[]) => unknown;
    t.mock.method(pool!, 'query', (...args: unknown[]) =>
      String(args[0]).includes('h ORDER BY created_at')
        ? Promise.reject(Object.assign(new Error('terminating connection; detail +15550002200 my private question'), { code: '57P01' }))
        : original(...args),
    );
    assert.deepEqual(await replyToMessages([m!]), ['error']);
    t.mock.restoreAll();
    const cv = await conversation('+15550002200');
    assert.equal(cv.status, 'handover_requested');
    assert.deepEqual(await reasons(cv.id), ['AI reply failed: unexpected error (57P01)']);
    assert.equal(openaiCalls.length + metaCalls.length, 0);
    assert.deepEqual(lines, [`AI auto-reply: error 57P01 (conversation ${cv.id})`]);
    for (const l of lines) assert.ok(!l.includes('15550002200') && !l.includes('private'), l);
  });

  it('H2: after a restart, recovery hands over only unanswered, eligible conversations, once', async () => {
    // Saved by the webhook, but the in-memory reply queue was lost (no replyToMessages call): a restart.
    const lost = text('15550002210', 'are you open?', minutesAgo(10));
    await receive(lost);
    await receive(text('15550002211', 'too recent to judge', minutesAgo(1)));
    await receive(text('15550002212', 'answered', minutesAgo(10)));
    const answered = await conversation('+15550002212');
    await q(`INSERT INTO messages (conversation_id, direction, sender_type, content, status, created_at)
             VALUES ($1, 'outbound', 'ai', 'yes', 'sent', now() - interval '9 minutes')`, [answered.id]);
    await receive(text('15550002213', 'hello', minutesAgo(10)));
    await q(`UPDATE customers SET opted_out_at = now() WHERE phone_number = '+15550002213'`);
    await receive(text('15550002214', 'hello', minutesAgo(10)));
    await q(`UPDATE conversations SET status = 'human_active' WHERE id = $1`, [(await conversation('+15550002214')).id]);
    await receive(text('15550002215', 'hello', minutesAgo(10)));
    await q(`UPDATE conversations SET status = 'closed', closed_at = now() WHERE id = $1`, [(await conversation('+15550002215')).id]);
    await receive(text('15550002216', 'yesterday', minutesAgo(25 * 60)));
    await receive(text('15550002217', 'hello', minutesAgo(10)));
    await q(`DELETE FROM staff_users WHERE email = 'recovery-test@example.test'`);
    await q(`INSERT INTO staff_users (email, full_name) VALUES ('recovery-test@example.test', 'Recovery Test')`);
    await q(`UPDATE conversations SET assigned_staff_id = (SELECT id FROM staff_users WHERE email = 'recovery-test@example.test') WHERE id = $1`,
      [(await conversation('+15550002217')).id]);

    try {
      // With auto-reply off, the AI never took these on: nothing changes.
      env.AI_AUTO_REPLY_ENABLED = false;
      assert.equal(await recoverUnanswered(), 0);
      env.AI_AUTO_REPLY_ENABLED = true;

      assert.equal(await recoverUnanswered(), 1);
      const target = await conversation('+15550002210');
      assert.equal(target.status, 'handover_requested');
      assert.deepEqual(await reasons(target.id), [RECOVERY_REASON]);
      for (const [phone, status] of [['+15550002211', 'open'], ['+15550002212', 'open'], ['+15550002213', 'open'], ['+15550002214', 'human_active'], ['+15550002215', 'closed'], ['+15550002216', 'open'], ['+15550002217', 'open']]) {
        assert.equal((await conversation(phone!)).status, status, phone);
      }

      // Idempotent: a second run (another server, or the next interval) changes nothing and logs nothing new.
      assert.equal(await recoverUnanswered(), 0);
      assert.deepEqual(await reasons(target.id), [RECOVERY_REASON]);
      // Meta redelivers the lost message: a duplicate, so still no AI call; the handover stands.
      assert.deepEqual(await receive(lost), []);
      assert.equal(openaiCalls.length + metaCalls.length, 0);
    } finally {
      await q(`DELETE FROM staff_users WHERE email = 'recovery-test@example.test'`);
    }
  });

  it('M3: images, audio and video without a caption go to staff without calling OpenAI', async () => {
    const media: WaMessage[] = [
      { id: `wamid.AI${++seq}`, from: '15550002230', timestamp: String(minutesAgo(1)), type: 'image', image: {} },
      { id: `wamid.AI${++seq}`, from: '15550002231', timestamp: String(minutesAgo(1)), type: 'audio' },
      { id: `wamid.AI${++seq}`, from: '15550002232', timestamp: String(minutesAgo(1)), type: 'video', video: {} },
    ];
    for (const m of media) {
      assert.deepEqual(await replyToMessages(await receive(m)), ['media_handover'], m.type);
      const cv = await conversation(`+${m.from}`);
      assert.equal(cv.status, 'handover_requested', m.type);
      assert.deepEqual(await reasons(cv.id), [MEDIA_HANDOVER_REASON], m.type);
    }
    assert.equal(openaiCalls.length + metaCalls.length, 0);
  });

  it('M3: a captioned image is still answered by the AI; a reaction is ignored and supersedes nothing', async () => {
    openai = () => aiSays('Nice photo! How can I help?');
    meta = metaAccepts;
    const captioned = await receive({ id: `wamid.AI${++seq}`, from: '15550002233', timestamp: String(minutesAgo(1)), type: 'image', image: { caption: 'Is this the right product?' } });
    assert.deepEqual(await replyToMessages(captioned), ['sent']);

    // A question, then a 👍 reaction to an earlier message: the question is still answered, the reaction hands nothing over.
    const question = text('15550002234', 'What time do you close?', minutesAgo(2));
    const reaction: WaMessage = { id: `wamid.AI${++seq}`, from: '15550002234', timestamp: String(minutesAgo(1)), type: 'reaction' };
    assert.deepEqual(await replyToMessages(await receive(question, reaction)), ['sent', 'no_text']);
    const cv = await conversation('+15550002234');
    assert.equal(cv.status, 'open');
    assert.deepEqual(await reasons(cv.id), []);
    assert.equal(openaiCalls.length, 2);
  });

  it('M3: recovery picks up an unprocessed media-only message once, and still respects opt-out and closed', async () => {
    const photo = (from: string): WaMessage => ({ id: `wamid.AI${++seq}`, from, timestamp: String(minutesAgo(10)), type: 'image', image: {} });
    await receive(photo('15550002240')); // saved, but the in-memory reply was lost (restart)
    await receive(photo('15550002241'));
    await q(`UPDATE customers SET opted_out_at = now() WHERE phone_number = '+15550002241'`);
    await receive(photo('15550002242'));
    await q(`UPDATE conversations SET status = 'closed', closed_at = now() WHERE id = $1`, [(await conversation('+15550002242')).id]);
    // A reaction alone is not something to answer: never recovered.
    await receive({ id: `wamid.AI${++seq}`, from: '15550002243', timestamp: String(minutesAgo(10)), type: 'reaction' });

    assert.equal(await recoverUnanswered(), 1);
    const target = await conversation('+15550002240');
    assert.equal(target.status, 'handover_requested');
    assert.equal(await recoverUnanswered(), 0); // repeated runs: no duplicate handover
    assert.deepEqual(await reasons(target.id), [RECOVERY_REASON]);
    assert.equal((await conversation('+15550002241')).status, 'open');
    assert.equal((await conversation('+15550002242')).status, 'closed');
    assert.equal((await conversation('+15550002243')).status, 'open');
    assert.equal(openaiCalls.length + metaCalls.length, 0);
  });

  it('A: an AI reply that times out is "unknown": not retried, handed to staff, and kept in the AI context', async () => {
    openai = () => aiSays('We open at 9.');
    meta = () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const [m] = await receive(text('15550002250', 'When do you open?'));
    assert.deepEqual(await replyToMessages([m!]), ['send_unknown']);
    assert.equal(metaCalls.length, 1, 'never resent');
    const cv = await conversation('+15550002250');
    assert.equal(cv.status, 'handover_requested');
    assert.deepEqual(await reasons(cv.id), ['WhatsApp did not confirm the AI reply (delivery unknown)']);
    const [row] = await q(`SELECT status, error_message FROM messages WHERE conversation_id = $1 AND sender_type = 'ai'`, [cv.id]);
    assert.equal(row.status, 'unknown');
    assert.match(row.error_message, /may already have reached the customer/);
    const usage = await q(`SELECT provider FROM usage_logs WHERE conversation_id = $1 ORDER BY provider`, [cv.id]);
    assert.deepEqual(usage.map((u) => u.provider), ['openai']); // OpenAI billed; WhatsApp unconfirmed, not counted

    // Staff hand it back; the next customer message is answered with the possibly-delivered reply in context.
    await q(`UPDATE conversations SET status = 'open' WHERE id = $1`, [cv.id]);
    meta = metaAccepts;
    openaiCalls = [];
    // Stamped now (the helper's default is 2 minutes ago), so it sorts after the AI reply just saved.
    assert.deepEqual(await replyToMessages(await receive(text('15550002250', 'Hello?', Math.floor(Date.now() / 1000) + 1))), ['sent']);
    const history = openaiCalls[0]!.body.messages.slice(1).map((x: any) => [x.role, x.content]);
    assert.deepEqual(history, [['user', 'When do you open?'], ['assistant', 'We open at 9.'], ['user', 'Hello?']]);
  });

  // --- Step 10.5 M3: AI sends interrupted mid-way (left 'queued')

  /** An AI reply row left 'queued' by a crash during the WhatsApp call, `minutes` ago. */
  const interruptedAiReply = (cid: string, minutes: number, content = 'We open at 9.') =>
    q(`INSERT INTO messages (conversation_id, direction, sender_type, content, status, created_at)
       VALUES ($1, 'outbound', 'ai', $2, 'queued', now() - make_interval(mins => $3)) RETURNING id`, [cid, content, minutes]).then((rows) => rows[0].id as string);
  const messageRow = async (id: string) => (await q(`SELECT status, error_message FROM messages WHERE id = $1`, [id]))[0];

  it('M3: an interrupted AI send is marked unknown, handed to staff once, never resent, and stays in the AI context', async () => {
    const [m] = await receive(text('15550002260', 'When do you open?', minutesAgo(10)));
    const cid = m!.conversationId;
    const stuck = await interruptedAiReply(cid, 9);
    assert.equal(await recoverUnanswered(), 1);
    assert.equal((await messageRow(stuck)).status, 'unknown');
    assert.match((await messageRow(stuck)).error_message, /interrupted/);
    assert.equal((await conversation('+15550002260')).status, 'handover_requested');
    assert.deepEqual(await reasons(cid), [INTERRUPTED_REASON]);
    assert.equal(await recoverUnanswered(), 0); // idempotent
    assert.deepEqual(await reasons(cid), [INTERRUPTED_REASON]);
    assert.equal(openaiCalls.length + metaCalls.length, 0, 'not resent');
    // Handed back, the next customer message is answered with the possibly-delivered reply in context.
    await q(`UPDATE conversations SET status = 'open' WHERE id = $1`, [cid]);
    openai = () => aiSays('Anything else?');
    meta = metaAccepts;
    assert.deepEqual(await replyToMessages(await receive(text('15550002260', 'Thanks', Math.floor(Date.now() / 1000) + 1))), ['sent']);
    assert.deepEqual(openaiCalls[0]!.body.messages.slice(1).map((x: any) => x.content), ['When do you open?', 'We open at 9.', 'Thanks']);
  });

  it('M3: concurrent sweeps hand an interrupted send over exactly once', async () => {
    const [m] = await receive(text('15550002261', 'hello', minutesAgo(10)));
    await interruptedAiReply(m!.conversationId, 9);
    const results = await Promise.all([recoverUnanswered(), recoverUnanswered(), recoverUnanswered()]);
    assert.equal(results.reduce((a, b) => a + b, 0), 1);
    assert.equal((await reasons(m!.conversationId)).length, 1);
  });

  it('M3: an active send (recent, or still being answered here) is not treated as interrupted', async () => {
    const [recent] = await receive(text('15550002262', 'hello', minutesAgo(1)));
    const fresh = await interruptedAiReply(recent!.conversationId, 0); // just queued: a normal in-progress send
    // One this process is still answering, even with an old queued row.
    env.AI_MAX_MESSAGE_AGE_MINUTES = 60;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    openai = async () => {
      await gate;
      return aiSays('Answer.');
    };
    meta = metaAccepts;
    const busy = await receive(text('15550002263', 'slow', minutesAgo(10)));
    const oldRow = await interruptedAiReply(busy[0]!.conversationId, 9);
    const replying = replyToMessages(busy);
    try {
      await until(() => openaiCalls.length === 1);
      assert.equal(await recoverUnanswered(), 0);
      assert.equal((await messageRow(fresh)).status, 'queued');
      assert.equal((await messageRow(oldRow)).status, 'queued');
      assert.equal((await conversation('+15550002262')).status, 'open');
    } finally {
      release();
    }
    await replying;
  });

  it('M3: closed, opted-out and staff-handled conversations are not handed over (the stuck row still reads unknown)', async () => {
    const setups: [string, string][] = [
      ['15550002264', `UPDATE conversations SET status = 'closed', closed_at = now() WHERE id = $1`],
      ['15550002265', `UPDATE customers SET opted_out_at = now() WHERE id = (SELECT customer_id FROM conversations WHERE id = $1)`],
      ['15550002266', `UPDATE conversations SET status = 'human_active' WHERE id = $1`],
    ];
    const rows: [string, string, string][] = [];
    for (const [phone, setup] of setups) {
      const [m] = await receive(text(phone, 'hello', minutesAgo(10)));
      const id = await interruptedAiReply(m!.conversationId, 9);
      await q(setup, [m!.conversationId]);
      rows.push([phone, m!.conversationId, id]);
    }
    assert.equal(await recoverUnanswered(), 0);
    for (const [phone, cid, id] of rows) {
      assert.deepEqual(await reasons(cid), [], phone);
      assert.equal((await messageRow(id)).status, 'unknown', phone);
    }
    assert.equal((await conversation('+15550002264')).status, 'closed');
    assert.equal((await conversation('+15550002266')).status, 'human_active');
  });

  // --- Step 10.5 M5: a staff hand-back is not undone by recovery

  const withStaff = async (fn: (staffId: string) => Promise<void>) => {
    await q(`DELETE FROM staff_users WHERE email = 'reopen-test@example.test'`);
    const [{ id }] = await q(`INSERT INTO staff_users (email, full_name) VALUES ('reopen-test@example.test', 'Reopen Test') RETURNING id`);
    try {
      await fn(id);
    } finally {
      await cleanup(); // removes this test's events (maintenance procedure), so the staff row can go
      await q(`DELETE FROM staff_users WHERE email = 'reopen-test@example.test'`);
    }
  };
  const handBack = (cid: string, staffId: string, minutes = 0) =>
    q(`INSERT INTO conversation_events (conversation_id, staff_id, action, created_at) VALUES ($1, $2, 'reopen', now() - make_interval(mins => $3))`, [cid, staffId, minutes]);

  it('M5: a hand-back after the customer\'s last message stays effective, also under concurrent sweeps', async () => {
    await withStaff(async (staffId) => {
      const [m] = await receive(text('15550002270', 'I sent a photo', minutesAgo(10)));
      await handBack(m!.conversationId, staffId); // staff looked, and handed it back without replying
      const results = await Promise.all([recoverUnanswered(), recoverUnanswered(), recoverUnanswered()]);
      assert.deepEqual(results, [0, 0, 0]);
      assert.equal((await conversation('+15550002270')).status, 'open');
      assert.deepEqual(await reasons(m!.conversationId), []);
    });
  });

  it('M5: a customer message newer than the hand-back is still recovered; without a hand-back, recovery works as before', async () => {
    await withStaff(async (staffId) => {
      const [m] = await receive(text('15550002271', 'first', minutesAgo(30)));
      await handBack(m!.conversationId, staffId, 20);
      await receive(text('15550002271', 'anyone there?', minutesAgo(10))); // newer than the hand-back, unanswered
      await receive(text('15550002272', 'no hand-back here', minutesAgo(10)));
      assert.equal(await recoverUnanswered(), 2);
      assert.deepEqual(await reasons(m!.conversationId), [RECOVERY_REASON]);
      assert.equal((await conversation('+15550002272')).status, 'handover_requested');
    });
  });

  it('H2: recovery skips a conversation this process is still answering', async () => {
    env.AI_MAX_MESSAGE_AGE_MINUTES = 60; // old enough for recovery, young enough for the AI
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    openai = async () => {
      await gate;
      return aiSays('Answer.');
    };
    meta = metaAccepts;
    const received = await receive(text('15550002220', 'slow one', minutesAgo(10)));
    const reply = replyToMessages(received);
    try {
      await until(() => openaiCalls.length === 1);
      assert.equal(await recoverUnanswered(), 0);
    } finally {
      release();
    }
    assert.deepEqual(await reply, ['sent']);
    assert.equal(await recoverUnanswered(), 0); // answered now
    assert.equal((await conversation('+15550002220')).status, 'open');
  });
});

type ReplyOutcomeName = Awaited<ReturnType<typeof replyToMessages>>[number];
