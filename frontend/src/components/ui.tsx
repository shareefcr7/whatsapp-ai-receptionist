import { AlertTriangle, CheckCircle2, CircleAlert, Inbox, RotateCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ApiError, DataState } from '../lib/api';
import { formatStatus } from '../lib/format';
import type { StatusItem, Tone } from '../lib/useSystemStatus';

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-stone-600">{description}</p>
      </div>
      {children}
    </header>
  );
}

export function Card({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-stone-200 bg-white shadow-xs ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-stone-100 text-stone-500">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-stone-500">{children}</p>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-10 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-red-50 text-red-600">
        <CircleAlert className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-medium">Could not load this data</p>
      <p className="mt-1 max-w-sm text-sm text-stone-500">{error.message}</p>
      <button
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
      >
        <RotateCw className="size-3.5" aria-hidden /> Try again
      </button>
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="animate-pulse space-y-3 p-5 motion-reduce:animate-none">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 rounded bg-stone-100" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** Shown when no database is set, so an empty page is not mistaken for "no customers". */
export function DataStateNotice({ state }: { state: DataState | undefined }) {
  if (state !== 'database_not_configured') return null;
  return (
    <div className="mb-6 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        <strong className="font-semibold">Database not configured.</strong> No business data can be shown. Set{' '}
        <code className="font-mono text-xs">DATABASE_URL</code> in <code className="font-mono text-xs">backend/.env</code> and run the migrations.
      </p>
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  open: 'bg-brand-50 text-brand-700',
  active: 'bg-brand-50 text-brand-700',
  confirmed: 'bg-brand-50 text-brand-700',
  converted: 'bg-brand-50 text-brand-700',
  completed: 'bg-brand-50 text-brand-700',
  new: 'bg-sky-50 text-sky-700',
  contacted: 'bg-sky-50 text-sky-700',
  qualified: 'bg-sky-50 text-sky-700',
  human_active: 'bg-sky-50 text-sky-700',
  pending: 'bg-amber-50 text-amber-800',
  handover_requested: 'bg-amber-50 text-amber-800',
  lost: 'bg-stone-100 text-stone-600',
  closed: 'bg-stone-100 text-stone-600',
  cancelled: 'bg-red-50 text-red-700',
  no_show: 'bg-red-50 text-red-700',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_TONES[status] ?? 'bg-stone-100 text-stone-600'}`}>
      {formatStatus(status)}
    </span>
  );
}

const DOT_TONES: Record<Tone, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  neutral: 'bg-stone-400',
};

export function StatusDot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${DOT_TONES[tone]}`} />;
}

export function StatusList({ items }: { items: StatusItem[] }) {
  return (
    <ul className="divide-y divide-stone-100">
      {items.map((item) => (
        <li key={item.label} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
          <span className="flex items-center gap-2.5 font-medium">
            <StatusDot tone={item.tone} /> {item.label}
          </span>
          <span className="text-right text-stone-600">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
}

export function DataTable<T extends { id: string }>({ columns, rows }: { columns: Column<T>[]; rows: T[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-stone-100 text-xs tracking-wide text-stone-500 uppercase">
            {columns.map((column) => (
              <th key={column.header} scope="col" className="px-5 py-3 font-medium whitespace-nowrap">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-stone-50">
              {columns.map((column) => (
                <td key={column.header} className="px-5 py-3 align-top">
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CustomerCell({ name, phone }: { name: string | null; phone: string }) {
  return (
    <div className="whitespace-nowrap">
      <div className="font-medium">{name ?? 'Unknown name'}</div>
      <div className="text-xs text-stone-500 tabular-nums">{phone}</div>
    </div>
  );
}

export const inputClass =
  'block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-normal shadow-xs focus:border-brand-600 focus:ring-1 focus:ring-brand-600 focus:outline-none disabled:bg-stone-100 disabled:text-stone-500';
const buttonBase = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-60';
export const primaryButtonClass = `${buttonBase} bg-brand-600 text-white hover:bg-brand-700`;
export const secondaryButtonClass = `${buttonBase} border border-stone-300 bg-white hover:bg-stone-50`;
export const iconButtonClass = 'rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-800 disabled:opacity-60';

/** The input goes inside as a child, so the label is tied to it without ids. */
export function Field({ label, errors, children }: { label: string; errors?: string[] | undefined; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      <span className="mb-1 block">{label}</span>
      {children}
      {errors?.map((message) => (
        <span key={message} role="alert" className="mt-1 block text-xs font-normal text-red-700">
          {message}
        </span>
      ))}
    </label>
  );
}

export function FormError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {error.code === 'VALIDATION_ERROR' ? 'Please fix the highlighted fields.' : error.message}
    </p>
  );
}

export function SuccessNotice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-sm text-brand-700">
      <CheckCircle2 className="size-4 shrink-0" aria-hidden />
      {children}
    </p>
  );
}
