// Backend-only AI diagnostic for the provider AI_PROVIDER selects. Never prints the key.
//   npm run ai:check            free: config + key + model access (GET /v1/models/<model>)
//   npm run ai:check -- --paid  also sends ONE tiny request with no customer data
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.ts';
import { AppError } from '../../types/errors.ts';
import { anthropicError } from './anthropic.ts';
import { aiProvider, aiService, openAiError } from './index.ts';

const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const { provider, model } = aiProvider();
const key = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
if (!key) fail(`${keyName} is not set in backend/.env (AI_PROVIDER=${provider}).`);
console.log(`Provider: ${provider}. Key: present (${key!.length} chars). Model: ${model}`);

if (provider === 'anthropic') {
  try {
    await new Anthropic({ apiKey: key!, baseURL: 'https://api.anthropic.com', timeout: 15_000, maxRetries: 0, logLevel: 'off' }).models.retrieve(model);
  } catch (err) {
    fail(anthropicError(err).message);
  }
} else {
  let res: Response;
  try {
    res = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail('Could not reach api.openai.com (network error or timeout).');
  }
  if (!res!.ok) {
    const body = (await res!.json().catch(() => ({}))) as { error?: { code?: string; type?: string } };
    fail(openAiError(res!.status, body.error).message);
  }
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
