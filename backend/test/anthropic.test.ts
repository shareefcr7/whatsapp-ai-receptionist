// Anthropic Claude as the AI provider. Mocks fetch: nothing contacts Anthropic or OpenAI, and nothing is billed.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const KEY = 'sk-ant-test-not-a-real-key';
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: '', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: '' });
for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[name];
const { env, parseEnv } = await import('../src/config/env.ts');
const { aiProvider, aiService } = await import('../src/services/ai/index.ts');
const { integrationStatus } = await import('../src/services/integrations.ts');

interface Call {
  url: URL;
  headers: Headers;
  body: any;
}
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let answer: () => Response;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'api.anthropic.com') throw new Error(`unexpected request to ${url.hostname}`);
    calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return answer();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(env, { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'claude-sonnet-5-5', OPENAI_API_KEY: undefined });
});

// retry-after-ms: 0 keeps the SDK's automatic retries instant.
const reply = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after-ms': '0' } });
const message = (content: unknown[], extra: object = {}) =>
  reply(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 7 }, ...extra });
const text = (t: string) => ({ type: 'text', text: t });
const failure = (status: number, type: string) => reply(status, { type: 'error', error: { type, message: `details quoting ${KEY}` } });
type History = Parameters<typeof aiService.generateReply>[0]['history'];
const ask = (history: History = [{ role: 'customer', content: 'hi' }]) => aiService.generateReply({ conversationId: 'c', businessKnowledge: 'Hours: 9-5', history });

