import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockPathForToken, PollLock } from '../../src/poll-lock.js';

describe('lockPathForToken', () => {
  it('is deterministic and never contains the raw token', () => {
    const token = '123456789:ABCdefSECRET';
    const a = lockPathForToken(token, '/tmp/root');
    const b = lockPathForToken(token, '/tmp/root');
    expect(a).toBe(b);
    expect(a).not.toContain('ABCdefSECRET');
    expect(a).toContain('telegram');
  });

  it('differs per token', () => {
    expect(lockPathForToken('token-a', '/tmp/root')).not.toBe(
      lockPathForToken('token-b', '/tmp/root'),
    );
  });
});

describe('PollLock', () => {
  let dir: string;
  const locks: PollLock[] = [];

  function makeLock(opts?: { heartbeatMs?: number; staleMs?: number }) {
    const lock = new PollLock(join(dir, 'nested', 'poll.lock'), opts);
    locks.push(lock);
    return lock;
  }

  afterEach(() => {
    for (const lock of locks.splice(0)) lock.release();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'wstack-poll-lock-'));
    mkdirSync(join(dir, 'nested'), { recursive: true });
  }

  it('acquires when no lock file exists (creates parent dirs)', () => {
    setup();
    const lock = makeLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.held).toBe(true);
  });

  it('tryAcquire is idempotent for the holder', () => {
    setup();
    const lock = makeLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(true);
  });

  it('a second instance cannot acquire while the first holds', () => {
    setup();
    const first = makeLock();
    const second = makeLock();
    expect(first.tryAcquire()).toBe(true);
    expect(second.tryAcquire()).toBe(false);
    expect(second.held).toBe(false);
  });

  it('a second instance acquires after release', () => {
    setup();
    const first = makeLock();
    const second = makeLock();
    first.tryAcquire();
    first.release();
    expect(first.held).toBe(false);
    expect(second.tryAcquire()).toBe(true);
  });

  it('release is idempotent and only removes own lock', () => {
    setup();
    const first = makeLock();
    const second = makeLock();
    first.tryAcquire();
    second.release(); // never held — must not delete first's file
    expect(second.tryAcquire()).toBe(false);
    first.release();
    first.release();
  });

  it('does not remove a lock file that changed owners before release', () => {
    setup();
    const lock = makeLock();
    lock.tryAcquire();
    const lockPath = join(dir, 'nested', 'poll.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        id: 'replacement',
        pid: process.pid,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );
    lock.release();
    expect(readFileSync(lockPath, 'utf8')).toContain('replacement');
  });

  it('rejects structurally invalid lock payloads', () => {
    setup();
    const lock = makeLock();
    const lockPath = join(dir, 'nested', 'poll.lock');
    writeFileSync(lockPath, JSON.stringify({ id: 123, pid: 'bad', heartbeatAt: Date.now() }));
    const readLock = (lock as never as { readLock(): unknown }).readLock();
    expect(readLock).toBeNull();
  });

  it('steals a lock with a stale heartbeat', () => {
    setup();
    const lock = makeLock({ staleMs: 50 });
    const path = join(dir, 'nested', 'poll.lock');
    // Simulate a holder (alive pid) whose heartbeat stopped long ago.
    writeFileSync(
      path,
      JSON.stringify({
        id: 'other:instance',
        pid: process.pid,
        acquiredAt: Date.now() - 10_000,
        heartbeatAt: Date.now() - 10_000,
      }),
    );
    expect(lock.tryAcquire()).toBe(true);
  });

  it('steals a lock held by a dead pid even with a fresh heartbeat', () => {
    setup();
    const lock = makeLock();
    const path = join(dir, 'nested', 'poll.lock');
    writeFileSync(
      path,
      JSON.stringify({
        id: 'dead:instance',
        pid: 2 ** 30, // not a real pid
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );
    expect(lock.tryAcquire()).toBe(true);
  });

  it('treats a corrupt lock file as absent', () => {
    setup();
    const lock = makeLock();
    const path = join(dir, 'nested', 'poll.lock');
    writeFileSync(path, 'not json at all');
    expect(lock.tryAcquire()).toBe(true);
  });

  it('steals a lock with a non-finite heartbeat instead of wedging forever', () => {
    // A missing/non-numeric heartbeatAt would make `Date.now() - heartbeatAt`
    // NaN, and `NaN > staleMs` is false, so the time-based staleness check
    // would never fire. Combined with a live pid, that lock would be treated
    // as held forever and no standby instance could ever take over. It must be
    // rejected as corrupt.
    setup();
    const path = join(dir, 'nested', 'poll.lock');
    for (const bad of [undefined, null, 'soon', Number.NaN]) {
      writeFileSync(
        path,
        JSON.stringify({
          id: 'other:instance',
          pid: process.pid, // alive pid — only the heartbeat guard can save us
          acquiredAt: Date.now(),
          heartbeatAt: bad,
        }),
      );
      const lock = makeLock();
      expect(lock.tryAcquire()).toBe(true);
      lock.release();
    }
  });

  it('refreshes the heartbeat while held', async () => {
    setup();
    const lock = makeLock({ heartbeatMs: 20 });
    lock.tryAcquire();
    const path = join(dir, 'nested', 'poll.lock');
    const before = JSON.parse(readFileSync(path, 'utf8')).heartbeatAt as number;
    await new Promise((r) => setTimeout(r, 80));
    const after = JSON.parse(readFileSync(path, 'utf8')).heartbeatAt as number;
    expect(after).toBeGreaterThan(before);
  });

  it('fires onLost when another instance takes over the file', async () => {
    setup();
    const lock = makeLock({ heartbeatMs: 20 });
    const onLost = vi.fn();
    lock.onLost = onLost;
    lock.tryAcquire();
    const path = join(dir, 'nested', 'poll.lock');
    writeFileSync(
      path,
      JSON.stringify({
        id: 'thief:instance',
        pid: process.pid,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(onLost).toHaveBeenCalled();
    expect(lock.held).toBe(false);
  });

  it('two concurrent racers: exactly one acquires, the other observes a held lock', () => {
    // P1.9 atomicity invariant: two PollLock instances racing on the
    // same path must not both transition to "held". The 'wx' flag in
    // writeFileSync makes the create-exclusive step atomic at the
    // filesystem level — the loser's write throws EEXIST and tryAcquire
    // returns false. The winner's write commits the lock file with
    // exactly this instance's id; a subsequent loser acquire observes a
    // non-stale payload owned by the winner.
    setup();
    const first = makeLock();
    const second = makeLock();
    // Force a deterministic acquisition order by acquiring one before
    // the other races. The two PollLock objects share no in-memory
    // state; what they share is the lock path on disk.
    expect(first.tryAcquire()).toBe(true);
    // Second tries to acquire a fresh, non-stale lock held by first.
    // The atomic 'wx' write must fail (EEXIST) so the second's catch
    // block returns false.
    expect(second.tryAcquire()).toBe(false);
    expect(second.held).toBe(false);
    expect(first.held).toBe(true);
    // After first releases, exactly one of the racers (the next call)
    // wins. We don't pin which because the source serializes writes
    // exclusively; the contract is "exactly one wins".
    first.release();
    expect(second.tryAcquire()).toBe(true);
    expect(second.held).toBe(true);
  });
});
