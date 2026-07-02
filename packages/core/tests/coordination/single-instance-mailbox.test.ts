import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAILBOX_BRIDGE_LOCK_FILENAME,
  MAILBOX_BRIDGE_TOKEN_FILENAME,
  acquireOrJoin,
  finalize,
  readLiveLock,
  release,
  type MailboxBridgeLock,
} from '../../src/coordination/single-instance-mailbox.js';

// ── Mocks ────────────────────────────────────────────────────────────────
// `os.platform()` is mocked so we can drive BOTH the win32 (tasklist) and
// POSIX (process.kill) branches of isProcessAlive deterministically from one
// test file. `node:child_process.execFileSync` is mocked so the win32 branch
// never spawns a real `tasklist`. fetch is stubbed for probeHealthz.

const { platformRef, tasklist } = vi.hoisted(() => ({
  // '' falls back to the real platform; tests set 'win32' / 'linux'.
  platformRef: { value: '' as string },
  tasklist: { alivePids: new Set<number>(), shouldThrow: false },
}));

vi.mock('node:os', async (orig) => {
  const actual = (await orig()) as typeof import('node:os');
  return { ...actual, platform: () => platformRef.value || actual.platform() };
});

vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as typeof import('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(((cmd: string, args: string[]) => {
      if (cmd !== 'tasklist') return (actual.execFileSync as never)(cmd, args);
      if (tasklist.shouldThrow) throw new Error('tasklist boom');
      const m = /PID eq (\d+)/.exec(args[1] ?? '');
      const pid = m ? Number(m[1]) : 0;
      return tasklist.alivePids.has(pid)
        ? `"proc","${pid}"\r\n`
        : 'INFO: No tasks are running which match the specified criteria.';
    }) as never),
  };
});

let tmp = '';
let killSpy: ReturnType<typeof vi.spyOn>;

async function writeLock(
  projectDir: string,
  over: Partial<MailboxBridgeLock> & { pid: number },
): Promise<MailboxBridgeLock> {
  const lock: MailboxBridgeLock = {
    pid: over.pid,
    host: over.host ?? '127.0.0.1',
    port: over.port ?? 0,
    url: over.url ?? 'http://127.0.0.1:0',
    token: over.token ?? 'tok',
    generation: over.generation ?? 1,
    spawnedAt: over.spawnedAt ?? '2026-01-01T00:00:00.000Z',
  };
  await fs.writeFile(path.join(projectDir, MAILBOX_BRIDGE_LOCK_FILENAME), JSON.stringify(lock));
  return lock;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'simailbox-'));
  platformRef.value = '';
  tasklist.alivePids = new Set();
  tasklist.shouldThrow = false;
  // Default: process.kill reports the pid as alive (no throw). POSIX tests
  // override per-call to drive the ESRCH/EPERM branches.
  killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true }) as Response),
  );
});

