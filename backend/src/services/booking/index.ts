import { query } from '../../database/pool.ts';
import type { APPOINTMENT_STATUSES, ListQuery, Page } from '../../types/api.ts';
import { PendingIntegrationError } from '../../types/errors.ts';

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export interface Appointment {
  id: string;
  customerName: string | null;
  customerPhone: string;
  serviceName: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  googleCalendarEventId: string | null;
}

export interface NewAppointment {
  customerId: string;
  serviceId: string;
  staffId?: string;
  startsAt: Date;
  endsAt: Date;
}

export interface BookingService {
  /** Implemented. */
  list(q: ListQuery<AppointmentStatus>): Promise<Page<Appointment>>;
  /** Implemented: confirmed or pending appointments that have not started. */
  upcoming(limit: number): Promise<Appointment[]>;
  /** Pending, as are the three below. */
  checkAvailability(serviceId: string, from: Date, to: Date): Promise<{ start: Date; end: Date }[]>;
  book(appointment: NewAppointment): Promise<Appointment>;
  reschedule(id: string, startsAt: Date, endsAt: Date): Promise<Appointment>;
  cancel(id: string, reason?: string): Promise<void>;
}

const SELECT = `
  SELECT a.id, c.name AS "customerName", c.phone_number AS "customerPhone", s.name AS "serviceName",
         a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.status,
         a.google_calendar_event_id AS "googleCalendarEventId"
  FROM appointments a
  JOIN customers c ON c.id = a.customer_id
  LEFT JOIN services s ON s.id = a.service_id`;

const pending = async () => {
  throw new PendingIntegrationError('Appointment booking');
};

export const bookingService: BookingService = {
  async list({ page, limit, status }) {
    const [rows, count] = await Promise.all([
      query<Appointment & Record<string, unknown>>(
        `${SELECT} WHERE ($1::text IS NULL OR a.status = $1) ORDER BY a.starts_at DESC LIMIT $2 OFFSET $3`,
        [status ?? null, limit, (page - 1) * limit],
      ),
      query<{ total: number }>(
        'SELECT count(*)::int AS total FROM appointments WHERE ($1::text IS NULL OR status = $1)',
        [status ?? null],
      ),
    ]);
    return { rows, total: count[0]?.total ?? 0 };
  },
  upcoming: (limit) =>
    query<Appointment & Record<string, unknown>>(
      `${SELECT} WHERE a.status IN ('pending', 'confirmed') AND a.starts_at >= now() ORDER BY a.starts_at LIMIT $1`,
      [limit],
    ),
  checkAvailability: pending,
  book: pending,
  reschedule: pending,
  cancel: pending,
};
