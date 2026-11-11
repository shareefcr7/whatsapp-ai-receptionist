import { query } from '../../database/pool.ts';
import type { EntryInput, ProfileInput } from '../../types/api.ts';
import { AppError } from '../../types/errors.ts';

// Stored as business_info rows, the same table the AI will read from.
const PROFILE_FIELDS = {
  name: { key: 'business_name', title: 'Business name' },
  description: { key: 'business_description', title: 'Description' },
  address: { key: 'business_address', title: 'Address' },
  phone: { key: 'contact_phone', title: 'Phone' },
  email: { key: 'contact_email', title: 'Email' },
  website: { key: 'website', title: 'Website' },
  workingHours: { key: 'working_hours', title: 'Working hours' },
} as const;

type ProfileField = keyof typeof PROFILE_FIELDS;
const FIELD_NAMES = Object.keys(PROFILE_FIELDS) as ProfileField[];

export type Profile = Record<ProfileField, string> & { isPublished: boolean };

export interface Entry {
  id: string;
  key: string;
  category: string;
  title: string;
  content: string;
  isPublished: boolean;
  updatedAt: string;
}

const ENTRY_COLUMNS = `id, key, category, title, content, is_published AS "isPublished", updated_at AS "updatedAt"`;
const notFound = () => new AppError(404, 'NOT_FOUND', 'That entry no longer exists.');

export const knowledgeService = {
  /** Profile rows become one object; everything else (policies, FAQs) stays a list. */
  async read(): Promise<{ profile: Profile; entries: Entry[]; hasData: boolean }> {
    const rows = await query<Entry & Record<string, unknown>>(`SELECT ${ENTRY_COLUMNS} FROM business_info ORDER BY category, title`);
    const profileRows = rows.filter((r) => r.category === 'profile');
    const contentOf = (field: ProfileField) => profileRows.find((r) => r.key === PROFILE_FIELDS[field].key)?.content ?? '';
    const profile = Object.fromEntries(FIELD_NAMES.map((f) => [f, contentOf(f)])) as Record<ProfileField, string>;
    return {
      profile: { ...profile, isPublished: profileRows.some((r) => r.isPublished) },
      entries: rows.filter((r) => r.category !== 'profile'),
      hasData: rows.length > 0,
    };
  },

  /** One statement, so a failure cannot leave half a profile. A blank field removes its row. */
  async saveProfile(input: ProfileInput): Promise<void> {
    const filled = FIELD_NAMES.filter((f) => input[f]);
    await query(
      `WITH input (key, title, content) AS (SELECT * FROM unnest($1::text[], $2::text[], $3::text[])),
       removed AS (
         DELETE FROM business_info WHERE category = 'profile' AND key NOT IN (SELECT key FROM input)
       )
       INSERT INTO business_info (key, category, title, content, is_published)
       SELECT key, 'profile', title, content, $4::boolean FROM input
       ON CONFLICT (key) DO UPDATE
         SET title = EXCLUDED.title, content = EXCLUDED.content, is_published = EXCLUDED.is_published`,
      [filled.map((f) => PROFILE_FIELDS[f].key), filled.map((f) => PROFILE_FIELDS[f].title), filled.map((f) => input[f]), input.isPublished],
    );
  },

  async createEntry(input: EntryInput): Promise<Entry> {
    const [row] = await query<Entry & Record<string, unknown>>(
      `INSERT INTO business_info (key, category, title, content, is_published)
       VALUES ($1 || '_' || gen_random_uuid(), $1, $2, $3, $4) RETURNING ${ENTRY_COLUMNS}`,
      [input.category, input.title, input.content, input.isPublished],
    );
    return row!;
  },

  // The profile is edited as a whole through saveProfile, never row by row.
  async updateEntry(id: string, input: EntryInput): Promise<Entry> {
    const [row] = await query<Entry & Record<string, unknown>>(
      `UPDATE business_info SET category = $2, title = $3, content = $4, is_published = $5
       WHERE id = $1 AND category <> 'profile' RETURNING ${ENTRY_COLUMNS}`,
      [id, input.category, input.title, input.content, input.isPublished],
    );
    if (!row) throw notFound();
    return row;
  },

  async deleteEntry(id: string): Promise<void> {
    const rows = await query(`DELETE FROM business_info WHERE id = $1 AND category <> 'profile' RETURNING id`, [id]);
    if (!rows.length) throw notFound();
  },
};
