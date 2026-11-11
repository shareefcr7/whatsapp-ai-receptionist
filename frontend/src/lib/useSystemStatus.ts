import { useApi } from './api';
import type { DatabaseHealth } from './api';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface StatusItem {
  label: string;
  detail: string;
  tone: Tone;
}

const POLL_MS = 30_000;

export function useSystemStatus(): { api: StatusItem; database: StatusItem } {
  const health = useApi<{ status: string }>('/health', POLL_MS);
  const db = useApi<DatabaseHealth>('/health/database', POLL_MS);
  const backendDown = Boolean(health.error);

  const api: StatusItem = health.loading
    ? { label: 'Backend API', detail: 'Checking…', tone: 'neutral' }
    : backendDown
      ? { label: 'Backend API', detail: 'Unreachable', tone: 'bad' }
      : { label: 'Backend API', detail: 'Online', tone: 'good' };

  let database: StatusItem = { label: 'Database', detail: 'Checking…', tone: 'neutral' };
  if (backendDown) {
    database = { label: 'Database', detail: 'Unknown (API unreachable)', tone: 'neutral' };
  } else if (db.error) {
    database =
      db.error.code === 'DATABASE_NOT_CONFIGURED'
        ? { label: 'Database', detail: 'Not configured', tone: 'warn' }
        : { label: 'Database', detail: 'Unreachable', tone: 'bad' };
  } else if (db.result) {
    const { serverVersion, migrationsApplied } = db.result.data;
    database = migrationsApplied
      ? { label: 'Database', detail: `Connected (PostgreSQL ${serverVersion})`, tone: 'good' }
      : { label: 'Database', detail: 'Connected, migrations not applied', tone: 'warn' };
  }
  return { api, database };
}
