/**
 * Gap-closing tests for atomic-write.ts waitForLockRelease paths.
 * Uses a mock watch so we can control fs.watch per test.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { watch as fsWatch } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from '../src/utils/atomic-write.js';

// Mock both node:fs (for watch) and node:fs/promises
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: vi.fn((...args: any[]) => (actual.watch as any)(...args)),
  };
});

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gap-adv-'));
  vi.mocked(fsWatch).mockRestore();
});

afterEach(() => {
  vi.mocked(fsWatch).mockRestore();
});

// ── waitForLockRelease: watcher callback ─────────────────────────
describe('waitForLockRelease - watcher callback', () => {
  it('resolves when concurrent call releases the lock', async () => {
    const target = path.join(tmpDir, 'concurrent', 'target.json');
    const lockDir = path.join(tmpDir, 'concurrent');
    await fs.mkdir(lockDir, { recursive: true });

    // Call A: acquires lock, then deletes it so B's watcher fires
    const callA = withFileLock(target, async () => {
      const lockPath = path.join(lockDir, '.target.json.lock');
      await fs.unlink(lockPath);
      return 'a-done';
    });

    await new Promise((r) => setTimeout(r, 50));

    const callB = withFileLock(target, async () => 'b-done', { timeoutMs: 5000 });

    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect(resultA).toBe('a-done');
    expect(resultB).toBe('b-done');
  });
});

// ── waitForLockRelease: watcher creation fails ──────────────────
describe('waitForLockRelease - watcher creation fail', () => {
  it('falls back to setTimeout when fs.watch throws', async () => {
    // Make fs.watch throw
    vi.mocked(fsWatch).mockImplementation(() => {
      throw new Error('watch not available');
    });

    const target = path.join(tmpDir, 'watch-fail', 'target.json');
    const lockDir = path.join(tmpDir, 'watch-fail');
    const lockPath = path.join(lockDir, '.target.json.lock');

    await fs.mkdir(lockDir, { recursive: true });
    // Create a fresh (non-stale) lock so we enter waitForLockRelease.
    await fs.writeFile(lockPath, `${process.pid}:${Date.now()}`, { flag: 'wx' });

    // Release the lock concurrently during waitForLockRelease's setTimeout
    // fallback.  With a large staleMs the lock is never "stale" (avoids
    // platform-dependent mtime-granularity races); the reclaim must come
    // from the explicit unlink, not from the stat-based stale check.
    setTimeout(() => fs.unlink(lockPath).catch(() => undefined), 10);

    const result = await withFileLock(target, async () => 'catch-resolved', {
      timeoutMs: 5000,
      staleMs: 60_000,
    });
    expect(result).toBe('catch-resolved');
  });
});

// ── waitForLockRelease: access check path ───────────────────────
describe('waitForLockRelease - access check', () => {
  it('resolves via access check when lock is removed during wait', async () => {
    const target = path.join(tmpDir, 'access', 'target.json');
    const lockDir = path.join(tmpDir, 'access');
    const lockPath = path.join(lockDir, '.target.json.lock');

    await fs.mkdir(lockDir, { recursive: true });

    // Use withFileLock as a holder
    const aPromise = withFileLock(target, async () => {
      await new Promise((r) => setTimeout(r, 30));
      await fs.unlink(lockPath);
      return 'a-done';
    });

    await new Promise((r) => setTimeout(r, 10));

    // B will wait for lock, then get it via access check
    const bPromise = withFileLock(target, async () => 'b-done', {
      timeoutMs: 5000,
      staleMs: 60000,
    });

    const [resultA, resultB] = await Promise.all([aPromise, bPromise]);
    expect(resultA).toBe('a-done');
    expect(resultB).toBe('b-done');
  });
});
