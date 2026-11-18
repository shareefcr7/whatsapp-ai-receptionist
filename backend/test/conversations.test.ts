// Staff handling of conversations and customer opt-out. OpenAI and Meta are mocked through fetch: nothing is billed.
// Persistence tests need TEST_DATABASE_URL (a DISPOSABLE database).
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { assertDisposableDatabaseUrl, isDatabaseVerified } from './helpers/db-hygiene.ts';
import type { WaMessage } from '../src/services/whatsapp/webhook.ts';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
assertDisposableDatabaseUrl(testDatabaseUrl); // before any hook: after() hooks still run if before() fails
Object.assign(process.env, {
  PGAPPNAME: 'receptionist-test', // tags this run's sessions; see test/helpers/db-hygiene.ts
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl ?? '',
  OPENAI_API_KEY: 'sk-test-not-a-real-key',
  OPENAI_MODEL: 'test-model',
  WHATSAPP_ACCESS_TOKEN: 'EAAtest-access-token',
  WHATSAPP_PHONE_NUMBER_ID: '111111111111111',
  WHATSAPP_APP_SECRET: 'test-app-secret-0123456789abcdef',
});

const { app } = await import('../src/app.ts');
const { env } = await import('../src/config/env.ts');
const { closePool, pool } = await import('../src/database/pool.ts');
const { migrate } = await import('../src/database/migrate.ts');
const { hashPassword } = await import('../src/services/auth/index.ts');
const { isOptOut, processWebhook } = await import('../src/services/whatsapp/webhook.ts');
const { replyToMessages } = await import('../src/services/ai/reply.ts');
const { busyOnLockTimeout, withConversationSend } = await import('../src/services/conversations/index.ts');
const { whatsAppService } = await import('../src/services/whatsapp/index.ts');
const { AppError } = await import('../src/types/errors.ts');
const { prepareTestDatabase, withTemporaryTrigger } = await import('./helpers/db-hygiene.ts');