describe('Anthropic provider selection and configuration', () => {
  it('AI_PROVIDER picks the provider; blank stays openai so existing deployments keep their behaviour', () => {
    assert.equal(parseEnv({}).AI_PROVIDER, 'openai');
    assert.equal(parseEnv({ AI_PROVIDER: '' }).AI_PROVIDER, 'openai');
    assert.equal(parseEnv({ AI_PROVIDER: '  ' }).AI_PROVIDER, 'openai');
    assert.equal(parseEnv({ AI_AUTO_REPLY_ENABLED: '  ' }).AI_AUTO_REPLY_ENABLED, false);
    assert.equal(parseEnv({ AI_PROVIDER: ' Anthropic ' }).AI_PROVIDER, 'anthropic');
    assert.throws(() => parseEnv({ AI_PROVIDER: 'claude' }), /AI_PROVIDER: must be "openai" or "anthropic"/);
    assert.equal(parseEnv({}).ANTHROPIC_MODEL, 'claude-sonnet-5-5');
    assert.equal(parseEnv({ ANTHROPIC_MODEL: '' }).ANTHROPIC_MODEL, 'claude-sonnet-5-5');
    assert.equal(parseEnv({ ANTHROPIC_MODEL: 'claude-haiku-5-5' }).ANTHROPIC_MODEL, 'claude-haiku-5-5');
    assert.equal(parseEnv({ ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(aiProvider(), { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('the dashboard status reports the selected provider, its model and its key only', () => {
    assert.deepEqual(integrationStatus().ai, {
      implementation: 'ready', credentials: 'present_untested', connected: false, provider: 'anthropic', model: 'claude-sonnet-5-5',
    });
    env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    assert.equal(integrationStatus().ai.model, 'claude-sonnet-4-6');
    env.ANTHROPIC_API_KEY = undefined;
    assert.equal(integrationStatus().ai.credentials, 'missing');
    assert.ok(!JSON.stringify(integrationStatus()).includes(KEY));
  });

  it('a key for the other provider never makes the selected one look configured', () => {
    const OPENAI_KEY = 'sk-openai-test-not-a-real-key';
    // Anthropic selected, only an OpenAI key: still Anthropic, still missing.
    Object.assign(env, { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: OPENAI_KEY });
    assert.deepEqual(
      (({ provider, credentials }) => ({ provider, credentials }))(integrationStatus().ai),
      { provider: 'anthropic', credentials: 'missing' },
    );
    // OpenAI selected: its own key decides, and the model is OpenAI's.
    Object.assign(env, { AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: KEY });
    assert.deepEqual(integrationStatus().ai, {
      implementation: 'ready', credentials: 'present_untested', connected: false, provider: 'openai', model: env.OPENAI_MODEL,
    });
    env.OPENAI_API_KEY = undefined;
    assert.equal(integrationStatus().ai.credentials, 'missing'); // the Anthropic key does not count
    assert.ok(!JSON.stringify(integrationStatus()).includes(KEY));
    assert.ok(!JSON.stringify(integrationStatus()).includes(OPENAI_KEY));
  });
});

describe('Anthropic replies (fetch mocked)', () => {
  it('calls the Messages API with claude-sonnet-5-5, the knowledge as system prompt, mapped roles, low effort and server-side fallbacks', async () => {
    answer = message([text('Hello!')]);
    assert.deepEqual(await ask(), { text: 'Hello!', model: 'claude-sonnet-5-5', inputTokens: 50, outputTokens: 7, requestsHandover: false });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call!.url.href, 'https://api.anthropic.com/v1/messages');
    assert.equal(call!.body.model, 'claude-sonnet-5-5');
    assert.equal(call!.body.max_tokens, 4096);
    assert.deepEqual(call!.body.output_config, { effort: 'low' });
    assert.match(call!.body.system, /APPROVED KNOWLEDGE:\nHours: 9-5/);
    assert.match(call!.body.system, /Never say a booking is confirmed/);
    assert.deepEqual(call!.body.messages, [{ role: 'user', content: 'hi' }]);
    // Sonnet 5.5 rejects thinking: {type: "disabled"}, so thinking is left out (adaptive, steered by effort).
    assert.equal(call!.body.thinking, undefined);
    // On a refusal the API retries on a fallback model it picks; if that also refuses, the reply goes to staff.
    assert.equal(call!.body.fallbacks, 'default');
    assert.match(call!.headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
    // The key travels in a header only, never in the body.
    assert.ok([...call!.headers.values()].some((v) => v.includes(KEY)));
    assert.ok(!JSON.stringify(call!.body).includes(KEY));
  });

  it('sends no fallbacks with a model that does not support them (claude-sonnet-4-6)', async () => {
    env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    answer = message([text('Hi')], { model: 'claude-sonnet-4-6' });
    assert.equal((await ask()).model, 'claude-sonnet-4-6');
    assert.equal(calls[0]!.body.model, 'claude-sonnet-4-6');
    assert.equal(calls[0]!.body.fallbacks, undefined);
    assert.equal(calls[0]!.headers.get('anthropic-beta'), null);
  });

  it('keeps the conversation starting and ending with the customer; with no customer text it hands over without a call', async () => {
    answer = message([text('Sure.')]);
    await ask([
      { role: 'assistant', content: 'Welcome!' },
      { role: 'customer', content: 'Open today?' },
      { role: 'assistant', content: 'Yes.' },
      { role: 'customer', content: 'Until when?' },
      { role: 'assistant', content: 'A late reply' },
    ]);
    assert.deepEqual(calls[0]!.body.messages, [
      { role: 'user', content: 'Open today?' },
      { role: 'assistant', content: 'Yes.' },
      { role: 'user', content: 'Until when?' },
    ]);
    const none = await ask([{ role: 'assistant', content: 'Welcome!' }]);
    assert.deepEqual([none.text, none.requestsHandover, calls.length], ['', true, 1]);
  });

  it('strips the handover marker, and hands over on an empty reply, a refusal or a reply cut off at max_tokens', async () => {
    answer = message([text('A team member will help.\n[HANDOVER]')]);
    assert.deepEqual([(await ask()).text, (await ask()).requestsHandover], ['A team member will help.', true]);
    answer = message([]);
    assert.equal((await ask()).requestsHandover, true);
    answer = message([text('partial')], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } });
    assert.deepEqual([(await ask()).text, (await ask()).requestsHandover], ['', true]);
    answer = message([text('We open at 9 and close')], { stop_reason: 'max_tokens' });
    assert.deepEqual([(await ask()).text, (await ask()).requestsHandover], ['', true]);
  });

  it('after a server-side fallback, sends only the text written after the switch, and records the serving model', async () => {
    answer = message(
      [text('Declined start'), { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } }, text('We open at 9.')],
      { model: 'claude-sonnet-5' },
    );
    const r = await ask();
    assert.deepEqual([r.text, r.model, r.requestsHandover], ['We open at 9.', 'claude-sonnet-5', false]);
  });

  it('maps errors to safe codes without echoing the response, and retries only what is retryable', async () => {
    const cases: [() => Response, string, number][] = [
      [failure(401, 'authentication_error'), 'AI_AUTH_FAILED', 1],
      [failure(403, 'permission_error'), 'AI_AUTH_FAILED', 1],
      [failure(400, 'billing_error'), 'AI_NO_CREDITS', 1],
      [failure(404, 'not_found_error'), 'AI_MODEL_UNAVAILABLE', 1],
      [failure(400, 'invalid_request_error'), 'AI_ERROR', 1],
      [failure(429, 'rate_limit_error'), 'AI_RATE_LIMITED', 3],
      [failure(529, 'overloaded_error'), 'AI_OVERLOADED', 3],
      [failure(500, 'api_error'), 'AI_ERROR', 3],
    ];
    for (const [response, code, attempts] of cases) {
      calls = [];
      answer = response;
      await assert.rejects(ask(), (err: any) => err.code === code && !err.message.includes(KEY) && !err.message.includes('details'));
      assert.equal(calls.length, attempts, code);
    }
  });

  it('a network failure is AI_UNREACHABLE', { timeout: 30_000 }, async () => {
    answer = () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(ask(), { code: 'AI_UNREACHABLE' });
  });

  it('without ANTHROPIC_API_KEY it refuses before any request', async () => {
    env.ANTHROPIC_API_KEY = undefined;
    await assert.rejects(ask(), { code: 'AI_NOT_CONFIGURED', message: 'ANTHROPIC_API_KEY is not set.' });
    assert.equal(calls.length, 0);
  });

  it('AI_PROVIDER=openai never reaches Anthropic', async () => {
    env.AI_PROVIDER = 'openai';
    await assert.rejects(ask(), { code: 'AI_NOT_CONFIGURED', message: 'OPENAI_API_KEY is not set.' });
    assert.equal(calls.length, 0);
  });
});
