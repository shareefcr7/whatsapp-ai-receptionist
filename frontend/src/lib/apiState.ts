// Pure state transitions for useApi, kept apart from api.ts so they can be tested without a browser.

export interface LoadState<R, E> {
  path: string;
  result: R | null;
  error: E | null;
  /** When `result` was last loaded successfully. */
  loadedAt: number | null;
}

export function loaded<R, E>(path: string, result: R, now = Date.now()): LoadState<R, E> {
  return { path, result, error: null, loadedAt: now };
}

/**
 * A failed load. A refresh of the same path keeps the last good result, so a page polling in the background does not
 * replace itself (and any half-typed form) with an error screen. A first load or a new path has nothing to keep.
 */
export function failed<R, E>(prev: LoadState<R, E> | null, path: string, error: E): LoadState<R, E> {
  const keep = prev?.path === path && prev.result !== null;
  return { path, result: keep ? prev.result : null, error, loadedAt: keep ? prev.loadedAt : null };
}