afterEach(async () => {
  killSpy.mockRestore();
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('acquireOrJoin', () => {
  it('acquires with generation 1 when no lock exists (OS-assigned port)', async () => {
    const res = await acquireOrJoin({
      projectDir: tmp,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(res.kind).toBe('acquired');
    if (res.kind !== 'acquired') return;
    expect(res.lock.pid).toBe(process.pid);
    expect(res.lock.port).toBe(0);
    expect(res.lock.url).toBe('');
    expect(res.lock.generation).toBe(1);
    expect(res.tokenPath).toBe(path.join(tmp, MAILBOX_BRIDGE_TOKEN_FILENAME));
    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME), 'utf-8'),
    ) as MailboxBridgeLock;
    expect(onDisk.token).toBe(res.lock.token);
  });

  it('acquires with a url when an explicit port is requested', async () => {
    const res = await acquireOrJoin({
      projectDir: tmp,
      host: '1.2.3.4',
      requestedPort: 8080,
      strictPort: false,
    });
    expect(res.kind).toBe('acquired');
    if (res.kind !== 'acquired') return;
    expect(res.lock.port).toBe(8080);
    expect(res.lock.url).toBe('http://1.2.3.4:8080');
  });

  it('joins a live owner on the same port', async () => {
    await writeLock(tmp, { pid: process.pid, port: 3000, url: 'http://127.0.0.1:3000' });
    const res = await acquireOrJoin({
      projectDir: tmp,
      host: '127.0.0.1',
      requestedPort: 3000,
      strictPort: false,
    });
    expect(res.kind).toBe('joined');
    if (res.kind !== 'joined') return;
    expect(res.lock.port).toBe(3000);
  });

  it('joins a live owner when no explicit port is requested', async () => {
    await writeLock(tmp, { pid: process.pid, port: 3000, url: 'http://127.0.0.1:3000' });
    const res = await acquireOrJoin({
      projectDir: tmp,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(res.kind).toBe('joined');
  });

  it('reports a port-conflict when a live owner holds a different explicit port', async () => {
    await writeLock(tmp, { pid: process.pid, port: 3000, url: 'http://127.0.0.1:3000' });
    const res = await acquireOrJoin({
      projectDir: tmp,
      host: '127.0.0.1',
      requestedPort: 4000,
      strictPort: false,
    });
    expect(res.kind).toBe('port-conflict');
    if (res.kind !== 'port-conflict') return;
    expect(res.existing.port).toBe(3000);
  });

  it('treats a stale-pid lock as reclaimable and bumps the generation', async () => {
    // Dead pid: on POSIX process.kill throws ESRCH; on win32 tasklist no-match.
    killSpy.mockImplementationOnce((() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as never);
    await writeLock(tmp, { pid: 424242, generation: 7, port: 5000 });
    const res = await acquireOrJoin({
      projectDir: tmp,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(res.kind).toBe('acquired');
    if (res.kind !== 'acquired') return;
    expect(res.lock.generation).toBe(8);
    // Stale lock was unlinked before the new tentative write.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME), 'utf-8'),
    ) as MailboxBridgeLock;
    expect(onDisk.generation).toBe(8);
  });

  it('treats an alive-pid owner whose /healthz is unreachable as stale', async () => {
    await writeLock(tmp, { pid: process.pid, port: 6000, url: 'http://127.0.0.1:6000' });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => ({ ok: false }) as Response,
    );
    const res = await acquireOrJoin({
      projectDir: tmp,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(res.kind).toBe('acquired');
  });

  it('treats an alive owner with an empty url as stale (probe short-circuits)', async () => {
    // pid alive (process.pid) but url '' → probeHealthz returns false without fetch.
    await writeLock(tmp, { pid: process.pid, port: 0, url: '' });
    const res = await acquireOrJoin({
      projectDir: tmp,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(res.kind).toBe('acquired');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects when the lock path is occupied by a directory (rename fails)', async () => {
    await fs.mkdir(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME));
    await expect(
      acquireOrJoin({ projectDir: tmp, host: '127.0.0.1', requestedPort: null, strictPort: false }),
    ).rejects.toThrow();
  });
});

describe('finalize', () => {
  it('writes the final lock with the bound port + the token file', async () => {
    const tentative: MailboxBridgeLock = {
      pid: process.pid,
      host: '127.0.0.1',
      port: 0,
      url: '',
      token: 'abc',
      generation: 3,
      spawnedAt: '2026-01-01T00:00:00.000Z',
    };
    const finalized = await finalize(tmp, tentative, 9999);
    expect(finalized.port).toBe(9999);
    expect(finalized.url).toBe('http://127.0.0.1:9999');
    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME), 'utf-8'),
    ) as MailboxBridgeLock;
    expect(onDisk.url).toBe('http://127.0.0.1:9999');
    const token = await fs.readFile(path.join(tmp, MAILBOX_BRIDGE_TOKEN_FILENAME), 'utf-8');
    expect(token).toBe('abc');
  });
});

describe('release', () => {
  it('removes both files when generation + pid match', async () => {
    await writeLock(tmp, { pid: process.pid, generation: 1 });
    await fs.writeFile(path.join(tmp, MAILBOX_BRIDGE_TOKEN_FILENAME), 'tok');
    await release(tmp, 1);
    await expect(
      fs.readFile(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      fs.readFile(path.join(tmp, MAILBOX_BRIDGE_TOKEN_FILENAME), 'utf-8'),
    ).rejects.toThrow();
  });

  it('keeps the files when the generation does not match (not ours)', async () => {
    await writeLock(tmp, { pid: process.pid, generation: 2 });
    await release(tmp, 1);
    await expect(
      fs.readFile(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME), 'utf-8'),
    ).resolves.toBeTruthy();
  });

  it('keeps the files when the pid does not match (not ours)', async () => {
    await writeLock(tmp, { pid: 999999, generation: 1 });
    await release(tmp, 1);
    await expect(
      fs.readFile(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME), 'utf-8'),
    ).resolves.toBeTruthy();
  });

  it('still removes the lock when the token file is already gone (best-effort)', async () => {
    // No token file written → the token unlink rejects ENOENT, which the
    // best-effort .catch must swallow so the lock cleanup completes.
    await writeLock(tmp, { pid: process.pid, generation: 1 });
    await release(tmp, 1);
    await expect(
      fs.readFile(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME), 'utf-8'),
    ).rejects.toThrow();
  });

  it('is a no-op when no lock file exists', async () => {
    await expect(release(tmp, 1)).resolves.toBeUndefined();
  });
});

describe('readLiveLock', () => {
  it('returns live when the owner pid is alive and /healthz is reachable', async () => {
    await writeLock(tmp, { pid: process.pid, port: 7000, url: 'http://127.0.0.1:7000' });
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('live');
  });

  it('returns probe-failed with pidAlive=true when the owner pid is alive but /healthz is unreachable', async () => {
    await writeLock(tmp, { pid: process.pid, port: 7000, url: 'http://127.0.0.1:7000' });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => ({ ok: false }) as Response,
    );
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('probe-failed');
    // Live PID, dead /healthz → pidAlive stays true so callers don't
    // race a second spawn against a still-running owner.
    if (res.kind === 'probe-failed') expect(res.pidAlive).toBe(true);
  });

  it('returns probe-failed when the healthz fetch itself throws', async () => {
    await writeLock(tmp, { pid: process.pid, port: 7000, url: 'http://127.0.0.1:7000' });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('network down');
    });
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('probe-failed');
  });

  it('returns absent when no lock file exists', async () => {
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('absent');
  });

  it('returns absent + unlinks a malformed lock file', async () => {
    await fs.writeFile(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME), '{ not json');
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('absent');
    await expect(
      fs.readFile(path.join(tmp, MAILBOX_BRIDGE_LOCK_FILENAME), 'utf-8'),
    ).rejects.toThrow();
  });

  it('treats a lock with an invalid (zero) pid as stale', async () => {
    await writeLock(tmp, { pid: 0, port: 8000, url: 'http://127.0.0.1:8000' });
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('probe-failed');
  });
});

