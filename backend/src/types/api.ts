import { z } from 'zod';

/**
 * Why a response has the data it has. `database_not_configured` means "we cannot know",
 * which the dashboard must not present as "there is nothing".
 */
export type DataState = 'has_data' | 'empty' | 'database_not_configured';

export interface Page<T> {
  rows: T[];
  total: number;
}

// These lists mirror the CHECK constraints in database/migrations.
export const CONVERSATION_STATUSES = ['open', 'handover_requested', 'human_active', 'closed'] as const;
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'] as const;
export const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'] as const;

export function listQuerySchema<const S extends readonly [string, ...string[]]>(statuses: S) {
  return z.strictObject({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(statuses).optional(),
  });
}

export interface ListQuery<S extends string = string> {
  page: number;
  limit: number;
  status?: S | undefined;
}

export const SERVICE_STATUSES = ['active', 'inactive'] as const;

export const idParam = z.uuid();

const optionalText = (max: number) => z.string().trim().max(max).default('');

export const loginSchema = z.strictObject({
  email: z.string().trim().max(254).pipe(z.email()),
  password: z.string().min(1).max(200), // the length cap stops huge inputs reaching the hash
});

/** Blank optional fields are allowed: saving one blank removes that detail. */
export const profileSchema = z.strictObject({
  name: z.string().trim().min(1, 'Business name is required.').max(200),
  description: optionalText(2000),
  address: optionalText(500),
  phone: z.string().trim().regex(/^$|^\+?[0-9][0-9 ()\-.]{5,24}$/, 'Enter a valid phone number.').default(''),
  email: z.string().trim().pipe(z.union([z.literal(''), z.email('Enter a valid email address.')])).default(''),
  website: z.string().trim().pipe(z.union([z.literal(''), z.url({ protocol: /^https?$/, error: 'Enter a full http:// or https:// address.' })])).default(''),
  workingHours: optionalText(1000),
  isPublished: z.boolean().default(false),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export const entrySchema = z.strictObject({
  category: z.enum(['policy', 'faq', 'general']),
  title: z.string().trim().min(1, 'Title is required.').max(200),
  content: z.string().trim().min(1, 'Content is required.').max(5000),
  isPublished: z.boolean().default(false),
});
export type EntryInput = z.infer<typeof entrySchema>;

export const serviceSchema = z
  .strictObject({
    name: z.string().trim().min(1, 'Name is required.').max(120),
    description: z.string().trim().max(2000).nullable().default(null).transform((v) => v || null),
    durationMinutes: z.number('Duration is required.').int('Use whole minutes.').min(1, 'Must be at least 1 minute.').max(1440, 'Must be 24 hours or less.'),
    // A string, because money must not pass through a float. Matches numeric(12, 2).
    priceAmount: z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Enter an amount such as 25 or 25.50.').nullable().default(null),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter code such as USD.').nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .refine((s) => s.priceAmount === null || s.currency !== null, { path: ['currency'], error: 'A price needs a currency.' })
  .transform((s) => ({ ...s, currency: s.priceAmount === null ? null : s.currency }));
export type ServiceInput = z.infer<typeof serviceSchema>;

// Words that make a password guessable however long it is, alone or repeated.
const COMMON_PASSWORD_WORDS = ['password', 'passwd', 'admin', 'administrator', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'abc', 'abcdef', 'receptionist', 'whatsapp', 'changeme', 'secret'];

/**
 * Length, not forced symbols, is what makes a password strong, so long passphrases are welcome.
 * Returns what is wrong, or null. The message never repeats the password.
 */
export function passwordProblem(password: string, personal: string[] = []): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 200) return 'Use 200 characters or fewer.';
  if (new Set(password).size < 6) return 'That has too many repeated characters.';
  if (/^\d+$/.test(password)) return 'Do not use only numbers.';
  const lower = password.toLowerCase();
  const letters = lower.replace(/[^\p{L}]/gu, '');
  if (COMMON_PASSWORD_WORDS.some((word) => letters.replaceAll(word, '') === '')) return 'That password is too easy to guess.';
  const words = personal.flatMap((text) => text.toLowerCase().split(/[\s@.]+/)).filter((word) => word.length >= 3);
  if (words.some((word) => lower.includes(word))) return 'Do not include your name or email.';
  return null;
}
