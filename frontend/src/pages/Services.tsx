import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Card,
  DataStateNotice,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  iconButtonClass,
  inputClass,
  PageHeader,
  primaryButtonClass,
  secondaryButtonClass,
  Skeleton,
  StatusBadge,
  SuccessNotice,
} from '../components/ui';
import { apiRequest, useApi } from '../lib/api';
import type { Service } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSubmit } from '../lib/useSubmit';

function ServiceForm({ service, onDone, onCancel }: { service?: Service; onDone: (message: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(service?.name ?? '');
  const [description, setDescription] = useState(service?.description ?? '');
  const [duration, setDuration] = useState(service ? String(service.durationMinutes) : '30');
  const [price, setPrice] = useState(service?.priceAmount ?? '');
  const [currency, setCurrency] = useState(service?.currency ?? '');
  const [isActive, setIsActive] = useState(service?.isActive ?? true);
  const { busy, error, run } = useSubmit();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = {
      name,
      description: description || null,
      durationMinutes: duration === '' ? null : Number(duration),
      priceAmount: price.trim() || null,
      currency: currency.trim() || null,
      isActive,
    };
    const ok = await run(async () => {
      await apiRequest(service ? `/services/${service.id}` : '/services', { method: service ? 'PUT' : 'POST', body });
    });
    if (ok) onDone(service ? `Updated "${name.trim()}".` : `Added "${name.trim()}".`);
  }

  return (
    <form onSubmit={submit} noValidate className="border-b border-stone-100 bg-stone-50 px-5 py-4">
      <fieldset disabled={busy} className="space-y-3">
        <h3 className="text-sm font-semibold">{service ? `Edit ${service.name}` : 'New service'}</h3>
        <FormError error={error} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name" errors={error?.details?.name}>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Duration (minutes)" errors={error?.details?.durationMinutes}>
            <input className={inputClass} type="number" min={1} max={1440} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </Field>
          <Field label="Price (optional)" errors={error?.details?.priceAmount}>
            <input className={inputClass} inputMode="decimal" placeholder="25.00" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Currency" errors={error?.details?.currency}>
            <input className={inputClass} maxLength={3} placeholder="USD" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </Field>
        </div>
        <Field label="Description (optional)" errors={error?.details?.description}>
          <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active: can be offered and booked
        </label>
        <div className="flex gap-2">
          <button type="submit" className={primaryButtonClass}>
            {busy ? 'Saving…' : 'Save service'}
          </button>
          <button type="button" onClick={onCancel} className={secondaryButtonClass}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export function Services() {
  // ponytail: first 100 only, which is the API's page limit. Add paging if a business ever lists more.
  const { result, error, loading, refetch } = useApi<Service[]>('/services?limit=100');
  const { isAdmin } = useAuth();
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [notice, setNotice] = useState('');
  const remove = useSubmit();

  const finish = (message: string) => {
    setEditing(null);
    setNotice(message);
    refetch();
  };

  async function deleteService(service: Service) {
    const warning = `Delete "${service.name}"? This cannot be undone. Its leads and appointments are kept but lose their link to this service. To retire a service and keep that link, mark it inactive instead.`;
    if (!window.confirm(warning)) return;
    setNotice('');
    const ok = await remove.run(async () => {
      await apiRequest(`/services/${service.id}`, { method: 'DELETE' });
    });
    if (ok) finish(`Deleted "${service.name}".`);
  }

  const unknown = result?.meta.dataState === 'database_not_configured';
  return (
    <>
      <PageHeader title="Services" description={`What customers can ask for and book.${isAdmin || unknown ? '' : ' Only an admin can edit this page.'}`}>
        {isAdmin && (
          <button
            onClick={() => {
              setNotice('');
              setEditing('new');
            }}
            className={primaryButtonClass}
          >
            <Plus className="size-4" aria-hidden /> Add service
          </button>
        )}
      </PageHeader>
      <DataStateNotice state={result?.meta.dataState} />
      <Card>
        {(notice || remove.error) && (
          <div className="border-b border-stone-100 px-5 py-3">
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
            <FormError error={remove.error} />
          </div>
        )}
        {editing && (
          <ServiceForm
            key={editing === 'new' ? 'new' : editing.id}
            service={editing === 'new' ? undefined : editing}
            onDone={finish}
            onCancel={() => setEditing(null)}
          />
        )}
        {loading ? (
          <Skeleton />
        ) : error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : result?.data.length ? (
          <DataTable
            rows={result.data}
            columns={[
              {
                header: 'Service',
                cell: (s) => (
                  <>
                    <div className="font-medium">{s.name}</div>
                    {s.description && <div className="max-w-md text-xs text-stone-500">{s.description}</div>}
                  </>
                ),
              },
              { header: 'Duration', cell: (s) => <span className="tabular-nums">{s.durationMinutes} min</span> },
              { header: 'Price', cell: (s) => <span className="whitespace-nowrap tabular-nums">{s.priceAmount ? `${s.priceAmount} ${s.currency}` : '—'}</span> },
              { header: 'Status', cell: (s) => <StatusBadge status={s.isActive ? 'active' : 'inactive'} /> },
              ...(isAdmin
                ? [
                    {
                      header: 'Actions',
                      cell: (s: Service) => (
                        <span className="flex gap-1">
                          <button
                            onClick={() => {
                              setNotice('');
                              setEditing(s);
                            }}
                            aria-label={`Edit ${s.name}`}
                            className={iconButtonClass}
                          >
                            <Pencil className="size-3.5" aria-hidden />
                          </button>
                          <button onClick={() => void deleteService(s)} disabled={remove.busy} aria-label={`Delete ${s.name}`} className={iconButtonClass}>
                            <Trash2 className="size-3.5" aria-hidden />
                          </button>
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        ) : (
          <EmptyState title={unknown ? 'Cannot load services' : 'No services yet'}>
            {unknown ? 'Connect a database to see real records.' : isAdmin ? 'Add your first service to get started.' : 'An admin can add services.'}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
