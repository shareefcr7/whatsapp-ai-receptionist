import { z } from 'zod';

// `KEY=` in a .env file arrives as '', which means "not set".
const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('127.0.0.1')),
    FRONTEND_URL: optional,
    DATABASE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// or postgresql:// URL' }).optional(),
    ),
    OPENAI_API_KEY: optional,
    OPENAI_MODEL: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('gpt-4.1-mini')),
    // Off unless exactly "true": a typo fails startup instead of silently enabling paid replies.
    AI_AUTO_REPLY_ENABLED: z.preprocess(
      (v) => (v === '' ? undefined : typeof v === 'string' ? v.trim().toLowerCase() : v),
      z.enum(['true', 'false'], { error: 'must be "true" or "false"' }).default('false').transform((v) => v === 'true'),
    ),
    // OpenAI calls allowed in any rolling 24 hours, in total and per customer. 0 stops AI replies.
    AI_DAILY_REPLY_LIMIT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(0).max(100_000).default(200)),
    AI_CUSTOMER_DAILY_REPLY_LIMIT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(0).max(1_000).default(20)),
    // Server-side limit on any one database statement, so a slow or stuck query cannot hold a conversation lock or a
    // send slot for long. (A network partition is not covered: the server cannot cancel what it cannot reach.)
    // At least 5s: it must stay above the 3s conversation lock_timeout, or a lock wait would be cancelled as a
    // statement timeout instead of answering "busy".
    DB_STATEMENT_TIMEOUT_MS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(5_000).max(600_000).default(30_000)),
    // Older messages (by Meta's timestamp, e.g. delivered late after an outage) go to staff instead of the AI.
    AI_MAX_MESSAGE_AGE_MINUTES: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(1_440).default(15)),
    WHATSAPP_ACCESS_TOKEN: optional,
    WHATSAPP_PHONE_NUMBER_ID: optional,
    WHATSAPP_BUSINESS_ACCOUNT_ID: optional,
    WHATSAPP_VERIFY_TOKEN: optional,
    WHATSAPP_APP_SECRET: optional,
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GOOGLE_REDIRECT_URI: optional,
    GOOGLE_CALENDAR_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('primary')),
    // AES-256 key for OAuth tokens at rest: 32 random bytes, base64. Generate with: openssl rand -base64 32
    GOOGLE_TOKEN_ENCRYPTION_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .refine((v) => /^[A-Za-z0-9+/]+=*$/.test(v) && Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64 encoded')
        .optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['DATABASE_URL', 'FRONTEND_URL'] as const) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
    }
  });

export type Env = z.infer<typeof schema>;

/** Reports variable names only, so a malformed secret never reaches the logs. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${problems}`);
}

export const env = parseEnv(process.env);

export const allowedOrigins = (env.FRONTEND_URL ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
