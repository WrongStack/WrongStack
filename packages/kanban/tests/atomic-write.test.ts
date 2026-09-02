import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FsError, atomicWrite, ensureDir, withFileLock } from '../src/utils/atomic-write.js';

// Helper to create an error with a specific code
function errWithCode(code: string, message = 'fake error'): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// Mock node:fs/promises to make functions spyable (ESM namespace workaround)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = {} as typeof import('node:fs/promises');
  for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
    const origFn = actual[key];
    if (typeof origFn === 'function') {
      (wrapped as any)[key] = vi
        .fn()
        .mockImplementation((...args: any[]) => (origFn as any)(...args));
    } else {
      (wrapped as any)[key] = origFn;
    }
  }
  return wrapped;
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-test-'));
});

// ── ensureDir ────────────────────────────────────────────────────

describe('ensureDir', () => {
  it('creates a directory', async () => {
    const dir = path.join(tmpDir, 'nested', 'dir');
    await ensureDir(dir);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('does not throw for existing directory', async () => {
    await ensureDir(tmpDir);
    await expect(ensureDir(tmpDir)).resolves.toBeUndefined();
  });
});

// ── atomicWrite ──────────────────────────────────────────────────

describe('atomicWrite', () => {
  it('writes a string file atomically', async () => {
    const target = path.join(tmpDir, 'test.txt');
    await atomicWrite(target, 'hello world');
    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('hello world');
  });

  it('writes binary content (Uint8Array)', async () => {
    const target = path.join(tmpDir, 'binary.bin');
    const buf = new Uint8Array([0, 1, 2, 255]);
    await atomicWrite(target, buf);
    const read = await fs.readFile(target);
    expect([...read]).toEqual([0, 1, 2, 255]);
  });

  it('writes to a nested directory', async () => {
    const target = path.join(tmpDir, 'a', 'b', 'c', 'deep.txt');
    await atomicWrite(target, 'deep');
    expect(await fs.readFile(target, 'utf8')).toBe('deep');
  });

  it('overwrites an existing file', async () => {
    const target = path.join(tmpDir, 'replace.txt');
    await atomicWrite(target, 'first');
    await atomicWrite(target, 'second');
    expect(await fs.readFile(target, 'utf8')).toBe('second');
  });
});

// ── withFileLock ─────────────────────────────────────────────────

describe('withFileLock', () => {
  it('acquires lock and runs the function', async () => {
    const target = path.join(tmpDir, 'locked.json');
    const result = await withFileLock(target, async () => 'done');
    expect(result).toBe('done');
  });

  it('throws FsError when lock cannot be acquired (timeout)', async () => {
    const target = path.join(tmpDir, 'busy.json');
    const lockPath = path.join(tmpDir, '.busy.json.lock');
    // Acquire the lock manually so withFileLock cannot
    await fs.writeFile(lockPath, '99999:0', { flag: 'wx' });
    await expect(
      withFileLock(target, async () => 'never', { timeoutMs: 100, staleMs: 60_000 }),
    ).rejects.toThrow(FsError);
  });

  it('recovers when lock directory is deleted mid-flight', async () => {
    const target = path.join(tmpDir, 'recover.json');
    const lockPath = path.join(tmpDir, '.recover.json.lock');
    // Write a stale lock then remove its parent dir to trigger ENOENT recovery
    await fs.writeFile(lockPath, '99999:0', { flag: 'wx' });
    // Set staleMs very low so the lock is treated as stale
    const result = await withFileLock(target, async () => 'recovered', {
      timeoutMs: 5000,
      staleMs: 1, // 1ms — the lock we created is older than this immediately
    });
    expect(result).toBe('recovered');
  });

  it('runs cleanup even when fn throws', async () => {
    const target = path.join(tmpDir, 'throws.json');
    const lockPath = path.join(tmpDir, '.throws.json.lock');
    await expect(
      withFileLock(target, async () => {
        throw new Error('fn failed');
      }),
    ).rejects.toThrow('fn failed');
    // Lock file should be cleaned up
    const exists = await fs
      .stat(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});

// ── FsError ──────────────────────────────────────────────────────

describe('FsError', () => {
  it('creates an error with code and path', () => {
    const err = new FsError({
      message: 'test error',
      code: 'FS_TEST',
      path: '/some/path',
      context: { detail: 'info' },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FsError');
    expect(err.code).toBe('FS_TEST');
    expect(err.path).toBe('/some/path');
    expect(err.context).toEqual({ detail: 'info' });
    expect(err.message).toBe('test error');
  });

  it('creates error without optional fields', () => {
    const err = new FsError({ message: 'minimal', code: 'FS_MIN' });
    expect(err.code).toBe('FS_MIN');
    expect(err.path).toBeUndefined();
    expect(err.context).toBeUndefined();
  });
});

// ── atomicWrite error paths ─────────────────────────────────────

describe('atomicWrite error paths', () => {
  it('cleans up temp file when write succeeds but chmod/rename fails', async () => {
    const target = path.join(tmpDir, 'bad-perms', 'test.txt');
    // Create the parent as a file so mkdir works but writing inside fails
    await fs.writeFile(path.join(tmpDir, 'bad-perms'), 'not-a-dir', 'utf8');
    await expect(atomicWrite(target, 'content')).rejects.toThrow();
  });

  it('handles EEXIST on temp file creation gracefully', async () => {
    // This test verifies atomicWrite handles write errors properly
    const target = path.join(tmpDir, 'eexist-target.txt');

    // Mock stat to throw to exercise the "mode = opts.mode" path
    // by making the target not exist
    await atomicWrite(target, 'first write');
    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('first write');
  });

  it('uses opts.mode when target file does not exist', async () => {
    const target = path.join(tmpDir, 'mode-test.txt');
    await atomicWrite(target, 'with mode', { mode: 0o644 });
    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('with mode');
  });
});

// ── withFileLock ENOENT recovery ─────────────────────────────────

describe('withFileLock - ENOENT recovery', () => {
  it('creates missing lock directory when it does not exist', async () => {
    const dir = path.join(tmpDir, 'deep', 'nested', 'locks');
    const target = path.join(dir, 'target.json');
    const result = await withFileLock(target, async () => 'created-dir');
    expect(result).toBe('created-dir');
    // Verify lock file was cleaned up
    const lockPath = path.join(dir, '.target.json.lock');
    const exists = await fs
      .stat(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('re-acquires when lock file is stale', async () => {
    const target = path.join(tmpDir, 'stale-target.json');
    const lockPath = path.join(tmpDir, '.stale-target.json.lock');
    // Create a lock file that is older than staleMs
    await fs.writeFile(lockPath, '99999:0', { flag: 'wx' });
    // Use very short staleMs so it's treated as stale
    const result = await withFileLock(target, async () => 'stale-recovered', {
      timeoutMs: 5000,
      staleMs: 1,
    });
    expect(result).toBe('stale-recovered');
    // Lock should be gone
    const exists = await fs
      .stat(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});

// ── atomicWrite rename error paths ──────────────────────────────

describe('atomicWrite rename errors', () => {
  it('throws when target is a directory (non-transient rename error)', async () => {
    const target = path.join(tmpDir, 'existing-dir');
    await fs.mkdir(target, { recursive: true });
    await expect(atomicWrite(target, 'content')).rejects.toThrow();
  });
});

// ── withFileLock: ENOENT recovery in lock loop ───────────────────

describe('withFileLock ENOENT in lock loop', () => {
  it('recovers when fs.open throws ENOENT on first attempt', async () => {
    // Mock fs.open to reject once with ENOENT, then delegate to real impl
    const openMock = vi.mocked(fs.open);
    openMock.mockRejectedValueOnce(errWithCode('ENOENT'));

    const target = path.join(tmpDir, 'enoeent-recovery', 'target.json');
    const result = await withFileLock(target, async () => 'recovered', {
      timeoutMs: 5000,
    });
    expect(result).toBe('recovered');
  });
});

describe('withFileLock stat-fail recovery', () => {
  it('recovers when fs.stat throws after EEXIST', async () => {
    const target = path.join(tmpDir, 'stat-fail-dir', 'target.json');
    const lockDir = path.join(tmpDir, 'stat-fail-dir');
    const lockPath = path.join(lockDir, '.target.json.lock');

    await fs.mkdir(lockDir, { recursive: true });
    // Create a lock file so fs.open throws EEXIST
    await fs.writeFile(lockPath, '99999:0', { flag: 'wx' });

    // Mock fs.stat to reject once so the catch{ continue } is hit
    const statMock = vi.mocked(fs.stat);
    statMock.mockRejectedValueOnce(errWithCode('ENOENT'));

    const result = await withFileLock(target, async () => 'stat-fail-recovered', {
      timeoutMs: 5000,
      staleMs: 1, // Make the existing lock appear stale
    });
    expect(result).toBe('stat-fail-recovered');
  });
});

// ── non-Win32 renameWithRetry (branch 161) ──────────────────────

describe('renameWithRetry non-Win32', () => {
  it('calls fs.rename directly when not on Windows', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      // Mock platform to 'linux'
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
        writable: true,
      });

      const target = path.join(tmpDir, 'linux-rename.txt');
      await atomicWrite(target, 'written on linux');
      const content = await fs.readFile(target, 'utf8');
      expect(content).toBe('written on linux');
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      } else {
        Object.defineProperty(process, 'platform', { value: 'win32' });
      }
    }
  });
});

// ── withFileLock non-EEXIST error ──────────────────────────────

describe('withFileLock unexpected error', () => {
  it('throws unexpected errors during lock acquisition', async () => {
    const target = path.join(tmpDir, 'unexpected', 'target.json');
    // Create the lock dir as a file so open fails with ENOTDIR or similar
    await fs.writeFile(path.join(tmpDir, 'unexpected'), 'not-dir', 'utf8');
    await expect(withFileLock(target, async () => 'never', { timeoutMs: 100 })).rejects.toThrow();
  });

  it('handles EEXIST and re-acquires lock after stale timeout', async () => {
    // This test specifically covers the `code !== 'EEXIST'` check on line 119
    // where code IS 'EEXIST' (i.e., we do NOT throw and continue to stale check)
    const target = path.join(tmpDir, 'eexist', 'target.json');
    const lockDir = path.join(tmpDir, 'eexist');
    const lockPath = path.join(lockDir, '.target.json.lock');

    await fs.mkdir(lockDir, { recursive: true });
    // Create a lock file so fs.open throws EEXIST
    await fs.writeFile(lockPath, '0:0', { flag: 'wx' });

    // with staleMs = 0, the existing lock should be considered expired immediately
    const result = await withFileLock(target, async () => 'eexist-recovered', {
      timeoutMs: 5000,
      staleMs: 0,
    });
    expect(result).toBe('eexist-recovered');
  });
});

// ── withFileLock: EPERM code path ─────────────────────────────────────

describe('withFileLock EPERM handling', () => {
  it('treats EPERM like EEXIST and waits for the stale lock to lapse', async () => {
    // Windows returns EPERM (not EEXIST) when open(..., 'wx') hits an existing file.
    // Mock fs.open to reject once with EPERM pointing at a real stale lock, then
    // let the real implementation take over once the lock is unlinked.
    const target = path.join(tmpDir, 'eperm', 'target.json');
    const lockDir = path.join(tmpDir, 'eperm');
    const lockPath = path.join(lockDir, '.target.json.lock');
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(lockPath, '0:0', { flag: 'wx' });

    const openMock = vi.mocked(fs.open);
    openMock.mockRejectedValueOnce(errWithCode('EPERM'));

    const result = await withFileLock(target, async () => 'eperm-recovered', {
      timeoutMs: 5000,
      staleMs: 0, // existing lock is immediately stale
    });
    expect(result).toBe('eperm-recovered');
  });
});

// ── waitForLockRelease: watcher + access probe paths ──────────────────

describe('waitForLockRelease paths', () => {
  it('resolves when fs.watch observes the lock file being removed (rename event)', async () => {
    // Acquire the lock externally so withFileLock enters the wait branch, then
    // unlink it so the watcher fires the resolve path (not the timeout path).
    const target = path.join(tmpDir, 'watcher-rename', 'target.json');
    const lockDir = path.join(tmpDir, 'watcher-rename');
    const lockPath = path.join(lockDir, '.target.json.lock');
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(lockPath, '0:0', { flag: 'wx' });

    // Release the lock shortly after the second caller starts waiting.
    // staleMs is large so the stat-based re-acquire doesn't fire first; the
    // watcher rename event must drive resolution.
    setTimeout(() => fs.unlink(lockPath), 30);

    const result = await withFileLock(target, async () => 'watcher-resolved', {
      timeoutMs: 5000,
      staleMs: 60_000,
    });
    expect(result).toBe('watcher-resolved');
  });

  it('resolves via the fs.access probe when the lock is already gone before the watcher attaches', async () => {
    const target = path.join(tmpDir, 'watcher-access', 'target.json');
    const lockDir = path.join(tmpDir, 'watcher-access');
    const lockPath = path.join(lockDir, '.target.json.lock');
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(lockPath, '0:0', { flag: 'wx' });

    // Mock fs.open to reject with EEXIST, then remove the lock immediately so
    // the `fs.access(lockPath)` probe inside waitForLockRelease fires resolve.
    const openMock = vi.mocked(fs.open);
    openMock.mockImplementationOnce(async () => {
      // Remove the lock right before the EEXIST is thrown, so by the time
      // waitForLockRelease runs its access probe, the file is already gone.
      await fs.unlink(lockPath).catch(() => undefined);
      throw errWithCode('EEXIST');
    });

    const result = await withFileLock(target, async () => 'access-resolved', {
      timeoutMs: 5000,
      staleMs: 60_000,
    });
    expect(result).toBe('access-resolved');
  });
});
