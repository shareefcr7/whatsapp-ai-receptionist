import { CalendarDays, Hand, MessagesSquare, Send, UserPlus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, CustomerCell, DataStateNotice, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, StatusList } from '../components/ui';
import { useApi } from '../lib/api';
import type { ApiIndex, DashboardSummary } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useSystemStatus } from '../lib/useSystemStatus';
import type { StatusItem } from '../lib/useSystemStatus';

function Kpi({ label, value, icon: Icon, loading }: { label: string; value: number | undefined; icon: LucideIcon; loading: boolean }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between text-stone-500">
        <span className="text-sm">{label}</span>
        <Icon className="size-4" aria-hidden />
      </div>
      {loading ? (
        <div className="mt-3 h-8 w-12 animate-pulse rounded bg-stone-100 motion-reduce:animate-none" />
      ) : (
        // "—" means unknown. 0 is only shown when the database actually says 0.
        <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value ?? '—'}</p>
      )}
    </Card>
  );
}

function Section<T extends { id: string }>(props: {
  title: string;
  to: string;
  rows: T[] | undefined;
  empty: string;
  emptyDetail: string;
  row: (row: T) => ReactNode;
  loading: boolean;
  error: ReactNode;
}) {
  return (
    <Card
      title={props.title}
      action={
        <Link to={props.to} className="text-xs font-medium text-brand-700 hover:underline">
          View all
        </Link>
      }
    >
      {props.loading ? (
        <Skeleton rows={3} />
      ) : props.error ? (
        props.error
      ) : props.rows?.length ? (
        <ul className="divide-y divide-stone-100">
          {props.rows.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-3 px-5 py-3 text-sm">
              {props.row(row)}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={props.empty}>{props.emptyDetail}</EmptyState>
      )}
    </Card>
  );
}

const READY_DETAIL = {
  whatsapp: 'Built · not connected until Meta verifies the webhook',
  openai: 'Built · not in use until WhatsApp is connected',
  googleCalendar: 'Built · connect it in Settings',
} as const;

export function integrationItems(index: ApiIndex | undefined): StatusItem[] {
  const names = { whatsapp: 'WhatsApp', openai: 'OpenAI', googleCalendar: 'Google Calendar' } as const;
  return (Object.keys(names) as (keyof typeof names)[]).map((key) => {
    const integration = index?.integrations[key];
    return {
      label: names[key],
      tone: 'neutral',
      detail: !integration
        ? 'Unknown'
        : integration.credentials === 'missing'
          ? 'Not connected · credentials missing'
          : integration.implementation === 'ready'
            ? READY_DETAIL[key]
            : 'Not connected · integration pending',
    };
  });
}

export function Overview() {
  const { result, error, loading, refetch } = useApi<DashboardSummary>('/dashboard/summary');
  const index = useApi<ApiIndex>('');
  const { api, database } = useSystemStatus();
  const summary = result?.data;
  const errorNode = error && <ErrorState error={error} onRetry={refetch} />;
  const unknown = result?.meta.dataState === 'database_not_configured';
  const emptyDetail = unknown ? 'Connect a database to see real records.' : 'Entries appear once WhatsApp messaging is connected.';

  return (
    <>
      <PageHeader title="Overview" description="Activity from your receptionist. Everything here is read from the backend API." />
      <DataStateNotice state={result?.meta.dataState} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Open conversations" value={summary?.kpis?.openConversations} icon={MessagesSquare} loading={loading} />
        <Kpi label="Awaiting handover" value={summary?.kpis?.awaitingHandover} icon={Hand} loading={loading} />
        <Kpi label="New leads" value={summary?.kpis?.newLeads} icon={UserPlus} loading={loading} />
        <Kpi label="Upcoming bookings" value={summary?.kpis?.upcomingAppointments} icon={CalendarDays} loading={loading} />
        <Kpi label="Messages today" value={summary?.kpis?.messagesToday} icon={Send} loading={loading} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section
          title="Recent conversations"
          to="/conversations"
          rows={summary?.recentConversations}
          empty={unknown ? 'Cannot load conversations' : 'No conversations yet'}
          emptyDetail={emptyDetail}
          loading={loading}
          error={errorNode}
          row={(c) => (
            <>
              <div className="min-w-0">
                <CustomerCell name={c.customerName} phone={c.customerPhone} />
                {c.lastMessage && <p className="mt-1 truncate text-stone-500">{c.lastMessage}</p>}
              </div>
              <StatusBadge status={c.status} />
            </>
          )}
        />
        <Section
          title="Upcoming appointments"
          to="/appointments"
          rows={summary?.upcomingAppointments}
          empty={unknown ? 'Cannot load appointments' : 'No upcoming appointments'}
          emptyDetail={emptyDetail}
          loading={loading}
          error={errorNode}
          row={(a) => (
            <>
              <div className="min-w-0">
                <CustomerCell name={a.customerName} phone={a.customerPhone} />
                <p className="mt-1 text-stone-500">
                  {formatDateTime(a.startsAt)}
                  {a.serviceName && ` · ${a.serviceName}`}
                </p>
              </div>
              <StatusBadge status={a.status} />
            </>
          )}
        />
        <Section
          title="Recent leads"
          to="/leads"
          rows={summary?.recentLeads}
          empty={unknown ? 'Cannot load leads' : 'No leads yet'}
          emptyDetail={emptyDetail}
          loading={loading}
          error={errorNode}
          row={(l) => (
            <>
              <div className="min-w-0">
                <CustomerCell name={l.customerName} phone={l.customerPhone} />
                {l.interest && <p className="mt-1 truncate text-stone-500">{l.interest}</p>}
              </div>
              <StatusBadge status={l.status} />
            </>
          )}
        />
        <Card title="API and system status">
          <StatusList items={[api, database, ...integrationItems(index.result?.data)]} />
          <p className="border-t border-stone-100 px-5 py-3 text-xs text-stone-500">
            WhatsApp webhook, OpenAI replies and Google Calendar are built. WhatsApp is not connected until Meta verifies the webhook; bookings do not use the calendar yet.
          </p>
        </Card>
      </div>
    </>
  );
}
