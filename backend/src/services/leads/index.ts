import { query } from '../../database/pool.ts';
import type { LEAD_STATUSES, ListQuery, Page } from '../../types/api.ts';
import { PendingIntegrationError } from '../../types/errors.ts';

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface Lead {
  id: string;
  customerName: string | null;
  customerPhone: string;
  serviceName: string | null;
  interest: string | null;
  source: string;
  status: LeadStatus;
  createdAt: string;
}

export interface LeadService {
  /** Implemented. */
  list(q: ListQuery<LeadStatus>): Promise<Page<Lead>>;
  /** Pending, as is updateStatus. */
  capture(input: { customerId: string; conversationId?: string; serviceId?: string; interest?: string }): Promise<Lead>;
  updateStatus(id: string, status: LeadStatus): Promise<Lead>;
}

const pending = async () => {
  throw new PendingIntegrationError('Lead capture');
};

export const leadService: LeadService = {
  async list({ page, limit, status }) {
    const [rows, count] = await Promise.all([
      query<Lead & Record<string, unknown>>(
        `SELECT l.id, c.name AS "customerName", c.phone_number AS "customerPhone", s.name AS "serviceName",
                l.interest, l.source, l.status, l.created_at AS "createdAt"
         FROM leads l
         JOIN customers c ON c.id = l.customer_id
         LEFT JOIN services s ON s.id = l.service_id
         WHERE ($1::text IS NULL OR l.status = $1)
         ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`,
        [status ?? null, limit, (page - 1) * limit],
      ),
      query<{ total: number }>('SELECT count(*)::int AS total FROM leads WHERE ($1::text IS NULL OR status = $1)', [
        status ?? null,
      ]),
    ]);
    return { rows, total: count[0]?.total ?? 0 };
  },
  capture: pending,
  updateStatus: pending,
};
