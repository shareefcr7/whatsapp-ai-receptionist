import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.ts';
import { AppError } from '../../types/errors.ts';

// Bump when Meta deprecates it; the App Dashboard shows the current version.
export const GRAPH_VERSION = 'v23.0';
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [300, 900];
// Retried only when Meta refused the request (429: slow down), so a retry cannot send the message twice.
const RETRYABLE_STATUS = new Set([429]);
// Connection errors where the request certainly never reached Meta, so a retry is safe. Not here, because the message
// may have been sent: a timeout, ECONNRESET (dropped mid-request) and any other socket error.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/** WhatsApp gave no clear answer: the message may or may not have reached the customer. Never retried automatically. */
const DELIVERY_UNKNOWN = 'WHATSAPP_DELIVERY_UNKNOWN';
export const deliveryUnknown = () =>
  new AppError(504, DELIVERY_UNKNOWN, 'WhatsApp did not confirm this message. It may already have reached the customer.');
export const isDeliveryUnknown = (err: unknown) => err instanceof AppError && err.code === DELIVERY_UNKNOWN;

export interface WhatsAppService {
  /** `trackingId` (our message ID) is echoed by Meta in delivery-status webhooks as biz_opaque_callback_data. */
  sendText(to: string, body: string, trackingId?: string): Promise<{ whatsappMessageId: string }>;
  sendTemplate(to: string, template: string, language: string, params: string[]): Promise<{ whatsappMessageId: string }>;
  /** Checks X-Hub-Signature-256 against the raw request body. False when WHATSAPP_APP_SECRET is not set. */
  verifySignature(rawBody: Buffer, signature: string): boolean;
  /** Checks hub.verify_token from Meta's subscription handshake. False when WHATSAPP_VERIFY_TOKEN is not set. */
  verifyToken(token: string): boolean;
}

const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Meta error bodies are read for their numeric code only and never echoed: they can quote the request. */
function metaError(status: number, code: number | undefined): AppError {
  if (status === 401 || code === 190) {
    return new AppError(502, 'WHATSAPP_AUTH_FAILED', 'WhatsApp rejected the access token (expired or invalid). Replace WHATSAPP_ACCESS_TOKEN.');
  }
  if (code === 131030) {
    return new AppError(400, 'WHATSAPP_RECIPIENT_NOT_ALLOWED', 'This number is not on the test recipient list. Add it in Meta API Setup.');
  }
  if (code === 131047) {
    return new AppError(409, 'WHATSAPP_WINDOW_CLOSED', 'The customer last wrote more than 24 hours ago. Send an approved template instead.');
  }
  if (code === 132000 || code === 132001 || code === 132012) {
    return new AppError(400, 'WHATSAPP_TEMPLATE_ERROR', 'The template does not exist, is not approved for this language, or its parameters do not match.');
  }
  if (status === 429 || code === 4 || code === 80007 || code === 130429 || code === 131056) {
    return new AppError(503, 'WHATSAPP_RATE_LIMITED', 'WhatsApp rate limit reached. Try again shortly.');
  }
  return new AppError(502, 'WHATSAPP_ERROR', `WhatsApp request failed (HTTP ${status}${code ? `, code ${code}` : ''}).`);
}

async function send(to: string, message: Record<string, unknown>): Promise<{ whatsappMessageId: string }> {
  const missing = (['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'] as const).filter((k) => !env[k]);
  if (missing.length) throw new AppError(503, 'WHATSAPP_NOT_CONFIGURED', `WhatsApp is not configured. Missing: ${missing.join(', ')}.`);
  const recipient = to.replace(/^\+/, '');
  if (!/^[1-9][0-9]{6,14}$/.test(recipient)) throw new AppError(400, 'WHATSAPP_INVALID_RECIPIENT', 'The recipient is not a valid international phone number.');

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const body = JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, ...message });
  for (let attempt = 1; ; attempt++) {
    const retry = () => new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code && NOT_SENT.has(code)) {
        if (attempt < MAX_ATTEMPTS) {
          await retry();
          continue;
        }
        throw new AppError(503, 'WHATSAPP_UNREACHABLE', 'Could not connect to WhatsApp, so the message was not sent. Try again shortly.');
      }
      throw deliveryUnknown(); // timeout or dropped connection: the request may have reached Meta
    }
    // Anything but a JSON object (a literal null, a number, HTML) carries no message ID: treated as an empty reply.
    const parsed: unknown = await res.json().catch(() => null);
    const reply = (parsed && typeof parsed === 'object' ? parsed : {}) as { messages?: { id?: string }[]; error?: { code?: number } };
    if (res.ok) {
      const id = reply.messages?.[0]?.id;
      if (!id) throw deliveryUnknown(); // accepted, but no ID to prove what happened
      return { whatsappMessageId: id };
    }
    if (attempt < MAX_ATTEMPTS && RETRYABLE_STATUS.has(res.status)) {
      await retry();
      continue;
    }
    // A server error from Meta does not say whether the message went out.
    if (res.status >= 500) throw deliveryUnknown();
    throw metaError(res.status, reply.error?.code);
  }
}

export const whatsAppService: WhatsAppService = {
  sendText: (to, text, trackingId) =>
    send(to, { type: 'text', text: { body: text, preview_url: false }, ...(trackingId && { biz_opaque_callback_data: trackingId }) }),

  sendTemplate: (to, template, language, params) =>
    send(to, {
      type: 'template',
      template: {
        name: template,
        language: { code: language },
        ...(params.length && { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] }),
      },
    }),

  verifySignature(rawBody, signature) {
    if (!env.WHATSAPP_APP_SECRET) return false;
    const expected = `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`;
    return sameString(signature, expected);
  },

  verifyToken: (token) => Boolean(env.WHATSAPP_VERIFY_TOKEN) && sameString(token, env.WHATSAPP_VERIFY_TOKEN!),
};
