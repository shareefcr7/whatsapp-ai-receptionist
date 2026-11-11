import { useState } from 'react';
import { ApiError } from './api';

/** Tracks one form or button action: in progress, and the error to show if it fails. */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'The request failed.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}
