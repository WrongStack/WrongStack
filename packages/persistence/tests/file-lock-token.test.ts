/**
 * Regression for S7 (RACE-002 / G5): the previous `withFileLock` wrote
 * `${pid}:${mtime}` and the `finally` block unconditionally unlinked
 * the file. After a stale-break, a process whose heartbeat missed the
 * staleMs window could have its lock re-acquired by a second holder;
 * the first holder's release would then delete the *second* holder's
 * live lock and admit a third. The release checks a random ownership
 * token; the heartbeat must also stay bound to the acquired file.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withFileLock } from '../src/atomic-write.js';

const lockPath = (target: string): string =>
  path.join(path.dirname(target), `.${path.basename(target)}.lock`);

describe('S7 / withFileLock — ownership-token release', () => {
  it('does not unlink a lock that a different process re-acquired', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's7-token-'));
    try {
      const target = path.join(tmp, 'state.json');
      await fs.writeFile(target, 'init');

      // 1. First holder acquires, runs a long section, and is asked to
      //    release — but we corrupt its lock to look like a different
      //    pid mid-run.
      let releaseObserved = false;
      const held = withFileLock(target, async () => {
        // Simulate the stale-break scenario: the lock file gets
        // re-acquired by another actor (we overwrite the contents
        // with a foreign pid+token). The first holder's release
        // MUST NOT unlink that new lock.
        await fs.writeFile(
          lockPath(target),
          `${process.pid + 1}:foreign-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
        );
        await new Promise((r) => setTimeout(r, 50));
        releaseObserved = true;
        return 'first';
      });

      // 2. Second holder waits, then acquires after the file's mtime
      //    is older than `staleMs`. We can simulate that with a
      //    short-staleMs call here, or simply wait for the first
      //    holder to finish and then assert the file content is
      //    unchanged.
      const result = await held;
      expect(result).toBe('first');
      expect(releaseObserved).toBe(true);

      // The lock file must still exist (a foreign pid+token lives
      // there) and must NOT have been deleted by the first holder's
      // release.
      const after = await fs.readFile(lockPath(target), 'utf8');
      expect(after).toContain('foreign-token');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('unlinks its own lock when the file still names this pid+token', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's7-self-'));
    try {
      const target = path.join(tmp, 'state.json');
      await fs.writeFile(target, 'init');
      const result = await withFileLock(target, async () => {
        expect(await fs.readFile(lockPath(target), 'utf8')).toMatch(
          new RegExp(`^${process.pid}:[a-f0-9]{32}$`),
        );
        return 'ok';
      });
      expect(result).toBe('ok');
      // The happy path: the lock file was released and is gone.
      await expect(fs.access(lockPath(target))).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('does not refresh a replacement lock owned by another holder', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-heartbeat-owner-'));
    const target = path.join(tmp, 'state.json');
    const retired = path.join(tmp, 'retired.lock');
    try {
      await withFileLock(
        target,
        async () => {
          // Move the acquired inode aside and install another owner's lock
          // at the same path, as happens after stale-lock recovery.
          await fs.rename(lockPath(target), retired);
          await fs.writeFile(lockPath(target), 'another-owner:token');
          const old = new Date(Date.now() - 60_000);
          await fs.utimes(retired, old, old);
          await fs.utimes(lockPath(target), old, old);
          const replacementTime = (await fs.stat(lockPath(target))).mtimeMs;

          // Wait for an actual filesystem heartbeat, not a guessed delay.
          // The heartbeat ticks at staleMs/2, but vi.waitFor's 1s default
          // expired once under full-suite CPU contention before the first
          // tick landed — bound it generously instead (the critical section
          // itself is not deadline-bounded, so 10s stays safe).
          await vi.waitFor(
            async () => {
              expect((await fs.stat(retired)).mtimeMs).toBeGreaterThan(old.getTime() + 1_000);
            },
            { timeout: 10_000, interval: 50 },
          );
          expect((await fs.stat(lockPath(target))).mtimeMs).toBe(replacementTime);
        },
        { staleMs: 100 },
      );
      expect(await fs.readFile(lockPath(target), 'utf8')).toBe('another-owner:token');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('clamps heartbeat setInterval delay to 2_147_483_647ms when staleMs exceeds 32-bit range', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-heartbeat-clamp-'));
    const target = path.join(tmp, 'state.json');
    const origSetInterval = globalThis.setInterval;
    const delays: number[] = [];
    (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((
      fn: Parameters<typeof setInterval>[0],
      delay?: number,
      ...args: unknown[]
    ) => {
      delays.push(Number(delay ?? 0));
      return origSetInterval(fn, delay, ...args);
    }) as typeof setInterval;

    try {
      await withFileLock(
        target,
        async () => {
          await new Promise((r) => setTimeout(r, 15));
        },
        { staleMs: 60 * 24 * 60 * 60 * 1000 },
      );
      expect(delays.length).toBeGreaterThan(0);
      expect(delays.every((d) => d >= 1 && d <= 2_147_483_647)).toBe(true);
    } finally {
      (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = origSetInterval;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
