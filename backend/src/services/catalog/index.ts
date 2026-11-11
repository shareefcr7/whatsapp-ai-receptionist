import { query } from '../../database/pool.ts';
import type { ListQuery, Page, ServiceInput, SERVICE_STATUSES } from '../../types/api.ts';
import { AppError } from '../../types/errors.ts';

export interface Service {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceAmount: string | null;
  currency: string | null;
  isActive: boolean;
  updatedAt: string;
}

const COLUMNS = `id, name, description, duration_minutes AS "durationMinutes", price_amount AS "priceAmount",
                 currency, is_active AS "isActive", updated_at AS "updatedAt"`;
const notFound = () => new AppError(404, 'NOT_FOUND', 'That service no longer exists.');
const values = (s: ServiceInput) => [s.name, s.description, s.durationMinutes, s.priceAmount, s.currency, s.isActive];

export const catalogService = {
  async list({ page, limit, status }: ListQuery<(typeof SERVICE_STATUSES)[number]>): Promise<Page<Service>> {
    const active = status ? status === 'active' : null;
    const [rows, count] = await Promise.all([
      query<Service & Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM services WHERE ($1::boolean IS NULL OR is_active = $1) ORDER BY name LIMIT $2 OFFSET $3`,
        [active, limit, (page - 1) * limit],
      ),
      query<{ total: number }>('SELECT count(*)::int AS total FROM services WHERE ($1::boolean IS NULL OR is_active = $1)', [active]),
    ]);
    return { rows, total: count[0]?.total ?? 0 };
  },

  async create(input: ServiceInput): Promise<Service> {
    const [row] = await query<Service & Record<string, unknown>>(
      `INSERT INTO services (name, description, duration_minutes, price_amount, currency, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      values(input),
    );
    return row!;
  },

  async update(id: string, input: ServiceInput): Promise<Service> {
    const [row] = await query<Service & Record<string, unknown>>(
      `UPDATE services SET name = $2, description = $3, duration_minutes = $4, price_amount = $5, currency = $6, is_active = $7
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, ...values(input)],
    );
    if (!row) throw notFound();
    return row;
  },

  /** Leads and appointments keep their rows; the schema sets their service_id to NULL. */
  async remove(id: string): Promise<void> {
    const rows = await query('DELETE FROM services WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) throw notFound();
  },
};
