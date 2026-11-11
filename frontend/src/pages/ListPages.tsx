import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { Card, CustomerCell, DataStateNotice, DataTable, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import type { Column } from '../components/ui';
import { useApi } from '../lib/api';
import type { Appointment, Conversation, Lead } from '../lib/api';
import { formatDateTime, formatStatus } from '../lib/format';

const PAGE_SIZE = 20;

function ListPage<T extends { id: string }>(props: {
  title: string;
  description: string;
  endpoint: string;
  statuses: readonly string[];
  columns: Column<T>[];
  noun: string;
  emptyDetail: string;
}) {
  // Filter and page live in the URL, so they survive reloads and can be shared.
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), ...(status && { status }) });
  const { result, error, loading, refetch } = useApi<T[]>(`${props.endpoint}?${query}`);
  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const update = (next: { status?: string; page?: number }) => {
    const nextStatus = next.status ?? status;
    const nextPage = next.page ?? 1;
    setParams({ ...(nextStatus && { status: nextStatus }), ...(nextPage > 1 && { page: String(nextPage) }) });
  };

  return (
    <>
      <PageHeader title={props.title} description={props.description}>
        <label className="flex items-center gap-2 text-sm text-stone-600">
          Status
          <select
            value={status}
            onChange={(e) => update({ status: e.target.value })}
            className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-900"
          >
            <option value="">All</option>
            {props.statuses.map((s) => (
              <option key={s} value={s}>
                {formatStatus(s)}
              </option>
            ))}
          </select>
        </label>
      </PageHeader>
      <DataStateNotice state={result?.meta.dataState} />
      <Card>
        {loading ? (
          <Skeleton rows={6} />
        ) : error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : result?.data.length ? (
          <>
            <DataTable columns={props.columns} rows={result.data} />
            <div className="flex items-center justify-between border-t border-stone-100 px-5 py-3 text-sm text-stone-600">
              <span className="tabular-nums">
                {total} {total === 1 ? props.noun : `${props.noun}s`} · page {page} of {lastPage}
              </span>
              <span className="flex gap-1">
                <button aria-label="Previous page" disabled={page <= 1} onClick={() => update({ page: page - 1 })} className="rounded-lg border border-stone-300 p-1.5 hover:bg-stone-50 disabled:opacity-40">
                  <ChevronLeft className="size-4" aria-hidden />
                </button>
                <button aria-label="Next page" disabled={page >= lastPage} onClick={() => update({ page: page + 1 })} className="rounded-lg border border-stone-300 p-1.5 hover:bg-stone-50 disabled:opacity-40">
                  <ChevronRight className="size-4" aria-hidden />
                </button>
              </span>
            </div>
          </>
        ) : result?.meta.dataState === 'database_not_configured' ? (
          <EmptyState title={`Cannot load ${props.noun}s`}>Connect a database to see real records.</EmptyState>
        ) : status || page > 1 ? (
          <EmptyState title={`No matching ${props.noun}s`}>Try a different status or page.</EmptyState>
        ) : (
          <EmptyState title={`No ${props.noun}s yet`}>{props.emptyDetail}</EmptyState>
        )}
      </Card>
    </>
  );
}

export function Conversations() {
  return (
    <ListPage<Conversation>
      title="Conversations"
      description="Customer threads handled by the AI and your staff."
      endpoint="/conversations"
      noun="conversation"
      statuses={['open', 'handover_requested', 'human_active', 'closed']}
      emptyDetail="Threads appear here once WhatsApp messaging is connected."
      columns={[
        { header: 'Customer', cell: (c) => <CustomerCell name={c.customerName} phone={c.customerPhone} /> },
        { header: 'Last message', cell: (c) => <p className="line-clamp-2 max-w-sm text-stone-600">{c.lastMessage ?? '—'}</p> },
        { header: 'Messages', cell: (c) => <span className="tabular-nums">{c.messageCount}</span> },
        { header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
        { header: 'Last activity', cell: (c) => <span className="whitespace-nowrap text-stone-600">{formatDateTime(c.lastMessageAt)}</span> },
      ]}
    />
  );
}

export function Leads() {
  return (
    <ListPage<Lead>
      title="Leads"
      description="Potential customers captured from conversations."
      endpoint="/leads"
      noun="lead"
      statuses={['new', 'contacted', 'qualified', 'converted', 'lost']}
      emptyDetail="Leads appear here once lead capture is built."
      columns={[
        { header: 'Customer', cell: (l) => <CustomerCell name={l.customerName} phone={l.customerPhone} /> },
        { header: 'Interest', cell: (l) => <p className="line-clamp-2 max-w-sm text-stone-600">{l.interest ?? l.serviceName ?? '—'}</p> },
        { header: 'Source', cell: (l) => <span className="text-stone-600">{formatStatus(l.source)}</span> },
        { header: 'Status', cell: (l) => <StatusBadge status={l.status} /> },
        { header: 'Created', cell: (l) => <span className="whitespace-nowrap text-stone-600">{formatDateTime(l.createdAt)}</span> },
      ]}
    />
  );
}

export function Appointments() {
  return (
    <ListPage<Appointment>
      title="Appointments"
      description="Bookings made through the receptionist."
      endpoint="/appointments"
      noun="appointment"
      statuses={['pending', 'confirmed', 'cancelled', 'completed', 'no_show']}
      emptyDetail="Bookings appear here once appointment booking is built."
      columns={[
        { header: 'Customer', cell: (a) => <CustomerCell name={a.customerName} phone={a.customerPhone} /> },
        { header: 'Service', cell: (a) => <span className="text-stone-600">{a.serviceName ?? '—'}</span> },
        { header: 'Starts', cell: (a) => <span className="whitespace-nowrap">{formatDateTime(a.startsAt)}</span> },
        { header: 'Ends', cell: (a) => <span className="whitespace-nowrap text-stone-600">{formatDateTime(a.endsAt)}</span> },
        { header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
      ]}
    />
  );
}
