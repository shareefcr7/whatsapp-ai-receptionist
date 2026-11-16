// Mocks fetch: these tests never contact OpenAI.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
process.env.OPENAI_MODEL = 'test-model';
const { aiService, systemPrompt } = await import('../src/services/ai/index.ts');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const respond = (status: number, body: unknown) => {
  let sent: any;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return () => sent;
};
const ask = () => aiService.generateReply({ conversationId: 'c', businessKnowledge: 'Hours: 9-5', history: [{ role: 'customer', content: 'hi' }] });

describe('AI replies', () => {
  it('sends knowledge as the system prompt and maps roles', async () => {
    const sent = respond(200, { model: 'test-model', choices: [{ message: { content: 'Hello!' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    assert.deepEqual(await ask(), { text: 'Hello!', model: 'test-model', inputTokens: 10, outputTokens: 2, requestsHandover: false });
    assert.equal(sent().model, 'test-model');
    assert.equal(sent().messages[0].role, 'system');
    assert.match(sent().messages[0].content, /Hours: 9-5/);
    assert.deepEqual(sent().messages[1], { role: 'user', content: 'hi' });
  });

  it('strips the handover marker and flags handover; empty replies hand over too', async () => {
    respond(200, { choices: [{ message: { content: 'A team member will help.\n[HANDOVER]' } }] });
    const reply = await ask();
    assert.equal(reply.text, 'A team member will help.');
    assert.equal(reply.requestsHandover, true);
    respond(200, { choices: [{ message: { content: '[HANDOVER] Someone will call you.\n[HANDOVER]' } }] });
    assert.equal((await ask()).text, 'Someone will call you.'); // every marker removed, not just the first
    respond(200, { choices: [{ message: { content: '' } }] });
    assert.equal((await ask()).requestsHandover, true);
  });

  it('forbids invented facts and booking confirmations', () => {
    const prompt = systemPrompt('');
    assert.match(prompt, /Never invent/);
    assert.match(prompt, /Never say a booking is confirmed/);
    assert.match(prompt, /\(none published yet\)/);
  });

  it('classifies OpenAI failures without echoing the response', async () => {
    const cases: [number, unknown, string][] = [
      [401, { error: { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-test...' } }, 'AI_AUTH_FAILED'],
      [429, { error: { code: 'credit_balance_exhausted', type: 'insufficient_quota' } }, 'AI_NO_CREDITS'],
      [429, { error: { code: 'insufficient_quota' } }, 'AI_NO_CREDITS'],
      [429, { error: { code: 'rate_limit_exceeded' } }, 'AI_RATE_LIMITED'],
      [500, {}, 'AI_ERROR'],
    ];
    for (const [status, body, code] of cases) {
      respond(status, body);
      await assert.rejects(ask(), (err: any) => err.code === code && !err.message.includes('sk-'));
    }
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await assert.rejects(ask(), { code: 'AI_UNREACHABLE' });
  });
});
