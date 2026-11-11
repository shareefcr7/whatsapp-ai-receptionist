import { MessageSquareText } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Field, FormError, inputClass, primaryButtonClass } from '../components/ui';
import { apiRequest } from '../lib/api';
import { useSubmit } from '../lib/useSubmit';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const signedIn = await run(() => apiRequest('/auth/login', { method: 'POST', body: { email, password } }).then(() => undefined));
    if (signedIn) onSignedIn();
    else setPassword('');
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-stone-100 px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-stone-200 bg-white p-6 shadow-xs">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
            <MessageSquareText className="size-4.5" aria-hidden />
          </span>
          <h1 className="text-base font-semibold">AI Receptionist</h1>
        </div>
        <p className="text-sm text-stone-600">Sign in with your staff account.</p>
        <FormError error={error} />
        <Field label="Email" errors={error?.details?.email}>
          <input className={inputClass} type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" errors={error?.details?.password}>
          <input className={inputClass} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button type="submit" disabled={busy} className={`${primaryButtonClass} w-full justify-center`}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
