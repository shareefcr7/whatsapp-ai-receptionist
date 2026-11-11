// Backend-only OpenAI diagnostic. Never prints the key.
//   npm run ai:check            free: config + key + model access (GET /v1/models)
//   npm run ai:check -- --paid  also sends ONE tiny chat request with no customer data
import { env } from '../../config/env.ts';
import { AppError } from '../../types/errors.ts';
import { aiService, openAiError } from './index.ts';

const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (!env.OPENAI_API_KEY) fail('OPENAI_API_KEY is not set in backend/.env.');
console.log(`Key: present (${env.OPENAI_API_KEY!.length} chars). Model: ${env.OPENAI_MODEL}`);

let res: Response;
try {
  res = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(env.OPENAI_MODEL)}`, {
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
} catch {
  fail('Could not reach api.openai.com (network error or timeout).');
}
if (!res!.ok) {
  const body = (await res!.json().catch(() => ({}))) as { error?: { code?: string; type?: string } };
  fail(openAiError(res!.status, body.error).message);
}
console.log('OK: key accepted and model is available (free check).');

if (process.argv.includes('--paid')) {
  try {
    const reply = await aiService.generateReply({
      conversationId: 'diagnostic',
      businessKnowledge: 'business_name: Diagnostic Test Clinic\nworking_hours: Mon-Fri 9:00-17:00',
      history: [{ role: 'customer', content: 'What are your opening hours?' }],
    });
    console.log(`OK: paid request succeeded. Model ${reply.model}, ${reply.inputTokens} in / ${reply.outputTokens} out tokens.`);
    console.log(`Reply: ${reply.text}`);
  } catch (err) {
    fail(err instanceof AppError ? `${err.code}: ${err.message}` : 'Unexpected error.');
  }
}
