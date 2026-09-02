import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecoveryLock } from '../../src/storage/recovery-lock.js';

// Covers the clock-skew / orphan branches of checkAbandoned, readLock error +
// malformed paths, clear() idempotency, write() EEXIST + non-EEXIST, and the
// default PID-liveness probe (no injected isPidAlive).

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-reclock-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const lockPath = () => path.join(dir, 'active.json');
const writeLock = (obj: unknown) => fs.writeFile(lockPath(), JSON.stringify(obj), 'utf8');

describe('recovery-lock — extra coverage', () => {
  it('treats a future/NaN timestamp as an orphan (returns null)', async () => {
    await writeLock({
      v: 1,
      sessionId: 's',
      pid: 1,
      hostname: os.hostname(),
      startedAt: '2999-01-01T00:00:00.000Z',
    });
    const lock = new RecoveryLock({ dir, isPidAlive: () => false });
    expect(await lock.checkAbandoned()).toBeNull();
  });

  it('returns null for a malformed (non-LockFile) JSON lock', async () => {
    await writeLock({ not: 'a lock' });
    const lock = new RecoveryLock({ dir, isPidAlive: () => false });
    expect(await lock.checkAbandoned()).toBeNull();
  });

  it('returns null when the lock JSON is a non-object', async () => {
    await fs.writeFile(lockPath(), '12345', 'utf8');
    const lock = new RecoveryLock({ dir, isPidAlive: () => false });
    expect(await lock.checkAbandoned()).toBeNull();
  });

  it('readLock returns null when the lock path is unreadable', async () => {
    await fs.mkdir(lockPath(), { recursive: true }); // active.json is a directory → readFile EISDIR
    const lock = new RecoveryLock({ dir, isPidAlive: () => false });
    expect(await lock.checkAbandoned()).toBeNull();
  });

  it('clear() is idempotent when the lock file is already gone', async () => {
    const lock = new RecoveryLock({ dir });
    await expect(lock.clear()).resolves.toBeUndefined();
  });

  it('write() throws "already held" on EEXIST and rethrows other errors', async () => {
    const lock = new RecoveryLock({ dir });
    await lock.write('s1');
    await expect(lock.write('s2')).rejects.toThrow(/already held/i);

    // Non-EEXIST: target is a directory → writeFile rejects with EISDIR.
    await fs.rm(lockPath(), { force: true });
    await fs.mkdir(lockPath(), { recursive: true });
    await expect(lock.write('s3')).rejects.toBeDefined();
  });

  it('default PID probe: non-positive pid is not alive (→ abandoned)', async () => {
    await writeLock({
      v: 1,
      sessionId: 's',
      pid: 0,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    });
    const lock = new RecoveryLock({ dir }); // no isPidAlive override → defaultIsPidAlive
    expect((await lock.checkAbandoned())?.sessionId).toBe('s');
  });

  it('default PID probe: a live pid (this process) is treated as still active (→ null)', async () => {
    await writeLock({
      v: 1,
      sessionId: 's',
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    });
    const lock = new RecoveryLock({ dir });
    expect(await lock.checkAbandoned()).toBeNull();
  });

  it('default PID probe: a dead pid is not alive (→ abandoned)', async () => {
    await writeLock({
      v: 1,
      sessionId: 's',
      pid: 2_147_483_646,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    });
    const lock = new RecoveryLock({ dir });
    expect((await lock.checkAbandoned())?.sessionId).toBe('s');
  });
});
