import { ArrowLeft, Ban, Bot, CircleAlert, Clock, Hand, History, Lock, RotateCcw, RotateCw, Send, UserCheck, UserRound, WifiOff } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Card, EmptyState, ErrorState, inputClass, primaryButtonClass, secondaryButtonClass, Skeleton, StatusBadge, SuccessNotice } from '../components/ui';
import { ApiError, apiRequest, useApi } from '../lib/api';
import type { ConversationDetail as Detail, ConversationEvent, ConversationMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  actionErrorMessage,
  afterReplyAttempt,
  availableActions,
  deliveryDisplay,
  errorDisplay,
  EVENT_LABELS,
  handledBy,
  keyForSubmit,
  newDraftKey,
  outsideReplyWindow,
  SENDER_LABELS,
} from '../lib/conversations';
import type { DeliveryTone, DraftKey, ReplyAttempt, Tone } from '../lib/conversations';
import { formatDateTime } from '../lib/format';
import { useSubmit } from '../lib/useSubmit';

const MAX_REPLY = 4096;

/** A message shown after an action: green for done, amber for "done, but check" (e.g. delivery unknown). */
type PageNotice = { tone: 'success' | 'warning'; text: string };

/** The audit trail: who did what, from the server's record. Read-only. */
function Activity({ events }: { events: ConversationEvent[] }) {
  return (
    <Card title="Activity" className="mt-4" action={<History className="size-4 text-stone-400" aria-hidden />}>
      {events.length ? (
        <ol className="divide-y divide-stone-100">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-2.5 text-sm">
              <span>
                <span className="font-medium">{e.staffName}</span> {EVENT_LABELS[e.action]}
              </span>
              <time dateTime={e.createdAt} className="text-xs text-stone-500">
                {formatDateTime(e.createdAt)}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-5 py-4 text-sm text-stone-500">No staff actions yet.</p>
      )}
    </Card>
  );
}
const POLL_MS = 15_000;

const HANDLER_TONES: Record<Tone, { className: string; icon: LucideIcon }> = {
  ai: { className: 'bg-brand-50 text-brand-700', icon: Bot },
  staff: { className: 'bg-sky-50 text-sky-700', icon: UserCheck },
  waiting: { className: 'bg-amber-50 text-amber-800', icon: Hand },
  closed: { className: 'bg-stone-100 text-stone-600', icon: Lock },
};