describe('isProcessAlive (win32 tasklist branch)', () => {
  beforeEach(() => {
    platformRef.value = 'win32';
  });

  it('reports a tasklisted pid as alive', async () => {
    tasklist.alivePids = new Set([9999]);
    await writeLock(tmp, { pid: 9999, port: 8000, url: 'http://127.0.0.1:8000' });
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('live');
  });

  it('reports a pid absent from tasklist as stale (pidAlive=false)', async () => {
    await writeLock(tmp, { pid: 8888, port: 8000, url: 'http://127.0.0.1:8000' });
    const res = await readLiveLock(tmp);
    // dead pid → stale → readLiveLock surfaces probe-failed with
    // pidAlive=false so bootstrap callers know to spawn a fresh bridge.
    expect(res.kind).toBe('probe-failed');
    if (res.kind === 'probe-failed') expect(res.pidAlive).toBe(false);
  });

  it('reports stale when tasklist itself throws', async () => {
    tasklist.shouldThrow = true;
    await writeLock(tmp, { pid: 7777, port: 8000, url: 'http://127.0.0.1:8000' });
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('probe-failed');
  });
});

describe('isProcessAlive (POSIX process.kill branch)', () => {
  beforeEach(() => {
    platformRef.value = 'linux';
  });

  it('reports a pid that process.kill(0) permits as alive', async () => {
    killSpy.mockImplementation((() => true) as never);
    await writeLock(tmp, { pid: 12345, port: 8000, url: 'http://127.0.0.1:8000' });
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('live');
  });

  it('reports a pid that returns EPERM as alive (we lack permission to signal)', async () => {
    killSpy.mockImplementation((() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }) as never);
    await writeLock(tmp, { pid: 12346, port: 8000, url: 'http://127.0.0.1:8000' });
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('live');
  });

  it('reports a pid that process.kill rejects as stale', async () => {
    killSpy.mockImplementation((() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as never);
    await writeLock(tmp, { pid: 12347, port: 8000, url: 'http://127.0.0.1:8000' });
    const res = await readLiveLock(tmp);
    expect(res.kind).toBe('probe-failed');
  });
});