// --- fetch mock
const realFetch = globalThis.fetch;
let openaiCalls = 0;
let metaCalls: any[] = [];
let openai: () => Response | Promise<Response>;
let meta: () => Response | Promise<Response>;
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname === 'api.openai.com') {
    openaiCalls++;
    return openai();
  }
  if (url.hostname === 'graph.facebook.com') {
    metaCalls.push(JSON.parse(String(init.body)));
    return meta();
  }
  throw new Error(`unexpected request to ${url.hostname}`);
}) as typeof fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const aiSays = (content: string) => json(200, { model: 'test-model', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const metaAccepts = () => json(200, { messages: [{ id: `wamid.OUT.CV.${metaCalls.length}.${Date.now()}` }] });
const nobody = () => {
  throw new Error('unexpected call');
};

let server: Server;
let base: string;
let adminCookie = '';
let agentCookie = '';
const ADMIN = { email: 'conv-admin@example.test', password: 'conversation admin test password' };
const AGENT = { email: 'conv-agent@example.test', password: 'conversation agent test password' };

const call = async (method: string, path: string, cookie = agentCookie, body?: unknown) => {
  const res = await realFetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const cleanup = async () => {
  await pool!.query(`DELETE FROM usage_logs WHERE conversation_id IN (
    SELECT cv.id FROM conversations cv JOIN customers c ON c.id = cv.customer_id WHERE c.phone_number LIKE '+15550003%')`);
  await pool!.query(`DELETE FROM webhook_events WHERE source = 'whatsapp' AND external_event_id LIKE 'message:wamid.CV%'`);
  // This file's own delivery-status events, so a second run on the same database is not treated as duplicates.
  await pool!.query(`DELETE FROM webhook_events WHERE source = 'whatsapp' AND external_event_id ~ '^status:wamid\.(LATE|EARLY|NOPE)'`);
  // Test customers have audit history, which ordinary deletes refuse (005): use the documented erasure procedure.
  const c = await pool!.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL receptionist.audit_maintenance = 'on'`);
    await c.query(`DELETE FROM conversation_events WHERE conversation_id IN (
      SELECT cv.id FROM conversations cv JOIN customers cu ON cu.id = cv.customer_id WHERE cu.phone_number LIKE '+15550003%')`);
    await c.query(`DELETE FROM customers WHERE phone_number LIKE '+15550003%'`); // cascades to conversations and messages
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
};

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}/api`;
  if (!testDatabaseUrl) return;
  await prepareTestDatabase(pool!); // refuses a non-_test database; recovers from an interrupted earlier run
  await migrate();
  await cleanup(); // rows referencing the staff accounts go first (their foreign keys refuse otherwise)
  await pool!.query(`DELETE FROM staff_users WHERE email IN ($1, $2)`, [ADMIN.email, AGENT.email]);
  await pool!.query(
    `INSERT INTO staff_users (email, full_name, role, password_hash) VALUES ($1, 'Conv Admin', 'admin', $2), ($3, 'Conv Agent', 'agent', $4)`,
    [ADMIN.email, await hashPassword(ADMIN.password), AGENT.email, await hashPassword(AGENT.password)],
  );
  for (const who of [ADMIN, AGENT]) {
    const res = await realFetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
    if (who === ADMIN) adminCookie = cookie;
    else agentCookie = cookie;
  }
});
after(async () => {
  server.close();
  // Only once the server confirmed a _test database: after() still runs when before() failed that check.
  try {
    if (testDatabaseUrl && isDatabaseVerified()) {
      await cleanup();
      await pool!.query(`DELETE FROM staff_users WHERE email IN ($1, $2)`, [ADMIN.email, AGENT.email]); // sessions cascade
    }
  } finally {
    globalThis.fetch = realFetch;
    await closePool(); // also when the clean-up fails, so the run cannot hang on open connections
  }
});
beforeEach(() => {
  openaiCalls = 0;
  metaCalls = [];
  openai = nobody;
  meta = nobody;
  env.AI_AUTO_REPLY_ENABLED = true;
});
afterEach(() => {
  env.AI_AUTO_REPLY_ENABLED = false;
});

/** Waits for a condition, failing (not hanging) after `ms`. */
async function until(condition: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let seq = 0;
const text = (from: string, body: string): WaMessage => ({
  id: `wamid.CV${++seq}`,
  from,
  timestamp: String(Math.floor(Date.now() / 1000) - 60),
  type: 'text',
  text: { body },
});
const receive = async (...messages: WaMessage[]) =>
  (
    await processWebhook({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111111111111111' }, messages } }] }],
    })
  ).received;

describe('lock timeout mapping', () => {
  it("turns only PostgreSQL's lock timeout (55P03) into a safe 409, and passes every other error through unchanged", () => {
    const busy = busyOnLockTimeout(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
    assert.ok(busy instanceof AppError);
    assert.equal((busy as InstanceType<typeof AppError>).status, 409);
    assert.equal((busy as InstanceType<typeof AppError>).code, 'CONVERSATION_BUSY');
    assert.equal((busy as Error).message, 'Conversation is busy. Please try again.');
    for (const other of [Object.assign(new Error('deadlock'), { code: '40P01' }), Object.assign(new Error('gone'), { code: '57P01' }), new Error('plain'), 'not an error']) {
      assert.equal(busyOnLockTimeout(other), other);
    }
  });
});

describe('opt-out keywords', () => {
  it('match the whole message only, ignoring case, spacing and trailing punctuation', () => {
    for (const t of ['STOP', 'stop', ' Stop! ', 'stop.', 'STOP ALL', 'stopall', 'Unsubscribe', 'opt out', 'Opt-Out', 'optout', 'END', 'quit']) {
      assert.equal(isOptOut(t), true, t);
    }
    for (const t of [null, '', 'stop by tomorrow?', 'can I stop my booking', 'cancel', 'START', 'unstop', 'hello', 'stopp']) {
      assert.equal(isOptOut(t), false, String(t));
    }
  });
});

describe('staff endpoints: authentication and validation', { skip: !testDatabaseUrl }, () => {
  const ID = '00000000-0000-4000-8000-000000000000';
  const ROUTES = ['takeover', 'reopen', 'close', 'messages', 'reactivate'];

  it('refuse a request with no session', async () => {
    for (const r of ROUTES) {
      const { status, body } = await call('POST', `/conversations/${ID}/${r}`, '', { text: 'x' });
      assert.equal(status, 401, r);
      assert.equal(body.error.code, 'UNAUTHENTICATED');
    }
  });

  it('only an admin can reactivate an opted-out customer', async () => {
    const { status, body } = await call('POST', `/conversations/${ID}/reactivate`, agentCookie);
    assert.equal(status, 403);
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  it('reject a malformed ID or message, and an unknown conversation, without calling Meta', async () => {
    assert.equal((await call('POST', '/conversations/not-a-uuid/takeover')).status, 400);
    assert.equal((await call('POST', `/conversations/${ID}/messages`, agentCookie, { text: '   ' })).status, 400);
    assert.equal((await call('POST', `/conversations/${ID}/messages`, agentCookie, { text: 'x'.repeat(4097) })).status, 400);
    assert.equal((await call('POST', `/conversations/${ID}/messages`, agentCookie, { text: 'hi', extra: 1 })).status, 400);
    for (const r of ROUTES) {
      const res = await call('POST', `/conversations/${ID}/${r}`, adminCookie, { text: 'hi' });
      assert.equal(res.status, 404, r);
    }
    assert.equal(metaCalls.length, 0);
  });
});

describe('staff handling (database)', { skip: !testDatabaseUrl }, () => {
  const q = async (sql: string, params: unknown[] = []) => (await pool!.query(sql, params)).rows;
  const conversation = async (id: string) =>
    (await q(`SELECT status, assigned_staff_id, closed_at FROM conversations WHERE id = $1`, [id]))[0];
  const staffIdOf = async (email: string) => (await q(`SELECT id FROM staff_users WHERE email = $1`, [email]))[0].id;
  const optedOut = async (phone: string) => (await q(`SELECT opted_out_at FROM customers WHERE phone_number = $1`, [phone]))[0].opted_out_at !== null;

  beforeEach(async (ctx) => {
    const t = ctx as TestContext;
    await cleanup();
    t.mock.method(console, 'info', () => {});
  });

  it('the detail and list endpoints show messages, opt-out, assignee and the handover reason', async () => {
    const [first] = await receive(text('15550003010', 'hello'));
    const cid = first!.conversationId;
    meta = () => json(400, { error: { code: 131047 } });
    await call('POST', `/conversations/${cid}/messages`, agentCookie, { text: 'late reply' }); // fails, still takes over
    await receive({ ...text('15550003010', 'STOP'), timestamp: String(Math.floor(Date.now() / 1000) + 1) }); // after the staff reply
    await q(`INSERT INTO handover_logs (conversation_id, reason, status) VALUES ($1, 'AI daily limit reached', 'accepted')`, [cid]);

    const { status, body } = await call('GET', `/conversations/${cid}`);
    assert.equal(status, 200);
    const d = body.data;
    assert.equal(d.status, 'human_active');
    assert.equal(d.optedOut, true);
    assert.ok(d.optedOutAt);
    assert.equal(d.assignedStaffName, 'Conv Agent');
    assert.equal(d.handoverReason, 'AI daily limit reached');
    assert.deepEqual(d.messages.map((m: any) => [m.senderType, m.content, m.status]), [
      ['customer', 'hello', 'received'],
      ['staff', 'late reply', 'failed'],
      ['customer', 'STOP', 'received'],
    ]);
    assert.match(d.messages[1].errorMessage, /24 hours/);

    const list = await call('GET', '/conversations?limit=100');
    const row = list.body.data.find((r: any) => r.id === cid);
    assert.equal(row.optedOut, true);
    assert.equal(row.assignedStaffName, 'Conv Agent');
    assert.equal((await call('GET', '/conversations/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await call('GET', '/conversations/nope')).status, 400);
  });

  it('takeover and close give up after the lock timeout with a safe 409 while the conversation is busy, then work', async () => {
    const [first] = await receive(text('15550003020', 'hello'));
    const cid = first!.conversationId;
    // Another request holds the conversation lock, like a slow WhatsApp send in progress.
    const holder = await pool!.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [cid]);
      for (const action of ['takeover', 'close']) {
        const started = Date.now();
        const { status, body } = await call('POST', `/conversations/${cid}/${action}`);
        const waited = Date.now() - started;
        assert.equal(status, 409, action);
        assert.deepEqual(body.error, { code: 'CONVERSATION_BUSY', message: 'Conversation is busy. Please try again.' }, action);
        assert.ok(waited >= 2500 && waited < 8000, `${action} waited ${waited}ms`);
        assert.ok(!JSON.stringify(body).includes('lock timeout'), 'no raw database message');
      }
      assert.equal((await conversation(cid)).status, 'open'); // nothing changed
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const done = await call('POST', `/conversations/${cid}/takeover`);
    assert.equal(done.status, 200);
    assert.equal(done.body.data.status, 'human_active');
  });

  it('takeover silences the AI and accepts the handover; reopen hands back to the AI', async () => {
    const [first] = await receive(text('15550003001', 'I need a person'));
    const cid = first!.conversationId;
    await q(`UPDATE conversations SET status = 'handover_requested' WHERE id = $1`, [cid]);
    await q(`INSERT INTO handover_logs (conversation_id, reason) VALUES ($1, 'test')`, [cid]);

    const taken = await call('POST', `/conversations/${cid}/takeover`);
    assert.equal(taken.status, 200);
    assert.deepEqual(taken.body.data, { id: cid, status: 'human_active', assignedStaffId: await staffIdOf(AGENT.email) });
    assert.deepEqual(await q(`SELECT status, staff_id FROM handover_logs WHERE conversation_id = $1`, [cid]), [
      { status: 'accepted', staff_id: await staffIdOf(AGENT.email) },
    ]);
    assert.deepEqual(await replyToMessages(await receive(text('15550003001', 'hello?'))), ['staff_managed']);
    assert.equal(openaiCalls, 0);

    const reopened = await call('POST', `/conversations/${cid}/reopen`);
    assert.deepEqual(reopened.body.data, { id: cid, status: 'open', assignedStaffId: null });
    assert.equal((await q(`SELECT status FROM handover_logs WHERE conversation_id = $1`, [cid]))[0].status, 'resolved');
    openai = () => aiSays('Hi, how can I help?');
    meta = metaAccepts;
    assert.deepEqual(await replyToMessages(await receive(text('15550003001', 'are you there?'))), ['sent']);
  });

  it('close ends the conversation: no replies or reopening, closing again is harmless, and the next message starts a new one', async () => {
    const [first] = await receive(text('15550003002', 'thanks, bye'));
    const cid = first!.conversationId;
    const closed = await call('POST', `/conversations/${cid}/close`);
    assert.equal(closed.body.data.status, 'closed');
    assert.ok((await conversation(cid)).closed_at);
    assert.equal((await call('POST', `/conversations/${cid}/close`)).status, 200);
    for (const r of ['reopen', 'takeover']) assert.equal((await call('POST', `/conversations/${cid}/${r}`)).body.error.code, 'CONVERSATION_CLOSED');
    const reply = await call('POST', `/conversations/${cid}/messages`, agentCookie, { text: 'hello' });
    assert.equal(reply.status, 409);
    assert.equal(metaCalls.length, 0);
    const [next] = await receive(text('15550003002', 'one more question'));
    assert.notEqual(next!.conversationId, cid);
  });

  it('a staff reply is sent, saved as staff, recorded, and takes the conversation over', async () => {
    const [first] = await receive(text('15550003003', 'Can I bring my dog?'));
    const cid = first!.conversationId;
    meta = () => json(200, { messages: [{ id: 'wamid.STAFF1' }] });
    const { status, body } = await call('POST', `/conversations/${cid}/messages`, agentCookie, { text: '  Yes, dogs are welcome.  ' });
    assert.equal(status, 201);
    assert.deepEqual({ ...body.data, id: undefined }, { id: undefined, status: 'sent', whatsappMessageId: 'wamid.STAFF1' });
    assert.equal(metaCalls[0].to, '15550003003');
    assert.equal(metaCalls[0].text.body, 'Yes, dogs are welcome.');
    const [saved] = await q(`SELECT direction, sender_type, content, status, whatsapp_message_id FROM messages WHERE id = $1`, [body.data.id]);
    assert.deepEqual(saved, { direction: 'outbound', sender_type: 'staff', content: 'Yes, dogs are welcome.', status: 'sent', whatsapp_message_id: 'wamid.STAFF1' });
    assert.deepEqual(await q(`SELECT provider, operation, message_id FROM usage_logs WHERE conversation_id = $1`, [cid]), [
      { provider: 'whatsapp', operation: 'send_text', message_id: body.data.id },
    ]);
    assert.deepEqual(await conversation(cid), { status: 'human_active', assigned_staff_id: await staffIdOf(AGENT.email), closed_at: null });
    assert.deepEqual(await replyToMessages(await receive(text('15550003003', 'great, thanks'))), ['staff_managed']);
    assert.equal(openaiCalls, 0);
  });

  it("a failed staff reply is saved as failed with Meta's reason, returned to the dashboard, and still takes over", async () => {
    const [first] = await receive(text('15550003004', 'hello'));
    const cid = first!.conversationId;
    meta = () => json(400, { error: { code: 131047, message: 'detail +15550003004' } });
    const { status, body } = await call('POST', `/conversations/${cid}/messages`, agentCookie, { text: 'Sorry for the delay' });
    assert.equal(status, 409);
    assert.equal(body.error.code, 'WHATSAPP_WINDOW_CLOSED');
    assert.ok(!JSON.stringify(body).includes('15550003004'));
    const [saved] = await q(`SELECT status, error_message FROM messages WHERE conversation_id = $1 AND sender_type = 'staff'`, [cid]);
    assert.equal(saved.status, 'failed');
    assert.match(saved.error_message, /24 hours/);
    assert.equal((await conversation(cid)).status, 'human_active');
  });

  it('STOP opts the customer out: no OpenAI call, no reply, no staff message, and no automatic reactivation', async () => {
    const received = await receive(text('15550003005', 'STOP'));
    assert.equal(await optedOut('+15550003005'), true);
    assert.deepEqual(await replyToMessages(received), ['opted_out']);
    // START or anything else does not undo it.
    assert.deepEqual(await replyToMessages(await receive(text('15550003005', 'START'))), ['opted_out']);
    assert.deepEqual(await replyToMessages(await receive(text('15550003005', 'what time do you open?'))), ['opted_out']);
    assert.equal(await optedOut('+15550003005'), true);
    assert.equal(openaiCalls + metaCalls.length, 0);

    const cid = received[0]!.conversationId;
    const blocked = await call('POST', `/conversations/${cid}/messages`, agentCookie, { text: 'hi' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'CUSTOMER_OPTED_OUT');
    assert.equal(metaCalls.length, 0);
  });

  it('only an admin reactivates; afterwards the AI answers again, and a redelivered STOP does not opt out again', async () => {
    const stop = text('15550003006', 'unsubscribe');
    const [first] = await receive(stop);
    const cid = first!.conversationId;
    assert.equal((await call('POST', `/conversations/${cid}/reactivate`, agentCookie)).status, 403);
    assert.equal(await optedOut('+15550003006'), true);

    const lines: string[] = [];
    console.info = (...args: unknown[]) => void lines.push(args.map(String).join(' ')); // restored by the mock in beforeEach
    const res = await call('POST', `/conversations/${cid}/reactivate`, adminCookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.optedOut, false);
    assert.equal(await optedOut('+15550003006'), false);
    assert.ok(lines.some((l) => l.includes('reactivated by staff')) && !lines.some((l) => l.includes('15550003006')));

    assert.deepEqual(await receive(stop), []); // Meta redelivers the old STOP: a duplicate, ignored
    assert.equal(await optedOut('+15550003006'), false);
    openai = () => aiSays('Welcome back!');
    meta = metaAccepts;
    assert.deepEqual(await replyToMessages(await receive(text('15550003006', 'hello again'))), ['sent']);
  });

  it('a takeover while OpenAI is answering stops the AI reply', async () => {
    const received = await receive(text('15550003007', 'question'));
    const cid = received[0]!.conversationId;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    openai = async () => {
      await gate;
      return aiSays('AI answer');
    };
    const ai = replyToMessages(received);
    await until(() => openaiCalls > 0);
    assert.equal((await call('POST', `/conversations/${cid}/takeover`)).status, 200);
    release();
    assert.deepEqual(await ai, ['staff_managed']);
    assert.equal(metaCalls.length, 0);
    assert.equal((await conversation(cid)).status, 'human_active');
  });

  it('a staff reply while OpenAI is answering wins: only the staff message is sent', async () => {
    const received = await receive(text('15550003008', 'question'));
    const cid = received[0]!.conversationId;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    openai = async () => {
      await gate;
      return aiSays('AI answer');
    };
    meta = metaAccepts;
    const ai = replyToMessages(received);
    await until(() => openaiCalls > 0);
    assert.equal((await call('POST', `/conversations/${cid}/messages`, agentCookie, { text: 'Staff answer' })).status, 201);
    release();
    assert.deepEqual(await ai, ['staff_managed']);
    assert.deepEqual(metaCalls.map((m) => m.text.body), ['Staff answer']);
  });

  it('a takeover requested while the AI message is being sent waits for it, then holds', async () => {
    const received = await receive(text('15550003009', 'question'));
    const cid = received[0]!.conversationId;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    openai = () => aiSays('AI answer');
    meta = async () => {
      await gate; // Meta is slow to accept the AI message
      return metaAccepts();
    };
    const ai = replyToMessages(received);
    await until(() => metaCalls.length > 0);
    let takeoverDone = false;
    const takeover = call('POST', `/conversations/${cid}/takeover`).then((r) => {
      takeoverDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(takeoverDone, false, 'takeover waits for the in-flight send');
    release();
    assert.deepEqual(await ai, ['sent']);
    assert.equal((await takeover).status, 200);
    assert.equal((await conversation(cid)).status, 'human_active');
    // From here the AI is silent.
    assert.deepEqual(await replyToMessages(await receive(text('15550003009', 'next'))), ['staff_managed']);
    assert.equal(metaCalls.length, 1);
  });
});

describe('delivery outcomes and audit trail (database)', { skip: !testDatabaseUrl }, () => {
  const q = async (sql: string, params: unknown[] = []) => (await pool!.query(sql, params)).rows;
  const staffIdOf = async (email: string) => (await q(`SELECT id FROM staff_users WHERE email = $1`, [email]))[0].id;
  const message = async (id: string) =>
    (await q(`SELECT status, whatsapp_message_id, error_message, staff_id, sender_type FROM messages WHERE id = $1`, [id]))[0];
  const eventsOf = async (cid: string) =>
    (await q(`SELECT e.action, s.email, e.message_id FROM conversation_events e JOIN staff_users s ON s.id = e.staff_id WHERE e.conversation_id = $1 ORDER BY e.id`, [cid])).map(
      (e) => [e.action, e.email, e.message_id],
    );
  const whatsappUsage = async (cid: string) =>
    (await q(`SELECT count(*)::int AS n FROM usage_logs WHERE conversation_id = $1 AND provider = 'whatsapp'`, [cid]))[0].n as number;
  /** A delivery-status webhook from Meta (signature already verified by the controller; called directly here). */
  const statusUpdate = (s: Record<string, unknown>) =>
    processWebhook({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111111111111111' }, statuses: [s as any] } }] }],
    });
  const newConversation = async (phone: string) => (await receive(text(phone, 'hello')))[0]!.conversationId;
  const reply = (cid: string, body: Record<string, unknown>, cookie = agentCookie) => call('POST', `/conversations/${cid}/messages`, cookie, body);
  const timeout = () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const netError = (code: string) => () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
  };

  beforeEach(async (ctx) => {
    await cleanup();
    (ctx as TestContext).mock.method(console, 'info', () => {});
  });

  // --- Part A: delivery state

  it('a confirmed send is "sent", attributed to the signed-in sender, tracked by our ID, and audited', async () => {
    const cid = await newConversation('15550003030');
    meta = () => json(200, { messages: [{ id: 'wamid.OK1' }] });
    const res = await reply(cid, { text: 'Hello from staff' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'sent');
    const row = await message(res.body.data.id);
    assert.deepEqual(row, { status: 'sent', whatsapp_message_id: 'wamid.OK1', error_message: null, staff_id: await staffIdOf(AGENT.email), sender_type: 'staff' });
    assert.equal(metaCalls[0].biz_opaque_callback_data, res.body.data.id);
    assert.equal(await whatsappUsage(cid), 1);
    assert.deepEqual(await eventsOf(cid), [['staff_reply', AGENT.email, res.body.data.id]]);
    const detail = (await call('GET', `/conversations/${cid}`)).body.data;
    assert.equal(detail.messages.at(-1).staffName, 'Conv Agent');
  });

  it('a timeout is "unknown": 202, saved with an explanation, not retried, not billed, and still a takeover', async () => {
    const cid = await newConversation('15550003031');
    meta = timeout;
    const res = await reply(cid, { text: 'Are you still there?' });
    assert.equal(res.status, 202);
    assert.equal(res.body.data.status, 'unknown');
    const row = await message(res.body.data.id);
    assert.equal(row.status, 'unknown');
    assert.match(row.error_message, /may already have reached the customer/);
    assert.equal(metaCalls.length, 1, 'never resent automatically');
    assert.equal(await whatsappUsage(cid), 0);
    assert.equal((await q(`SELECT status FROM conversations WHERE id = $1`, [cid]))[0].status, 'human_active');
    const detail = (await call('GET', `/conversations/${cid}`)).body.data;
    assert.equal(detail.messages.at(-1).status, 'unknown');
  });

  it('connection loss mid-request is "unknown"; a connection that never opened and a refusal are definite failures', async () => {
    const cid = await newConversation('15550003032');
    meta = netError('ECONNRESET');
    const lost = await reply(cid, { text: 'one' });
    assert.equal(lost.status, 202);
    assert.equal((await message(lost.body.data.id)).status, 'unknown');
    assert.equal(metaCalls.length, 1);

    metaCalls = [];
    meta = netError('ECONNREFUSED');
    const refused = await reply(cid, { text: 'two' });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, 'WHATSAPP_UNREACHABLE');
    assert.equal(metaCalls.length, 3); // safe to retry: it never left
    const failedRow = (await q(`SELECT status FROM messages WHERE conversation_id = $1 AND content = 'two'`, [cid]))[0];
    assert.equal(failedRow.status, 'failed');

    meta = () => json(400, { error: { code: 131047 } });
    const window = await reply(cid, { text: 'three' });
    assert.equal(window.status, 409);
    assert.equal(window.body.error.code, 'WHATSAPP_WINDOW_CLOSED');
    assert.equal((await q(`SELECT status FROM messages WHERE conversation_id = $1 AND content = 'three'`, [cid]))[0].status, 'failed');
  });

  it('a late status webhook resolves an unknown message, matched by our ID, and a "failed" one marks it failed', async () => {
    const cid = await newConversation('15550003033');
    meta = timeout;
    const a = (await reply(cid, { text: 'first' })).body.data.id;
    const b = (await reply(cid, { text: 'second' })).body.data.id;
    // Meta did send the first: its status arrives later, with the WhatsApp ID we never got and our ID echoed back.
    assert.equal((await statusUpdate({ id: 'wamid.LATE1', status: 'delivered', biz_opaque_callback_data: a })).processed, 1);
    assert.deepEqual(await message(a).then((m) => [m.status, m.whatsapp_message_id]), ['delivered', 'wamid.LATE1']);
    // A later "read" for the same WhatsApp ID now matches directly.
    await statusUpdate({ id: 'wamid.LATE1', status: 'read' });
    assert.equal((await message(a)).status, 'read');
    // The second never went out.
    await statusUpdate({ id: 'wamid.LATE2', status: 'failed', biz_opaque_callback_data: b, errors: [{ code: 131026, title: 'Message undeliverable' }] });
    assert.deepEqual(await message(b).then((m) => [m.status, m.error_message]), ['failed', '131026 Message undeliverable']);
    // A made-up callback ID matches nothing.
    assert.equal((await statusUpdate({ id: 'wamid.NOPE', status: 'delivered', biz_opaque_callback_data: '00000000-0000-4000-8000-000000000000' })).ignored, 1);
  });

  it('a status arriving during the send (before the result is saved) is kept, with or without our ID', async () => {
    const cid = await newConversation('15550003034');
    // With our ID: matched at once, because the queued row was committed before the send.
    meta = async () => {
      const ourId = metaCalls.at(-1).biz_opaque_callback_data;
      assert.equal((await statusUpdate({ id: 'wamid.EARLY1', status: 'delivered', biz_opaque_callback_data: ourId })).processed, 1);
      return json(200, { messages: [{ id: 'wamid.EARLY1' }] });
    };
    const one = await reply(cid, { text: 'one' });
    assert.equal(one.status, 201);
    assert.deepEqual(await message(one.body.data.id).then((m) => [m.status, m.whatsapp_message_id]), ['delivered', 'wamid.EARLY1']); // not downgraded to "sent"

    // Without our ID: unmatched at first (recorded as ignored), then replayed once the WhatsApp ID is saved.
    meta = async () => {
      assert.equal((await statusUpdate({ id: 'wamid.EARLY2', status: 'read' })).ignored, 1);
      return json(200, { messages: [{ id: 'wamid.EARLY2' }] });
    };
    const two = await reply(cid, { text: 'two' });
    assert.equal((await message(two.body.data.id)).status, 'read');
    assert.equal((await q(`SELECT status FROM webhook_events WHERE external_event_id = 'status:wamid.EARLY2:read'`))[0].status, 'processed');
  });

  it('a send interrupted mid-way (left "queued") is shown as delivery unknown, never as pending forever', async () => {
    const cid = await newConversation('15550003035');
    await q(`INSERT INTO messages (conversation_id, direction, sender_type, content, status, created_at)
             VALUES ($1, 'outbound', 'staff', 'interrupted', 'queued', now() - interval '5 minutes'),
                    ($1, 'outbound', 'staff', 'in progress', 'queued', now())`, [cid]);
    const detail = (await call('GET', `/conversations/${cid}`)).body.data;
    const status = (content: string) => detail.messages.find((m: any) => m.content === content).status;
    assert.equal(status('interrupted'), 'unknown');
    assert.equal(status('in progress'), 'queued');
  });

  it('a repeated or simultaneous submission of one draft is sent once', async () => {
    const cid = await newConversation('15550003036');
    meta = metaAccepts;
    const key = '7d1b8d2e-0f53-4c0e-9a51-3f8f4e2a9b10';
    const first = await reply(cid, { text: 'Only once please', clientMessageId: key });
    const again = await reply(cid, { text: 'Only once please', clientMessageId: key });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.id, first.body.data.id);

    const key2 = '2c5f3c1a-8b4e-4d6f-9e0a-1b2c3d4e5f60';
    const both = await Promise.all([reply(cid, { text: 'double click', clientMessageId: key2 }), reply(cid, { text: 'double click', clientMessageId: key2 })]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 201]);
    assert.equal(metaCalls.length, 2, 'two drafts, two sends');
    assert.equal((await q(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'staff'`, [cid]))[0].n, 2);

    // After "unknown", re-submitting the same draft does not send it again.
    metaCalls = [];
    meta = timeout;
    const key3 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    assert.equal((await reply(cid, { text: 'maybe sent', clientMessageId: key3 })).status, 202);
    const retry = await reply(cid, { text: 'maybe sent', clientMessageId: key3 });
    assert.equal(retry.status, 202); // still unconfirmed: never a success code (Step 10.5, M2)
    assert.equal(retry.body.data.status, 'unknown');
    assert.equal(metaCalls.length, 1);

    const other = await newConversation('15550003037');
    assert.equal((await reply(other, { text: 'x', clientMessageId: key })).body.error.code, 'DUPLICATE_SUBMISSION');
    assert.equal((await reply(cid, { text: 'x', clientMessageId: 'not-a-uuid' })).status, 400);
  });

  // --- Part B: audit trail

  it('records takeover, hand back, close and staff replies in order, by the signed-in agent or admin, and skips no-ops', async () => {
    const cid = await newConversation('15550003040');
    meta = metaAccepts;
    assert.equal((await call('POST', `/conversations/${cid}/takeover`, agentCookie)).status, 200);
    assert.equal((await call('POST', `/conversations/${cid}/takeover`, agentCookie)).status, 200); // already theirs: no event
    assert.equal((await call('POST', `/conversations/${cid}/reopen`, adminCookie)).status, 200);
    const sent = await reply(cid, { text: 'admin here' }, adminCookie);
    assert.equal((await call('POST', `/conversations/${cid}/close`, agentCookie)).status, 200);
    assert.equal((await call('POST', `/conversations/${cid}/close`, agentCookie)).status, 200); // already closed: no event
    assert.deepEqual(await eventsOf(cid), [
      ['takeover', AGENT.email, null],
      ['reopen', ADMIN.email, null],
      ['staff_reply', ADMIN.email, sent.body.data.id],
      ['close', AGENT.email, null],
    ]);
    const detail = (await call('GET', `/conversations/${cid}`, agentCookie)).body.data;
    assert.deepEqual(detail.events.map((e: any) => [e.action, e.staffName]), [
      ['takeover', 'Conv Agent'],
      ['reopen', 'Conv Admin'],
      ['staff_reply', 'Conv Admin'],
      ['close', 'Conv Agent'],
    ]);
    // Ordered by when they happened; IDs strictly increase.
    const ids = detail.events.map((e: any) => Number(e.id));
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
  });

  it('reactivation is audited for the admin; an agent attempt is refused and leaves no event', async () => {
    const [m] = await receive(text('15550003041', 'STOP'));
    const cid = m!.conversationId;
    assert.equal((await call('POST', `/conversations/${cid}/reactivate`, agentCookie)).status, 403);
    assert.deepEqual(await eventsOf(cid), []);
    assert.equal((await call('POST', `/conversations/${cid}/reactivate`, adminCookie)).status, 200);
    assert.equal((await call('POST', `/conversations/${cid}/reactivate`, adminCookie)).status, 200); // not opted out any more: no event
    assert.deepEqual(await eventsOf(cid), [['reactivate', ADMIN.email, null]]);
  });

  it('a forged sender is refused: the body cannot name a staff member', async () => {
    const cid = await newConversation('15550003042');
    const adminId = await staffIdOf(ADMIN.email);
    for (const body of [{ text: 'x', staffId: adminId }, { text: 'x', staff_id: adminId }, { text: 'x', senderType: 'ai' }]) {
      const res = await reply(cid, body, agentCookie);
      assert.equal(res.status, 400, JSON.stringify(Object.keys(body)));
    }
    assert.equal(metaCalls.length, 0);
    assert.deepEqual(await eventsOf(cid), []);
    assert.equal((await q(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'staff'`, [cid]))[0].n, 0);
  });

  it('the action and its audit event commit together: if the event cannot be written, nothing changes and nothing is sent', async (t) => {
    const cid = await newConversation('15550003043');
    t.mock.method(console, 'error', () => {}); // the expected 500 is logged by the error handler
    // Removed afterwards even if an assertion fails; a leftover from a killed run is removed by prepareTestDatabase.
    const blockEvents = { name: 'test_block_events', table: 'conversation_events', timing: 'BEFORE INSERT', body: `RAISE EXCEPTION 'audit unavailable';` };
    await withTemporaryTrigger(pool!, blockEvents, async () => {
      const takeover = await call('POST', `/conversations/${cid}/takeover`);
      assert.equal(takeover.status, 500);
      assert.equal(takeover.body.error.code, 'INTERNAL_ERROR');
      assert.ok(!JSON.stringify(takeover.body).includes('audit unavailable'), 'no raw database message');
      assert.equal((await q(`SELECT status FROM conversations WHERE id = $1`, [cid]))[0].status, 'open');

      const sent = await reply(cid, { text: 'should not go out' });
      assert.equal(sent.status, 500);
      assert.equal(metaCalls.length, 0);
      assert.equal((await q(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'staff'`, [cid]))[0].n, 0);
      assert.equal((await q(`SELECT status FROM conversations WHERE id = $1`, [cid]))[0].status, 'open');
    });
  });

  it('audit events are append-only, and no API edits or deletes them', async () => {
    const cid = await newConversation('15550003044');
    await call('POST', `/conversations/${cid}/takeover`);
    await assert.rejects(q(`UPDATE conversation_events SET action = 'close' WHERE conversation_id = $1`, [cid]), /append-only/);
    for (const [method, path] of [['PUT', `/conversations/${cid}/events`], ['DELETE', `/conversations/${cid}/events`], ['PATCH', `/conversations/${cid}`], ['DELETE', `/conversations/${cid}`]]) {
      assert.equal((await call(method!, path!, adminCookie)).status, 404, `${method} ${path}`);
    }
    assert.deepEqual(await eventsOf(cid), [['takeover', AGENT.email, null]]);
  });
});

describe('Step 10.5: send safety and lock contention (database)', { skip: !testDatabaseUrl }, () => {
  const q = async (sql: string, params: unknown[] = []) => (await pool!.query(sql, params)).rows;
  const staffRows = async (cid: string) =>
    q(`SELECT content, status, whatsapp_message_id FROM messages WHERE conversation_id = $1 AND sender_type = 'staff' ORDER BY created_at`, [cid]);
  const newConversation = async (phone: string) => (await receive(text(phone, 'hello')))[0]!.conversationId;
  const reply = (cid: string, body: Record<string, unknown>) => call('POST', `/conversations/${cid}/messages`, agentCookie, body);
  const key = () => crypto.randomUUID();
  /** A temporary trigger that makes one kind of write fail, like a database fault at exactly that point. */
  async function breakWrites(table: string, when: string, run: () => Promise<void>) {
    const fault = { name: 'test_fault', table, timing: 'BEFORE INSERT OR UPDATE', body: `IF ${when} THEN RAISE EXCEPTION 'simulated fault'; END IF; RETURN NEW;` };
    await withTemporaryTrigger(pool!, fault, run); // always dropped, even if run() fails
  }

  beforeEach(async (ctx) => {
    await cleanup();
    (ctx as TestContext).mock.method(console, 'info', () => {});
    (ctx as TestContext).mock.method(console, 'error', () => {}); // the simulated faults are logged by code
  });

  // --- M1: Meta accepted, then the database failed

  it('M1: Meta accepts, recording it fails: reported as sent, saved as sent, and a retry does not send again', async () => {
    const cid = await newConversation('15550003050');
    meta = () => json(200, { messages: [{ id: 'wamid.DBFAIL1' }] });
    const k = key();
    await breakWrites('usage_logs', `NEW.provider = 'whatsapp'`, async () => {
      const res = await reply(cid, { text: 'Accepted by Meta', clientMessageId: k });
      assert.equal(res.status, 201); // not a 500: that would invite a resend
      assert.equal(res.body.data.status, 'sent');
    });
    assert.deepEqual(await staffRows(cid), [{ content: 'Accepted by Meta', status: 'sent', whatsapp_message_id: 'wamid.DBFAIL1' }]);
    const retry = await reply(cid, { text: 'Accepted by Meta', clientMessageId: k });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.data.status, 'sent');
    assert.equal(metaCalls.length, 1, 'sent once');
  });

  it('M1: Meta accepts and even the fallback save fails: still "sent" to staff, the row reads unknown later, never resent', async () => {
    const cid = await newConversation('15550003051');
    meta = () => json(200, { messages: [{ id: 'wamid.DBFAIL2' }] });
    const k = key();
    await breakWrites('messages', `NEW.status = 'sent'`, async () => {
      const res = await reply(cid, { text: 'Accepted, not recorded', clientMessageId: k });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.status, 'sent');
      assert.equal((await staffRows(cid))[0].status, 'queued'); // the only trace: the row committed before the send
      // A retry straight away: still in progress, not confirmed, not sent again.
      const early = await reply(cid, { text: 'Accepted, not recorded', clientMessageId: k });
      assert.equal(early.status, 202);
      assert.equal(early.body.data.status, 'queued');
    });
    // Past the threshold it reads as unknown, both on retry and in the conversation.
    await q(`UPDATE messages SET created_at = now() - interval '3 minutes' WHERE conversation_id = $1 AND sender_type = 'staff'`, [cid]);
    const late = await reply(cid, { text: 'Accepted, not recorded', clientMessageId: k });
    assert.equal(late.status, 202);
    assert.equal(late.body.data.status, 'unknown');
    const shown = (await call('GET', `/conversations/${cid}`)).body.data.messages.find((x: any) => x.content === 'Accepted, not recorded');
    assert.equal(shown.status, 'unknown');
    assert.equal(metaCalls.length, 1, 'never resent');
  });

  // --- M2: repeated submissions

  it('M2: a retry after a definite failure reports the failure (not "sent") and does not resend; a new key is a new attempt', async () => {
    const cid = await newConversation('15550003052');
    meta = () => json(400, { error: { code: 131047 } });
    const k = key();
    const first = await reply(cid, { text: 'Too late?', clientMessageId: k });
    assert.equal(first.status, 409);
    assert.equal(first.body.error.code, 'WHATSAPP_WINDOW_CLOSED');
    const again = await reply(cid, { text: 'Too late?', clientMessageId: k });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'SEND_FAILED');
    assert.match(again.body.error.message, /^Not sent: .*24 hours/);
    assert.equal(metaCalls.length, 1);
    meta = metaAccepts;
    assert.equal((await reply(cid, { text: 'Too late?', clientMessageId: key() })).status, 201);
    assert.equal(metaCalls.length, 2);
  });

  it('M2: the same key with edited text is refused, not silently replaced by the original', async () => {
    const cid = await newConversation('15550003053');
    meta = metaAccepts;
    const k = key();
    assert.equal((await reply(cid, { text: 'Original text', clientMessageId: k })).status, 201);
    const edited = await reply(cid, { text: 'Edited text', clientMessageId: k });
    assert.equal(edited.status, 409);
    assert.equal(edited.body.error.code, 'DRAFT_CHANGED');
    // Same key, same text (whitespace trimmed as on the first send): the original, once.
    const same = await reply(cid, { text: '  Original text ', clientMessageId: k });
    assert.equal(same.status, 200);
    assert.equal(metaCalls.length, 1);
    assert.deepEqual((await staffRows(cid)).map((r) => r.content), ['Original text']);
  });

  // --- M4: bounded lock waits

  it('M4: a busy conversation answers "busy" within the lock timeout, frees its slots and connections, and others keep sending', async () => {
    const busy = await newConversation('15550003054');
    const other = await newConversation('15550003055');
    meta = metaAccepts;
    const holder = await pool!.connect(); // another request holding this conversation (e.g. a slow send)
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [busy]);
      const started = Date.now();
      // Enough waiters on the busy conversation to take every send slot, then one for another conversation.
      const waiters = [1, 2, 3].map((i) => reply(busy, { text: `waiting ${i}`, clientMessageId: key() }));
      await new Promise((r) => setTimeout(r, 200));
      const otherReply = reply(other, { text: 'unaffected', clientMessageId: key() });
      const results = await Promise.all(waiters);
      for (const r of results) {
        assert.equal(r.status, 409);
        assert.deepEqual(r.body.error, { code: 'CONVERSATION_BUSY', message: 'Conversation is busy. Please try again.' });
      }
      const ok = await otherReply;
      const elapsed = Date.now() - started;
      assert.equal(ok.status, 201, 'the other conversation still sends');
      assert.ok(elapsed < 8000, `waiters gave up in time (${elapsed}ms)`);
      assert.deepEqual(await staffRows(busy), [], 'nothing saved for the busy conversation');
      assert.deepEqual(metaCalls.map((m) => m.text.body), ['unaffected'], 'not a delivery attempt or failure');
      assert.equal((await q(`SELECT status FROM conversations WHERE id = $1`, [busy]))[0].status, 'open');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // The session lock_timeout never leaks into the pool.
    const clients = await Promise.all(Array.from({ length: 8 }, () => pool!.connect()));
    try {
      for (const c of clients) assert.equal((await c.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
    } finally {
      for (const c of clients) c.release();
    }
    assert.equal(pool!.waitingCount, 0);
    // And once free, the busy conversation works.
    assert.equal((await reply(busy, { text: 'now free', clientMessageId: key() })).status, 201);
  });

  it('M4: an AI reply to a busy conversation is skipped as "busy": nothing saved, nothing sent, no delivery state', async () => {
    const [m] = await receive(text('15550003056', 'question'));
    openai = () => aiSays('AI answer');
    const holder = await pool!.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [m!.conversationId]);
      assert.deepEqual(await replyToMessages([m!]), ['busy']);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    assert.equal(metaCalls.length, 0);
    assert.equal((await q(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`, [m!.conversationId]))[0].n, 0);
    assert.equal((await q(`SELECT status FROM conversations WHERE id = $1`, [m!.conversationId]))[0].status, 'open');
  });
});

describe('Step 10.7: connection errors, unexpected send errors, audit integrity (database)', { skip: !testDatabaseUrl }, () => {
  const q = async (sql: string, params: unknown[] = []) => (await pool!.query(sql, params)).rows;
  const newConversation = async (phone: string) => (await receive(text(phone, 'hello')))[0]!.conversationId;
  const reply = (cid: string, body: Record<string, unknown>) => call('POST', `/conversations/${cid}/messages`, agentCookie, body);
  /** Runs one statement in its own transaction and always rolls back, so even a regression cannot destroy data. */
  async function attempt(sql: string, params: unknown[] = [], setup: string[] = []): Promise<Error | null> {
    const c = await pool!.connect();
    try {
      await c.query('BEGIN');
      for (const stmt of setup) await c.query(stmt);
      await c.query(sql, params);
      return null;
    } catch (err) {
      return err as Error;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  const eventCount = async (cid: string) => (await q(`SELECT count(*)::int AS n FROM conversation_events WHERE conversation_id = $1`, [cid]))[0].n as number;

  beforeEach(async (ctx) => {
    await cleanup();
    (ctx as TestContext).mock.method(console, 'info', () => {});
  });

  // --- M-A: a connection dropped by the database must not crash the process

  it('M-A: a checked-out connection dropped by the database is logged by code, does not crash, and is discarded', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const held = await pool!.connect();
    const { rows: [{ pid }] } = await held.query('SELECT pg_backend_pid() AS pid');
    await pool!.query('SELECT pg_terminate_backend($1)', [pid]); // a database restart or failover
    await new Promise((r) => setTimeout(r, 300));
    // Still running (an unhandled 'error' event would have ended this test process).
    assert.ok(errors.mock.calls.some((c) => c.arguments[0] === 'Database connection error: 57P01'), JSON.stringify(errors.mock.calls.map((c) => c.arguments[0])));
    await assert.rejects(held.query('SELECT 1'));
    held.release(); // a plain release: pg-pool sees it is no longer queryable and drops it
    for (let i = 0; i < 5; i++) assert.equal((await q('SELECT 1 AS one'))[0].one, 1);
  });

  it('M-A: a connection dropped during a send fails that send cleanly and releases the conversation lock', async (t) => {
    t.mock.method(console, 'error', () => {});
    const id = crypto.randomUUID();
    await assert.rejects(
      withConversationSend(id, async (c) => {
        const { rows: [{ pid }] } = await c.query('SELECT pg_backend_pid() AS pid');
        await pool!.query('SELECT pg_terminate_backend($1)', [pid]);
        await new Promise((r) => setTimeout(r, 200));
        await c.query('SELECT 1'); // the connection is gone
      }),
    );
    // The session lock died with the connection: the next send on this conversation gets it at once.
    const started = Date.now();
    assert.equal(await withConversationSend(id, async () => 'got the lock'), 'got the lock');
    assert.ok(Date.now() - started < 1000);
  });

  // --- Low 1: an unexpected error from the sender is 'unknown', never a definite failure

  it('Low 1: a non-AppError from the WhatsApp sender is "unknown": 202, saved as unknown, and a retry does not resend', async (t) => {
    let sends = 0;
    t.mock.method(whatsAppService, 'sendText', async () => {
      sends++;
      throw new TypeError("Cannot read properties of null (reading 'messages')");
    });
    const cid = await newConversation('15550003060');
    const k = crypto.randomUUID();
    const first = await reply(cid, { text: 'Maybe sent', clientMessageId: k });
    assert.equal(first.status, 202);
    assert.equal(first.body.data.status, 'unknown');
    const [row] = await q(`SELECT status, error_message FROM messages WHERE id = $1`, [first.body.data.id]);
    assert.equal(row.status, 'unknown');
    assert.match(row.error_message, /may already have reached the customer/);
    const again = await reply(cid, { text: 'Maybe sent', clientMessageId: k });
    assert.equal(again.status, 202);
    assert.equal(sends, 1, 'never resent');
  });

  it('Low 1: the same for an AI reply: send_unknown and handed to staff', async (t) => {
    t.mock.method(whatsAppService, 'sendText', async () => {
      throw new TypeError('unexpected');
    });
    openai = () => aiSays('An answer.');
    const [m] = await receive(text('15550003061', 'question'));
    assert.deepEqual(await replyToMessages([m!]), ['send_unknown']);
    assert.equal((await q(`SELECT status FROM conversations WHERE id = $1`, [m!.conversationId]))[0].status, 'handover_requested');
  });

  // --- M-B: audit integrity, against real PostgreSQL

  it('M-B: the foreign keys and triggers on conversation_events are exactly the intended ones', async () => {
    const fks = await q(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE contype = 'f' AND conname IN ('conversation_events_conversation_id_fkey', 'conversation_events_message_id_fkey',
                                           'conversation_events_staff_id_fkey', 'messages_staff_id_fkey') ORDER BY conname`,
    );
    // r = RESTRICT, a = NO ACTION: both refuse the delete; neither cascades (c) or nulls (n) the audit row.
    assert.deepEqual(fks.map((f) => [f.conname, f.confdeltype]), [
      ['conversation_events_conversation_id_fkey', 'r'],
      ['conversation_events_message_id_fkey', 'r'],
      ['conversation_events_staff_id_fkey', 'a'],
      ['messages_staff_id_fkey', 'a'],
    ]);
    const triggers = await q(
      `SELECT tgname, tgtype & 2 = 2 AS before, tgtype & 1 = 1 AS per_row, tgenabled = 'O' AS enabled FROM pg_trigger
       WHERE tgrelid = 'conversation_events'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    assert.deepEqual(triggers.map((g) => [g.tgname, g.before, g.per_row, g.enabled]), [
      ['conversation_events_no_delete', true, true, true],
      ['conversation_events_no_truncate', true, false, true],
      ['conversation_events_no_update', true, true, true],
    ]);
  });

  it('M-B: audit events cannot be updated, deleted or truncated', async () => {
    const cid = await newConversation('15550003062');
    await call('POST', `/conversations/${cid}/takeover`);
    assert.equal(await eventCount(cid), 1);
    assert.match(String(await attempt(`UPDATE conversation_events SET action = 'close' WHERE conversation_id = $1`, [cid])), /append-only \(UPDATE refused\)/);
    assert.match(String(await attempt(`DELETE FROM conversation_events WHERE conversation_id = $1`, [cid])), /append-only \(DELETE refused\)/);
    assert.match(String(await attempt(`TRUNCATE conversation_events`)), /append-only \(TRUNCATE refused\)/);
    assert.match(String(await attempt(`TRUNCATE conversation_events CASCADE`)), /append-only \(TRUNCATE refused\)/);
    assert.equal(await eventCount(cid), 1);
  });

  it('M-B: a customer, conversation, staff message or staff member with audit history cannot be deleted; others can', async () => {
    meta = metaAccepts;
    const cid = await newConversation('15550003063');
    const sent = await reply(cid, { text: 'Staff reply', clientMessageId: crypto.randomUUID() });
    assert.equal(sent.status, 201);
    const [{ customer_id: customerId }] = await q(`SELECT customer_id FROM conversations WHERE id = $1`, [cid]);
    const restricted = (constraint: string) => new RegExp(`violates RESTRICT setting of foreign key constraint "${constraint}"`);
    assert.match(String(await attempt(`DELETE FROM customers WHERE id = $1`, [customerId])), restricted('conversation_events_conversation_id_fkey'));
    assert.match(String(await attempt(`DELETE FROM conversations WHERE id = $1`, [cid])), restricted('conversation_events_conversation_id_fkey'));
    assert.match(String(await attempt(`DELETE FROM messages WHERE id = $1`, [sent.body.data.id])), restricted('conversation_events_message_id_fkey'));
    const agentId = (await q(`SELECT id FROM staff_users WHERE email = $1`, [AGENT.email]))[0].id;
    assert.match(String(await attempt(`DELETE FROM staff_users WHERE id = $1`, [agentId])), /violates foreign key constraint "(messages_staff_id_fkey|conversation_events_staff_id_fkey)"/);
    assert.equal(await eventCount(cid), 1);
    // No audit history: deletable as before (cascading to its conversation and messages).
    const plain = await newConversation('15550003064');
    const [{ customer_id: plainCustomer }] = await q(`SELECT customer_id FROM conversations WHERE id = $1`, [plain]);
    await q(`DELETE FROM customers WHERE id = $1`, [plainCustomer]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM conversations WHERE id = $1`, [plain]))[0].n, 0);
  });

  it('M-B: the maintenance flag works only inside its own transaction, and still cannot cascade over audit rows', async () => {
    const cid = await newConversation('15550003065');
    await call('POST', `/conversations/${cid}/takeover`);
    const maintenance = [`SET LOCAL receptionist.audit_maintenance = 'on'`];
    // Inside a transaction with SET LOCAL: the documented procedure works (rolled back here).
    assert.equal(await attempt(`DELETE FROM conversation_events WHERE conversation_id = $1`, [cid], maintenance), null);
    // Even then, a customer with audit rows is refused until the events are deleted explicitly.
    const [{ customer_id: customerId }] = await q(`SELECT customer_id FROM conversations WHERE id = $1`, [cid]);
    assert.match(String(await attempt(`DELETE FROM customers WHERE id = $1`, [customerId], maintenance)), /violates RESTRICT/);
    // After COMMIT the flag is gone on that same connection.
    const c = await pool!.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL receptionist.audit_maintenance = 'on'`);
      await c.query('COMMIT');
      const { rows: [{ flag }] } = await c.query(`SELECT current_setting('receptionist.audit_maintenance', true) AS flag`);
      assert.notEqual(flag, 'on');
      await assert.rejects(c.query(`DELETE FROM conversation_events WHERE conversation_id = $1`, [cid]), /append-only \(DELETE refused\)/);
      // SET LOCAL outside a transaction has no effect (PostgreSQL only warns).
      await c.query(`SET LOCAL receptionist.audit_maintenance = 'on'`);
      await assert.rejects(c.query(`DELETE FROM conversation_events WHERE conversation_id = $1`, [cid]), /append-only \(DELETE refused\)/);
    } finally {
      c.release();
    }
    assert.equal(await eventCount(cid), 1);
  });

  // --- Low 3 / pool hygiene

  it('pooled connections carry no leftover session settings: lock_timeout 0, the configured statement timeout, no maintenance flag', async () => {
    const clients = await Promise.all(Array.from({ length: 8 }, () => pool!.connect()));
    try {
      for (const c of clients) {
        const { rows: [s] } = await c.query(
          `SELECT current_setting('lock_timeout') AS lock, (SELECT setting FROM pg_settings WHERE name = 'statement_timeout') AS statement,
                  coalesce(current_setting('receptionist.audit_maintenance', true), '') AS flag`,
        );
        assert.deepEqual(s, { lock: '0', statement: String(env.DB_STATEMENT_TIMEOUT_MS), flag: s.flag === 'on' ? 'LEAKED' : s.flag });
      }
    } finally {
      for (const c of clients) c.release();
    }
  });
});