export function HandledByBadge({ status, staffName }: { status: string; staffName: string | null }) {
  const { label, tone } = handledBy(status, staffName);
  const { className, icon: Icon } = HANDLER_TONES[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${className}`}>
      <Icon className="size-3" aria-hidden /> {label}
    </span>
  );
}

export function OptedOutBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-red-700">
      <Ban className="size-3" aria-hidden /> Opted out
    </span>
  );
}

function ActionError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {error.code === 'VALIDATION_ERROR' ? (error.details?.text?.[0] ?? 'Check the message and try again.') : actionErrorMessage(error)}
    </p>
  );
}

function Notice({ tone, icon: Icon, children }: { tone: 'red' | 'amber'; icon: LucideIcon; children: ReactNode }) {
  const colors = tone === 'red' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900';
  return (
    <div className={`flex gap-3 rounded-xl border px-4 py-3 text-sm ${colors}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const DELIVERY_TEXT: Record<DeliveryTone, string> = {
  pending: 'text-stone-500',
  ok: 'text-stone-500',
  warn: 'font-medium text-amber-800',
  bad: 'font-medium text-red-700',
};

function MessageBubble({ m }: { m: ConversationMessage }) {
  const outbound = m.direction === 'outbound';
  const delivery = deliveryDisplay(m.status);
  const colors = delivery.tone === 'bad'
    ? 'border-red-200 bg-red-50'
    : delivery.tone === 'warn'
      ? 'border-amber-200 bg-amber-50'
      : m.senderType === 'ai'
      ? 'border-brand-100 bg-brand-50'
      : m.senderType === 'staff'
        ? 'border-sky-100 bg-sky-50'
        : 'border-stone-200 bg-white';
  return (
    <li className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-xl border px-3 py-2 text-sm sm:max-w-[70%] ${colors}`}>
        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-stone-500">
          <span className="font-medium text-stone-700">
            {SENDER_LABELS[m.senderType]}
            {m.staffName && ` · ${m.staffName}`}
          </span>
          <span>{formatDateTime(m.createdAt)}</span>
          {outbound && <span className={DELIVERY_TEXT[delivery.tone]}>{delivery.label}</span>}
        </div>
        {m.content ? (
          <p className="break-words whitespace-pre-wrap">{m.content}</p>
        ) : (
          <p className="text-stone-500 italic">No text ({m.messageType})</p>
        )}
        {delivery.tone === 'bad' && m.errorMessage && <p className="mt-1 text-xs text-red-700">{m.errorMessage}</p>}
        {delivery.note && <p className="mt-1 text-xs text-amber-800">{delivery.note}</p>}
      </div>
    </li>
  );
}

function ReplyForm({
  conversation,
  submit: { busy, error, run },
  disabled,
  onSent,
}: {
  conversation: Detail;
  submit: ReturnType<typeof useSubmit>;
  disabled: boolean;
  onSent: (notice: PageNotice | null) => void;
}) {
  const [text, setText] = useState('');
  // One key per draft: if this exact submission reaches the server twice, it is sent once (see afterReplyAttempt).
  // The draft's key and the text it was last submitted with: see keyForSubmit and afterReplyAttempt.
  const draft = useRef<DraftKey>({ key: newDraftKey(), text: null });
  const [unconfirmed, setUnconfirmed] = useState(false);
  const outside = outsideReplyWindow(conversation.messages);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    draft.current = keyForSubmit(draft.current, text); // edited text: a new message, never a replay of the old one
    let attempt = { ok: false, code: 'NETWORK_ERROR' } as ReplyAttempt; // set inside run(); `as` stops TS narrowing
    await run(async () => {
      try {
        const { data } = await apiRequest<{ status: string }>(`/conversations/${conversation.id}/messages`, {
          method: 'POST',
          body: { text, clientMessageId: draft.current.key },
        });
        attempt = { ok: true, status: data.status };
      } catch (err) {
        attempt = { ok: false, code: err instanceof ApiError ? err.code : 'NETWORK_ERROR' };
        throw err;
      }
    });
    const next = afterReplyAttempt(attempt);
    if (next.clearDraft) setText('');
    if (next.newKey) draft.current = { key: newDraftKey(), text: null };
    setUnconfirmed(next.outcome === 'unconfirmed');
    // Success is shown for a confirmed send only.
    if (next.outcome === 'sent') {
      onSent({ tone: 'success', text: 'Reply sent. You are now handling this conversation; the AI will not answer it.' });
    } else if (next.outcome === 'unconfirmed') {
      onSent({
        tone: 'warning',
        text: 'We could not confirm this reply was sent. It may already have reached the customer, so check before sending anything else. Your draft is kept: sending it again unchanged is safe and will not send it twice. If you edit it, it becomes a new message.',
      });
    } else {
      onSent(null); // the error is shown above the form; a failed send is saved and still takes over: refresh
    }
  }

  return (
    <form onSubmit={send} className="space-y-2 border-t border-stone-100 px-5 py-4">
      {/* An unconfirmed outcome is explained by the amber notice, not shown as a plain error. */}
      <ActionError error={unconfirmed ? null : error} />
      {outside && !error && (
        <p className="flex gap-2 text-xs text-amber-800">
          <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          The customer last wrote over 24 hours ago, so WhatsApp will probably refuse a reply until they message again.
        </p>
      )}
      <label className="block text-sm font-medium">
        <span className="mb-1 block">Reply as staff</span>
        <textarea
          className={inputClass}
          rows={3}
          maxLength={MAX_REPLY}
          value={text}
          disabled={busy || disabled}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message to the customer"
        />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-stone-500">Sending takes the conversation over from the AI. {text.length}/{MAX_REPLY}</span>
        <button type="submit" className={primaryButtonClass} disabled={busy || disabled || !text.trim()}>
          <Send className="size-3.5" aria-hidden /> {busy ? 'Sending…' : 'Send reply'}
        </button>
      </div>
    </form>
  );
}

const ACTION_COPY = {
  takeover: { label: 'Take over', busy: 'Taking over…', done: 'You are now handling this conversation. The AI will not reply.', icon: UserRound },
  reopen: { label: 'Hand back to AI', busy: 'Handing back…', done: 'Handed back to the AI. It will answer the next customer message.', icon: RotateCcw },
  close: { label: 'Close', busy: 'Closing…', done: 'Conversation closed.', icon: Lock },
  reactivate: { label: 'Reactivate customer', busy: 'Reactivating…', done: 'Customer reactivated. Messages to them are allowed again.', icon: UserCheck },
} as const;
type ButtonAction = keyof typeof ACTION_COPY;

const CONFIRM: Partial<Record<ButtonAction, string>> = {
  close: 'Close this conversation? It cannot be reopened; the customer’s next message starts a new one.',
  reactivate: 'Reactivate this customer? They asked to stop receiving messages. Only do this if they have asked to receive messages again.',
};

export function ConversationDetail() {
  const { id = '' } = useParams();
  const { isAdmin } = useAuth();
  const { result, error, loadedAt, loading, refetch, reload } = useApi<Detail>(`/conversations/${encodeURIComponent(id)}`, POLL_MS);
  const action = useSubmit();
  const reply = useSubmit();
  const [pending, setPending] = useState<ButtonAction | null>(null);
  const [notice, setNotice] = useState<PageNotice | null>(null);

  const conversation = result?.data;

  async function perform(name: ButtonAction) {
    if (CONFIRM[name] && !window.confirm(CONFIRM[name])) return;
    setNotice(null);
    setPending(name);
    const ok = await action.run(async () => {
      await apiRequest(`/conversations/${id}/${name}`, { method: 'POST' });
    });
    setPending(null);
    if (ok) setNotice({ tone: 'success', text: ACTION_COPY[name].done });
    reload();
  }

  const back = (
    <Link to="/conversations" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
      <ArrowLeft className="size-4" aria-hidden /> Conversations
    </Link>
  );

  if (loading) {
    return (
      <>
        {back}
        <Card>
          <Skeleton rows={6} />
        </Card>
      </>
    );
  }
  // Only a first load that never succeeded replaces the page; see errorDisplay.
  if (!conversation) {
    return (
      <>
        {back}
        <Card>
          {error ? <ErrorState error={error} onRetry={refetch} /> : <EmptyState title="Conversation not found" />}
        </Card>
      </>
    );
  }

  const allowed = availableActions(conversation, isAdmin);
  const busy = action.busy || reply.busy;
  const buttons = (['takeover', 'reopen', 'close'] as const).filter((a) => allowed.has(a));

  return (
    <>
      {back}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{conversation.customerName ?? 'Unknown name'}</h1>
          <p className="text-sm text-stone-600 tabular-nums">{conversation.customerPhone}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge status={conversation.status} />
            <HandledByBadge status={conversation.status} staffName={conversation.assignedStaffName} />
            {conversation.optedOut && <OptedOutBadge />}
          </div>
        </div>
        {buttons.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {buttons.map((name) => {
              const { label, busy: busyLabel, icon: Icon } = ACTION_COPY[name];
              return (
                <button key={name} type="button" className={secondaryButtonClass} disabled={busy} onClick={() => perform(name)}>
                  <Icon className="size-3.5" aria-hidden /> {pending === name ? busyLabel : label}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <div className="mb-4 space-y-3">
        {errorDisplay(true, error) === 'warning' && (
          // Polite, not an alert: it must not interrupt someone typing a reply.
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
            <WifiOff className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              Could not refresh this conversation{error?.message ? ` (${error.message.replace(/\.$/, '')})` : ''}. Showing what was loaded
              {loadedAt ? ` at ${formatDateTime(new Date(loadedAt).toISOString())}` : ''}; it will keep retrying. Your draft is safe.
            </span>
            <button type="button" className={secondaryButtonClass} onClick={reload}>
              <RotateCw className="size-3.5" aria-hidden /> Retry now
            </button>
          </div>
        )}
        {notice?.tone === 'success' && <SuccessNotice>{notice.text}</SuccessNotice>}
        {notice?.tone === 'warning' && (
          <p role="status" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
            {notice.text}
          </p>
        )}
        <ActionError error={action.error} />
        {conversation.optedOut && (
          <Notice tone="red" icon={Ban}>
            <p>
              <strong className="font-semibold">This customer opted out</strong>
              {conversation.optedOutAt && ` on ${formatDateTime(conversation.optedOutAt)}`}. Neither the AI nor staff can message them.
            </p>
            {allowed.has('reactivate') ? (
              <button type="button" className={`${secondaryButtonClass} mt-2`} disabled={busy} onClick={() => perform('reactivate')}>
                <UserCheck className="size-3.5" aria-hidden /> {pending === 'reactivate' ? ACTION_COPY.reactivate.busy : ACTION_COPY.reactivate.label}
              </button>
            ) : (
              <p className="mt-1 text-xs">Only an admin can reactivate them, and only if they ask to receive messages again.</p>
            )}
          </Notice>
        )}
        {conversation.handoverReason && conversation.status !== 'open' && conversation.status !== 'closed' && (
          <Notice tone="amber" icon={Hand}>
            <strong className="font-semibold">Handed to staff:</strong> {conversation.handoverReason}
          </Notice>
        )}
      </div>

      <Card title="Messages" action={<span className="text-xs text-stone-500">Refreshes every 15 seconds</span>}>
        {conversation.messages.length ? (
          <ol className="space-y-3 px-5 py-4">
            {conversation.messages.map((m) => (
              <MessageBubble key={m.id} m={m} />
            ))}
          </ol>
        ) : (
          <EmptyState title="No messages yet" />
        )}
        {allowed.has('reply') ? (
          <ReplyForm
            conversation={conversation}
            submit={reply}
            disabled={action.busy}
            onSent={(next) => {
              setNotice(next);
              reload();
            }}
          />
        ) : (
          <p className="border-t border-stone-100 px-5 py-4 text-sm text-stone-500">
            {conversation.status === 'closed' ? 'This conversation is closed.' : 'Replies are disabled while the customer is opted out.'}
          </p>
        )}
      </Card>
      <Activity events={conversation.events} />
    </>
  );
}
