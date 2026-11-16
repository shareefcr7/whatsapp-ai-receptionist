// H3 regression: a failed background refresh must not replace the conversation page (and its unsent draft).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { failed, loaded } from '../src/lib/apiState.ts';
import type { LoadState } from '../src/lib/apiState.ts';
import { errorDisplay } from '../src/lib/conversations.ts';

type S = LoadState<{ data: string }, { code: string; message: string }>;
const PATH = '/conversations/abc';
const blip = { code: 'NETWORK_ERROR', message: 'Cannot reach the API.' };

describe('refresh failures', () => {
  it('a failed refresh keeps the last good data and its time, so the page (and the draft) stays on screen', () => {
    const first: S = loaded(PATH, { data: 'thread v1' }, 1000);
    assert.equal(errorDisplay(first.result !== null, first.error), 'none');

    // Staff are typing; the 15-second poll fails.
    const afterBlip = failed(first, PATH, blip);
    assert.deepEqual(afterBlip.result, { data: 'thread v1' });
    assert.equal(afterBlip.loadedAt, 1000);
    assert.deepEqual(afterBlip.error, blip);
    assert.equal(errorDisplay(afterBlip.result !== null, afterBlip.error), 'warning'); // not 'full': nothing unmounts

    // Several failures in a row still keep it.
    const again = failed(afterBlip, PATH, { code: 'DATABASE_UNAVAILABLE', message: 'x' });
    assert.deepEqual(again.result, { data: 'thread v1' });
    assert.equal(again.loadedAt, 1000);

    // The next good poll clears the warning.
    const recovered = loaded<{ data: string }, typeof blip>(PATH, { data: 'thread v2' }, 2000);
    assert.equal(errorDisplay(recovered.result !== null, recovered.error), 'none');
  });

  it('a first load that never succeeded shows the full error', () => {
    const s = failed<{ data: string }, typeof blip>(null, PATH, blip);
    assert.equal(s.result, null);
    assert.equal(s.loadedAt, null);
    assert.equal(errorDisplay(s.result !== null, s.error), 'full');
  });

  it('data from another conversation is never kept for this one', () => {
    const other: S = loaded('/conversations/other', { data: 'someone else' }, 1000);
    const s = failed(other, PATH, blip);
    assert.equal(s.result, null);
    assert.equal(errorDisplay(s.result !== null, s.error), 'full');
  });
});
