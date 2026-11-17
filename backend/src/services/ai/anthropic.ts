import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.ts';
import { AppError } from '../../types/errors.ts';
import type { AiReplyRequest, RawReply } from './index.ts';

// Fixed, so an ANTHROPIC_BASE_URL in the environment can never redirect the key elsewhere.
const BASE_URL = 'https://api.anthropic.com';
// Models that accept server-side refusal fallbacks: on a policy decline the API re-runs the request on a fallback
// model inside the same call. Other models simply refuse, which hands the conversation to staff.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-sonnet-5-5']);

/** Maps SDK errors to safe messages. The SDK's message and the response body are never echoed: they can quote input. */
export function anthropicError(err: unknown): AppError {
  if (err instanceof Anthropic.APIConnectionError) return new AppError(503, 'AI_UNREACHABLE', 'Could not reach Anthropic (network error or timeout).');
  if (!(err instanceof Anthropic.APIError)) return new AppError(502, 'AI_ERROR', 'Anthropic request failed.');
  if (err.type === 'billing_error') return new AppError(503, 'AI_NO_CREDITS', 'Anthropic account has no credits left. Check billing.');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AppError(502, 'AI_AUTH_FAILED', 'Anthropic rejected the API key.');
  }
  if (err instanceof Anthropic.NotFoundError) return new AppError(502, 'AI_MODEL_UNAVAILABLE', `Anthropic model "${env.ANTHROPIC_MODEL}" is not available to this key.`);
  if (err instanceof Anthropic.RateLimitError) return new AppError(503, 'AI_RATE_LIMITED', 'Anthropic rate limit reached. Try again shortly.');
  if (err.status === 529 || err.type === 'overloaded_error') return new AppError(503, 'AI_OVERLOADED', 'Anthropic is overloaded. Try again shortly.');
  return new AppError(502, 'AI_ERROR', `Anthropic request failed (HTTP ${err.status ?? 'unknown'}).`);
}

/** Claude needs the conversation to start and end with the customer: a trailing assistant turn would be a prefill. */
function toMessages(history: AiReplyRequest['history']): Anthropic.Beta.BetaMessageParam[] {
  const messages = history.map((m) => ({ role: m.role === 'customer' ? ('user' as const) : ('assistant' as const), content: m.content }));
  while (messages[0]?.role === 'assistant') messages.shift();
  while (messages.at(-1)?.role === 'assistant') messages.pop();
  return messages;
}

export async function anthropicReply(system: string, { history }: AiReplyRequest): Promise<RawReply> {
  if (!env.ANTHROPIC_API_KEY) throw new AppError(503, 'AI_NOT_CONFIGURED', 'ANTHROPIC_API_KEY is not set.');
  const model = env.ANTHROPIC_MODEL;
  const messages = toMessages(history);
  // Nothing from the customer to answer: no call, and the empty reply hands over.
  if (!messages.length) return { raw: '', model, inputTokens: 0, outputTokens: 0 };

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: BASE_URL,
    timeout: 30_000,
    maxRetries: 2, // 408/409/429/5xx and connection errors; a reply is only sent once, whatever happens here
    logLevel: 'off', // the SDK must never log requests: they hold customer messages
    // Read at call time, so tests can replace globalThis.fetch.
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  let res: Anthropic.Beta.BetaMessage;
  try {
    res = await client.beta.messages.create({
      model,
      // Thinking counts towards this; replies are short by instruction, and a cut-off reply goes to staff.
      max_tokens: 4096,
      // Short receptionist answers from given facts: low effort keeps cost and latency down.
      output_config: { effort: 'low' },
      system,
      messages,
      ...(FALLBACK_MODELS.has(model) && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    });
  } catch (err) {
    throw anthropicError(err);
  }
  // Only a finished answer is sent. A refusal (after any fallback), or a reply cut off at max_tokens, hands over.
  // After a fallback, only the text written after the last switch point belongs to the final answer.
  const after = res.content.slice(res.content.findLastIndex((b) => b.type === 'fallback') + 1);
  const raw = res.stop_reason === 'end_turn' ? after.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') : '';
  return { raw, model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
}
