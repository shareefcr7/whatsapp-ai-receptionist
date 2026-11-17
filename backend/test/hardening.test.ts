// Step 10.11 hardening: migration lock handling (against a fake connection: no database, no network) and the scrypt
// concurrency limit. Nothing here connects to PostgreSQL or calls Meta or OpenAI.
import assert from 'node:assert/strict';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// No DATABASE_URL: the real pool is null, so anything not given the fake would throw instead of connecting.
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: '' });

const { migrate, LOCK_ID, LOCK_WAIT } = await import('../src/database/migrate.ts');
const { hashPassword, verifyPassword, withHashSlot, MAX_CONCURRENT_HASHES } = await import('../src/services/auth/index.ts');

const MIGRATION_FILES = (await readdir(join(import.meta.dirname, '../../database/migrations'))).filter((f) => f.endsWith('.sql')).sort();

/** A fake pg connection: records every query; `fail` decides which ones reject. */
function fakeDb(fail: (sql: string) => unknown = () => undefined, connectError?: Error) {
  const queries: string[] = [];
  const released: boolean[] = []; // the `destroy` argument of each release()
  let connects = 0;
  const client = {
    async query(sql: string) {
      queries.push(sql.trim());
      const err = fail(sql.trim());
      if (err) throw err;
      return { rows: [] };
    },
    release(destroy?: boolean) {
      released.push(Boolean(destroy));
    },
  };
  const db = {
    async connect() {
      connects++;
      if (connectError) throw connectError;
      return client;
    },
  } as unknown as Parameters<typeof migrate>[0];
  return { db, queries, released, connects: () => connects };
}

const LOCK = 'SELECT pg_advisory_lock($1)';
const UNLOCK = 'SELECT pg_advisory_unlock($1)';
const RESETS = ['RESET statement_timeout', 'RESET lock_timeout'];
const lockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

describe('migration lock (fake connection)', () => {
  it('acquires the lock with a bounded wait, applies pending files, unlocks, resets and returns the connection', async () => {
    const f = fakeDb();
    const applied = await migrate(f.db);

    assert.deepEqual(applied, MIGRATION_FILES);
    assert.equal(f.connects(), 1);
    assert.deepEqual(f.queries.slice(0, 4), ['SET statement_timeout = 0', "SET lock_timeout = '10s'", LOCK, 'SET lock_timeout = 0']);
    // Migrations run without a lock timeout: the 10s bound is only for waiting on the lock.
    assert.ok(f.queries.indexOf('SET lock_timeout = 0') < f.queries.indexOf('BEGIN'));
    assert.equal(f.queries.filter((q) => q === 'COMMIT').length, MIGRATION_FILES.length);
    assert.deepEqual(f.queries.slice(-3), [UNLOCK, ...RESETS]);
    assert.deepEqual(f.released, [false], 'released once, back to the pool');
  });

  it('waits at most 10 seconds for the lock', () => {
    assert.equal(LOCK_WAIT, '10s');
    assert.equal(LOCK_ID, 727274);
  });

  it('a lock timeout (55P03) gives the actionable error, changes nothing and does not unlock a lock it never held', async () => {
    const f = fakeDb((sql) => (sql === LOCK ? lockTimeout() : undefined));
    await assert.rejects(migrate(f.db), (err: Error) => {
      assert.match(err.message, /^Could not start migrations: another migration run has held the migration lock for over 10s\. Nothing was changed\./);
      assert.match(err.message, /objid = 727274/);
      assert.equal((err.cause as { code: string }).code, '55P03');
      return true;
    });
    assert.ok(!f.queries.includes(UNLOCK));
    assert.ok(!f.queries.some((q) => q === 'BEGIN' || q.startsWith('CREATE TABLE')));
    assert.deepEqual(f.queries.slice(-2), RESETS);
    assert.deepEqual(f.released, [false]);
  });

  it('any other lock error is rethrown unchanged, without an unlock', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const f = fakeDb((sql) => (sql === LOCK ? boom : undefined));
    await assert.rejects(migrate(f.db), (err) => err === boom);
    assert.ok(!f.queries.includes(UNLOCK));
    assert.deepEqual(f.queries.slice(-2), RESETS);
    assert.deepEqual(f.released, [false]);
  });

  it('an error before the lock (setting statement_timeout) still cleans up, without an unlock', async () => {
    const f = fakeDb((sql) => (sql === 'SET statement_timeout = 0' ? new Error('bad') : undefined));
    await assert.rejects(migrate(f.db), /bad/);
    assert.ok(!f.queries.includes(LOCK) && !f.queries.includes(UNLOCK));
    assert.deepEqual(f.queries.slice(-2), RESETS);
    assert.deepEqual(f.released, [false]);
  });

  it('a failed migration rolls back, then unlocks, resets and releases once', async () => {
    const first = MIGRATION_FILES[0]!;
    let seenBegin = false;
    const f = fakeDb((sql) => {
      if (sql === 'BEGIN') seenBegin = true;
      else if (seenBegin && sql !== 'ROLLBACK' && !sql.startsWith('SELECT') && !sql.startsWith('RESET')) return new Error('syntax error');
    });
    await assert.rejects(migrate(f.db), (err: Error) => err.message === `Migration ${first} failed: syntax error`);
    assert.ok(f.queries.includes('ROLLBACK'));
    assert.ok(!f.queries.includes('COMMIT'));
    assert.deepEqual(f.queries.slice(-3), [UNLOCK, ...RESETS]);
    assert.deepEqual(f.released, [false]);
  });

  it('destroys the connection instead of pooling it when the unlock or a reset fails', async () => {
    for (const failing of [UNLOCK, ...RESETS]) {
      const f = fakeDb((sql) => (sql === failing ? new Error('gone') : undefined));
      await migrate(f.db); // cleanup errors do not mask the result
      assert.deepEqual(f.queries.slice(-3), [UNLOCK, ...RESETS], `all cleanup steps still attempted when ${failing} fails`);
      assert.deepEqual(f.released, [true], `${failing} failing destroys the connection`);
    }
  });

  it('a failed connect rejects without querying or releasing anything', async () => {
    const f = fakeDb(undefined, new Error('ECONNREFUSED'));
    await assert.rejects(migrate(f.db), /ECONNREFUSED/);
    assert.deepEqual(f.queries, []);
    assert.deepEqual(f.released, []);
  });
});

