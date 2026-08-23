import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  breakStaleLock,
  lockOwnerStamp,
  maybeUnlinkOwnedLock,
} from '../../src/session-catalog/session-registry-atomic-file.js';

describe('session-registry advisory lock primitives', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sess-reg-lock-'));
    lockPath = path.join(dir, 'session-registry.json.lock');
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function backdate(msAgo: number): Promise<void> {
    const past = new Date(Date.now() - msAgo);
    await fsp.utimes(lockPath, past, past);
  }

  it('stamps locks with the machine name and pid', () => {
    expect(lockOwnerStamp()).toBe(`${os.hostname()}:${process.pid}`);
  });

  it('only unlinks a lock that still carries our own stamp', async () => {
    // Our stamp → removed.
    await fsp.writeFile(lockPath, lockOwnerStamp(), 'utf8');
    await maybeUnlinkOwnedLock(lockPath);
    await expect(fsp.readFile(lockPath)).rejects.toThrow();

    // A foreign host:pid (or a re-stamped lock) → untouched.
    const foreign = os.hostname() === 'host-a' ? 'host-b' : 'host-a';
    await fsp.writeFile(lockPath, `${foreign}:${process.pid}`, 'utf8');
    await maybeUnlinkOwnedLock(lockPath);
    expect(await fsp.readFile(lockPath, 'utf8')).toBe(`${foreign}:${process.pid}`);

    // An empty lock (new owner in its open-to-stamp gap) → untouched.
    await fsp.writeFile(lockPath, '', 'utf8');
    await maybeUnlinkOwnedLock(lockPath);
    expect(await fsp.readFile(lockPath, 'utf8')).toBe('');
  });

  it('does not throw when the lock is already gone', async () => {
    await expect(maybeUnlinkOwnedLock(lockPath)).resolves.toBeUndefined();
  });

  it('breaks a same-host lock whose owner pid is dead', async () => {
    await fsp.writeFile(lockPath, `${os.hostname()}:999999999`, 'utf8');
    expect(await breakStaleLock(lockPath)).toBe(true);
    await expect(fsp.readFile(lockPath)).rejects.toThrow();
  });

  it('keeps a same-host lock whose owner is alive, even with an old mtime', async () => {
    await fsp.writeFile(lockPath, `${os.hostname()}:${process.pid}`, 'utf8');
    // Backdate beyond the foreign lease cap (10s) but below the same-host
    // wedged-holder cap (20s): only the live-owner check can protect this lock.
    await backdate(11_000);
    expect(await breakStaleLock(lockPath)).toBe(false);
  });

  it('breaks a same-host lock held implausibly long by a live owner', async () => {
    await fsp.writeFile(lockPath, `${os.hostname()}:${process.pid}`, 'utf8');
    // Past the same-host wedged-holder cap (2× the 10s lease).
    await backdate(21_000);
    expect(await breakStaleLock(lockPath)).toBe(true);
  });

  it('breaks a legacy bare-pid lock whose pid is dead', async () => {
    await fsp.writeFile(lockPath, '999999999', 'utf8');
    expect(await breakStaleLock(lockPath)).toBe(true);
  });

  it('keeps a legacy bare-pid lock whose pid is alive until the lease cap', async () => {
    await fsp.writeFile(lockPath, String(process.pid), 'utf8');
    expect(await breakStaleLock(lockPath)).toBe(false);
    await backdate(11_000);
    expect(await breakStaleLock(lockPath)).toBe(true);
  });

  it('treats a foreign-host lock as a lease: fresh kept, old broken', async () => {
    const foreign = os.hostname() === 'host-a' ? 'host-b' : 'host-a';
    await fsp.writeFile(lockPath, `${foreign}:12345`, 'utf8');
    expect(await breakStaleLock(lockPath)).toBe(false);
    await backdate(11_000);
    expect(await breakStaleLock(lockPath)).toBe(true);
  });

  it('breaks an ownerless lock older than the lease cap', async () => {
    await fsp.writeFile(lockPath, '', 'utf8');
    expect(await breakStaleLock(lockPath)).toBe(false);
    await backdate(11_000);
    expect(await breakStaleLock(lockPath)).toBe(true);
  });

  it('prunes stale temp files when there are fewer than MAX_STALE_TMP_FILES', async () => {
    const registryPath = path.join(dir, 'session-registry.json');
    const tmp1 = path.join(dir, 'session-registry.json.1.tmp');
    const tmp2 = path.join(dir, 'session-registry.json.2.tmp');
    await fsp.writeFile(tmp1, 'tmp1');
    await fsp.writeFile(tmp2, 'tmp2');
    const old = new Date(Date.now() - 70_000);
    await fsp.utimes(tmp1, old, old);
    await fsp.utimes(tmp2, old, old);

    const { pruneStaleTempFiles } = await import(
      '../../src/session-catalog/session-registry-atomic-file.js'
    );
    await pruneStaleTempFiles(registryPath);

    const remaining = await fsp.readdir(dir);
    expect(remaining.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
