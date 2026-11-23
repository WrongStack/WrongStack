// Fault-injection coverage for the session-registry lock primitives:
// 1. maybeUnlinkOwnedLock's bounded unlink retry — transient EPERM/EBUSY must
//    retry, persistent failure must swallow best-effort (lock survives), and a
//    foreign/empty stamp must never trigger an unlink.
// 2. atomicUpdate's stamp-failure branch — a rejecting owner-stamp writeFile
//    must fail closed (SessionRegistryWriteError) AND remove the ownerless
//    lock it created, so waiters are not degraded until the mtime cap.

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../../src/session-catalog/session-registry.js';
import {
  lockOwnerStamp,
  maybeUnlinkOwnedLock,
} from '../../src/session-catalog/session-registry-atomic-file.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (filePath: string, flags?: string) => actual.open(filePath, flags as string)),
    unlink: vi.fn(async (filePath: string) => actual.unlink(filePath)),
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) =>
      actual.readFile(...args),
    ),
  };
});

const EPERM = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sess-reg-fault-'));
  lockPath = path.join(dir, 'session-registry.json.lock');
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.mocked(fsp.open).mockReset();
  vi.mocked(fsp.unlink).mockReset();
  vi.mocked(fsp.readFile).mockReset();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('maybeUnlinkOwnedLock retry loop', () => {
  it('retries transient unlink failures and removes the lock', async () => {
    await fsp.writeFile(lockPath, lockOwnerStamp(), 'utf8');
    vi.mocked(fsp.unlink).mockRejectedValueOnce(EPERM).mockRejectedValueOnce(EPERM);

    await maybeUnlinkOwnedLock(lockPath);
    // Third attempt landed on the real unlink → the lock is gone.
    await expect(fsp.readFile(lockPath)).rejects.toThrow();
    expect(vi.mocked(fsp.unlink)).toHaveBeenCalledTimes(3);
  });

  it('swallows persistent unlink failure best-effort, leaving the lock', async () => {
    await fsp.writeFile(lockPath, lockOwnerStamp(), 'utf8');
    vi.mocked(fsp.unlink).mockRejectedValue(EPERM);

    await expect(maybeUnlinkOwnedLock(lockPath)).resolves.toBeUndefined();
    // All three attempts exhausted; the lock survives for the stale breaker.
    expect(vi.mocked(fsp.unlink)).toHaveBeenCalledTimes(3);
    await expect(fsp.readFile(lockPath, 'utf8')).resolves.toBe(lockOwnerStamp());
  });

  it('never unlinks a lock that no longer carries our stamp', async () => {
    const foreign = os.hostname() === 'host-a' ? 'host-b' : 'host-a';
    await fsp.writeFile(lockPath, `${foreign}:${process.pid}`, 'utf8');

    await maybeUnlinkOwnedLock(lockPath);
    expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalled();
    await expect(fsp.readFile(lockPath, 'utf8')).resolves.toBe(`${foreign}:${process.pid}`);
  });
});

describe('atomicUpdate stamp-failure branch', () => {
  it('fails closed and removes the ownerless lock when the stamp cannot be written', async () => {
    const reg = new SessionRegistry(dir);
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    // Every 'wx' lock open returns a handle whose stamp writeFile rejects.
    // Signature mirrors `fsp.open`'s (PathLike, string | number, Mode) overload
    // — narrowing it to `string` no longer matches the mocked type.
    vi.mocked(fsp.open).mockImplementation((async (
      filePath: Parameters<typeof fsp.open>[0],
      flags?: Parameters<typeof fsp.open>[1],
    ) => {
      if (flags === 'wx') {
        const handle = await real.open(filePath, flags);
        const fake = Object.create(handle) as typeof handle;
        fake.writeFile = vi.fn().mockRejectedValue(EPERM);
        // The prototype wrapper's inherited close() does not close the REAL
        // handle's fd (Node FileHandle internals do not survive Object.create),
        // so the fd leaked and GC later reported ERR_INVALID_STATE. Delegate
        // close to the real handle — the mock's intent is only a rejecting
        // stamp writeFile, not an leaked descriptor.
        fake.close = () => handle.close();
        return fake;
      }
      return real.open(filePath, flags as string);
    }) as typeof fsp.open);

    await expect(
      reg.register({
        sessionId: 'sess-stamp-fail',
        projectSlug: 'ws',
        projectRoot: '/ws',
        projectName: 'WS',
        workingDir: '/ws',
        clientType: 'tui',
        pid: 6002,
        startedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/ownership update failed/i);

    // The ownerless lock created by the failed acquisition is removed.
    await expect(fsp.readFile(lockPath)).rejects.toThrow();
  });
});

describe('SessionRegistry same-pid ownership', () => {
  it('keeps sibling sessions owned by the same WebUI process', async () => {
    const reg = new SessionRegistry(dir);
    const startedAt = new Date().toISOString();

    await reg.register({
      sessionId: 'sess-tab-a',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      clientType: 'webui',
      pid: process.pid,
      startedAt,
    });
    await reg.register({
      sessionId: 'sess-tab-b',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      clientType: 'webui',
      pid: process.pid,
      startedAt: new Date(Date.parse(startedAt) + 1).toISOString(),
    });

    const ids = (await reg.list()).map((entry) => entry.sessionId).sort();
    expect(ids).toEqual(['sess-tab-a', 'sess-tab-b']);

    await reg.unregister();
  });
});

describe('atomicUpdate registry read failures', () => {
  const entry = (sessionId: string, pid: number) => ({
    sessionId,
    projectSlug: 'ws',
    projectRoot: '/ws',
    projectName: 'WS',
    workingDir: '/ws',
    pid,
    startedAt: new Date().toISOString(),
  });

  it('never erases other live sessions while the registry is unreadable', async () => {
    // An unreadable registry used to read as `{}`; the update was written back
    // and every other live claim vanished, so a second process could open a
    // session that its running owner was still writing.
    const owner = new SessionRegistry(dir, { ownershipLockWaitMs: 2_000 });
    await owner.register(entry('sess-live', process.pid));
    const registryPath = path.join(dir, 'session-registry.json');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fsp.readFile).mockImplementation((async (
      file: Parameters<typeof actual.readFile>[0],
      ...rest: unknown[]
    ) => {
      if (String(file) === registryPath) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as never);

    await expect(
      new SessionRegistry(dir, { ownershipLockWaitMs: 2_000 }).register(
        entry('sess-other', process.pid),
      ),
    ).rejects.toThrow('ownership update failed');

    vi.mocked(fsp.readFile).mockImplementation(actual.readFile as never);
    await expect(
      new SessionRegistry(dir, { ownershipLockWaitMs: 2_000 }).register(
        entry('sess-live', process.ppid),
      ),
    ).rejects.toThrow('already open');
    await owner.unregister();
  });
});