describe('scrypt concurrency limit', () => {
  it('never runs more than two hash slots at once', async () => {
    assert.equal(MAX_CONCURRENT_HASHES, 2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };
    await Promise.all(Array.from({ length: 8 }, () => withHashSlot(task)));
    assert.equal(peak, 2);
    assert.equal(active, 0);
  });

  it('hashPassword and verifyPassword wait for a free slot', async () => {
    const releases: (() => void)[] = [];
    const holders = Array.from({ length: 2 }, () => withHashSlot(() => new Promise<void>((r) => releases.push(r))));
    let hashed = false;
    let verified = false;
    const stored = 'scrypt$1024$8$1$' + Buffer.alloc(16).toString('base64url') + '$' + Buffer.alloc(64).toString('base64url');
    const pending = [hashPassword('pw').then(() => (hashed = true)), verifyPassword('pw', stored).then(() => (verified = true))];
    await new Promise((r) => setTimeout(r, 1_000)); // far longer than a hash takes
    assert.equal(hashed, false, 'hash waits while both slots are taken');
    assert.equal(verified, false, 'verify waits while both slots are taken');
    releases.forEach((r) => r());
    await Promise.all([...holders, ...pending]);
    assert.ok(hashed && verified);
  });
});

describe('password hashing is unchanged', () => {
  it('stores scrypt N=2^17, r=8, p=1 with a 16-byte salt and a 64-byte key', async () => {
    const stored = await hashPassword('correct horse battery staple');
    const [scheme, N, r, p, salt, key] = stored.split('$');
    assert.deepEqual([scheme, N, r, p], ['scrypt', '131072', '8', '1']);
    assert.equal(Buffer.from(salt!, 'base64url').length, 16);
    assert.equal(Buffer.from(key!, 'base64url').length, 64);
    // Independent recomputation with the same settings.
    const expected = scryptSync('correct horse battery staple', Buffer.from(salt!, 'base64url'), 64, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 2 ** 17 * 8 });
    assert.ok(timingSafeEqual(expected, Buffer.from(key!, 'base64url')));
  });

  it('verifies the right password, rejects a wrong one and malformed hashes', async () => {
    const stored = await hashPassword('s3cret-pass');
    assert.equal(await verifyPassword('s3cret-pass', stored), true);
    assert.equal(await verifyPassword('wrong-pass', stored), false);
    for (const bad of ['', 'bcrypt$1$2$3$4$5', 'scrypt$131072$8$1$salt', stored.replace(/^scrypt/, 'md5')]) {
      assert.equal(await verifyPassword('s3cret-pass', bad), false);
    }
  });

  it('still verifies hashes stored with other cost settings', async () => {
    const salt = Buffer.from('0123456789abcdef');
    const key = scryptSync('old-password', salt, 64, { N: 2 ** 14, r: 8, p: 1, maxmem: 256 * 2 ** 14 * 8 });
    const stored = `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
    assert.equal(await verifyPassword('old-password', stored), true);
    assert.equal(await verifyPassword('other', stored), false);
  });
});
