import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isFsError } from '../../src/types/errors.js';
import { atomicWrite, ensureDir, withFileLock } from '../../src/utils/atomic-write.js';

describe('atomicWrite', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-aw-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a new file', async () => {
    const file = path.join(dir, 'a.txt');
    await atomicWrite(file, 'hello');
    expect(await fs.readFile(file, 'utf8')).toBe('hello');
  });

  it('overwrites existing file', async () => {
    const file = path.join(dir, 'b.txt');
    await fs.writeFile(file, 'old');
    await atomicWrite(file, 'new');
    expect(await fs.readFile(file, 'utf8')).toBe('new');
  });

  it('leaves no orphan tmp file on success', async () => {
    const file = path.join(dir, 'c.txt');
    await atomicWrite(file, 'x');
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('creates parent directories', async () => {
    const file = path.join(dir, 'nested', 'deep', 'd.txt');
    await atomicWrite(file, 'ok');
    expect(await fs.readFile(file, 'utf8')).toBe('ok');
  });

  it('accepts a Uint8Array body and preserves bytes', async () => {
    const file = path.join(dir, 'bin.dat');
    const buf = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    await atomicWrite(file, buf);
    const onDisk = await fs.readFile(file);
    expect(Array.from(onDisk)).toEqual(Array.from(buf));
  });

  it('preserves target file mode when overwriting', async () => {
    if (process.platform === 'win32') return; // Windows has limited mode semantics
    const file = path.join(dir, 'modes.txt');
    await fs.writeFile(file, 'old', { mode: 0o644 });
    await fs.chmod(file, 0o600);
    await atomicWrite(file, 'new');
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('uses a custom encoding when provided', async () => {
    const file = path.join(dir, 'enc.txt');
    await atomicWrite(file, 'héllo', { encoding: 'utf8' });
    expect(await fs.readFile(file, 'utf8')).toBe('héllo');
  });

  it('survives a transient handle-lock on the destination (Windows)', async () => {
    if (process.platform !== 'win32') return;
    const file = path.join(dir, 'locked.txt');
    await fs.writeFile(file, 'old');
    // Open an exclusive handle on the destination; release it after ~80ms so
    // the first rename attempt fails with EPERM and a retry can succeed.
    const fh = await fs.open(file, 'r+');
    const releaser = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await fh.close();
        resolve();
      }, 80);
    });
    await Promise.all([atomicWrite(file, 'new'), releaser]);
    expect(await fs.readFile(file, 'utf8')).toBe('new');
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('rethrows the error and cleans up the tmp file when writeFile fails', async () => {
    const file = path.join(dir, 'failed.txt');
    // Pre-create the target as a directory — fs.rename onto an existing dir
    // fails on POSIX, exercising the catch + tmp-cleanup branch.
    await fs.mkdir(file, { recursive: true });
    await expect(atomicWrite(file, 'wat')).rejects.toBeTruthy();
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });
});

describe('ensureDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-ed-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a missing directory', async () => {
    const target = path.join(dir, 'a', 'b', 'c');
    await ensureDir(target);
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent', async () => {
    const target = path.join(dir, 'existing');
    await fs.mkdir(target);
    await expect(ensureDir(target)).resolves.toBeUndefined();
  });
});

describe('withFileLock — structured FsError on timeout', () => {
  let lockDir: string;
  beforeEach(async () => {
    lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-awlock-'));
  });
  afterEach(async () => {
    await fs.rm(lockDir, { recursive: true, force: true });
  });

  it('creates a missing parent directory before entering the critical section', async () => {
    const target = path.join(lockDir, 'nested', 'deep', 'locked.json');
    await withFileLock(target, async () => {
      await fs.writeFile(target, 'protected');
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('protected');
  });

  it('throws FsError(FS_ATOMIC_WRITE_FAILED) when the lock cannot be acquired', async () => {
    const target = path.join(lockDir, 'locked.json');
    // Hold the lock in this caller's own process by holding a write handle
    // to the lock file path. The `wx` open used by withFileLock will fail
    // with EEXIST and the stale-lock branch will not free it (mtime is
    // fresh), so the timeout fires.
    const lockPath = path.join(lockDir, '.locked.json.lock');
    const blocker = await fs.open(lockPath, 'w');
    try {
      let caught: unknown;
      try {
        await withFileLock(target, async () => 'should not run', {
          timeoutMs: 50,
          staleMs: 60_000,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isFsError(caught)).toBe(true);
      const fe = caught as ReturnType<typeof isFsError> & {
        code: string;
        path?: string;
        context?: Record<string, unknown>;
      };
      expect(fe.code).toBe('FS_ATOMIC_WRITE_FAILED');
      expect(fe.path).toBe(target);
      expect(fe.context?.timeoutMs).toBe(50);
    } finally {
      await blocker.close();
    }
  });
});
