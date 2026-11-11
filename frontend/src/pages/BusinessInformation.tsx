import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Card,
  DataStateNotice,
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
  SuccessNotice,
} from '../components/ui';
import { apiRequest, useApi } from '../lib/api';
import type { BusinessEntry, BusinessInfo, BusinessProfile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSubmit } from '../lib/useSubmit';

const EMPTY_PROFILE: BusinessProfile = { name: '', description: '', address: '', phone: '', email: '', website: '', workingHours: '', isPublished: false };

function ProfileForm({ initial, isAdmin }: { initial: BusinessProfile; isAdmin: boolean }) {
  const [profile, setProfile] = useState(initial);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useSubmit();
  const set = <K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) => {
    setSaved(false);
    setProfile((current) => ({ ...current, [key]: value }));
  };
  const text = (key: Exclude<keyof BusinessProfile, 'isPublished'>) => ({
    className: inputClass,
    value: profile[key],
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    await run(async () => {
      const { data } = await apiRequest<BusinessProfile>('/business-info/profile', { method: 'PUT', body: profile });
      setProfile(data);
      setSaved(true);
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <fieldset disabled={!isAdmin || busy} className="space-y-4 p-5">
        <FormError error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name" errors={error?.details?.name}>
            <input {...text('name')} required />
          </Field>
          <Field label="Phone" errors={error?.details?.phone}>
            <input {...text('phone')} type="tel" />
          </Field>
          <Field label="Email" errors={error?.details?.email}>
            <input {...text('email')} type="email" />
          </Field>
          <Field label="Website" errors={error?.details?.website}>
            <input {...text('website')} type="url" placeholder="https://" />
          </Field>
        </div>
        <Field label="Description" errors={error?.details?.description}>
          <textarea {...text('description')} rows={3} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Address" errors={error?.details?.address}>
            <textarea {...text('address')} rows={3} />
          </Field>
          <Field label="Working hours" errors={error?.details?.workingHours}>
            <textarea {...text('workingHours')} rows={3} placeholder={'Mon–Fri 9:00–17:00\nSat 10:00–14:00'} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={profile.isPublished} onChange={(e) => set('isPublished', e.target.checked)} />
          Published: the AI may share these details once it is connected
        </label>
        {isAdmin && (
          <div className="flex items-center gap-3">
            <button type="submit" className={primaryButtonClass}>
              {busy ? 'Saving…' : 'Save details'}
            </button>
            {saved && <SuccessNotice>Saved to the database.</SuccessNotice>}
          </div>
        )}
      </fieldset>
    </form>
  );
}

const CATEGORIES = [
  { value: 'policy', label: 'Policy' },
  { value: 'faq', label: 'FAQ' },
  { value: 'general', label: 'General' },
];

const NEW_ENTRY = { category: 'policy', title: '', content: '', isPublished: false };

function EntryForm({ entry, onDone, onCancel }: { entry?: BusinessEntry; onDone: (message: string) => void; onCancel: () => void }) {
  const [values, setValues] = useState(
    entry ? { category: entry.category, title: entry.title, content: entry.content, isPublished: entry.isPublished } : NEW_ENTRY,
  );
  const { busy, error, run } = useSubmit();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      await apiRequest(entry ? `/business-info/entries/${entry.id}` : '/business-info/entries', { method: entry ? 'PUT' : 'POST', body: values });
    });
    if (ok) onDone(entry ? `Updated "${values.title.trim()}".` : `Added "${values.title.trim()}".`);
  }

  return (
    <form onSubmit={submit} noValidate className="bg-stone-50 px-5 py-4">
      <fieldset disabled={busy} className="space-y-3">
        <FormError error={error} />
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Type" errors={error?.details?.category}>
            <select className={inputClass} value={values.category} onChange={(e) => setValues({ ...values, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title" errors={error?.details?.title}>
            <input className={inputClass} value={values.title} onChange={(e) => setValues({ ...values, title: e.target.value })} />
          </Field>
        </div>
        <Field label="Content" errors={error?.details?.content}>
          <textarea className={inputClass} rows={4} value={values.content} onChange={(e) => setValues({ ...values, content: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={values.isPublished} onChange={(e) => setValues({ ...values, isPublished: e.target.checked })} />
          Published: the AI may use this once it is connected
        </label>
        <div className="flex gap-2">
          <button type="submit" className={primaryButtonClass}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onCancel} className={secondaryButtonClass}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function Entries({ isAdmin }: { isAdmin: boolean }) {
  // Fetched apart from the profile, so reloading this list never discards unsaved profile edits.
  const { result, error, loading, refetch } = useApi<BusinessInfo>('/business-info');
  const [editing, setEditing] = useState<string | null>(null); // an entry id, or 'new'
  const [notice, setNotice] = useState('');
  const remove = useSubmit();

  const finish = (message: string) => {
    setEditing(null);
    setNotice(message);
    refetch();
  };

  async function deleteEntry(entry: BusinessEntry) {
    if (!window.confirm(`Delete "${entry.title}"? This cannot be undone.`)) return;
    setNotice('');
    const ok = await remove.run(async () => {
      await apiRequest(`/business-info/entries/${entry.id}`, { method: 'DELETE' });
    });
    if (ok) finish(`Deleted "${entry.title}".`);
  }

  const entries = result?.data.entries ?? [];
  return (
    <Card
      title="Policies and FAQs"
      action={
        isAdmin && editing !== 'new' ? (
          <button
            onClick={() => {
              setNotice('');
              setEditing('new');
            }}
            className={secondaryButtonClass}
          >
            <Plus className="size-3.5" aria-hidden /> Add
          </button>
        ) : undefined
      }
    >
      {(notice || remove.error) && (
        <div className="border-b border-stone-100 px-5 py-3">
          {notice && <SuccessNotice>{notice}</SuccessNotice>}
          <FormError error={remove.error} />
        </div>
      )}
      {editing === 'new' && <EntryForm onDone={finish} onCancel={() => setEditing(null)} />}
      {loading ? (
        <Skeleton />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : entries.length ? (
        <ul className="divide-y divide-stone-100">
          {entries.map((entry) =>
            editing === entry.id ? (
              <li key={entry.id}>
                <EntryForm entry={entry} onDone={finish} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <li key={entry.id} className="px-5 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{entry.title}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="mr-1 text-xs text-stone-500">
                      {CATEGORIES.find((c) => c.value === entry.category)?.label ?? entry.category} · {entry.isPublished ? 'Published' : 'Draft'}
                    </span>
                    {isAdmin && (
                      <>
                        <button onClick={() => setEditing(entry.id)} aria-label={`Edit ${entry.title}`} className={iconButtonClass}>
                          <Pencil className="size-3.5" aria-hidden />
                        </button>
                        <button onClick={() => void deleteEntry(entry)} disabled={remove.busy} aria-label={`Delete ${entry.title}`} className={iconButtonClass}>
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-line text-stone-600">{entry.content}</p>
              </li>
            ),
          )}
        </ul>
      ) : (
        editing !== 'new' && <EmptyState title="No policies or FAQs yet">{isAdmin ? 'Add refund rules, cancellation terms and common questions.' : 'An admin can add these.'}</EmptyState>
      )}
    </Card>
  );
}

export function BusinessInformation() {
  const { result, error, loading, refetch } = useApi<BusinessInfo>('/business-info');
  const { isAdmin } = useAuth();

  return (
    <>
      <PageHeader
        title="Business Information"
        description={`What the AI will be allowed to tell customers. Nothing reaches customers yet: WhatsApp and the AI are not connected.${isAdmin ? '' : ' Only an admin can edit this page.'}`}
      />
      <DataStateNotice state={result?.meta.dataState} />
      <div className="space-y-6">
        <Card title="Business details">
          {loading ? (
            <Skeleton rows={6} />
          ) : error ? (
            <ErrorState error={error} onRetry={refetch} />
          ) : (
            <ProfileForm initial={result?.data.profile ?? EMPTY_PROFILE} isAdmin={isAdmin} />
          )}
        </Card>
        <Entries isAdmin={isAdmin} />
      </div>
    </>
  );
}
