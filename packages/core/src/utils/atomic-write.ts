import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { watch as watchDir } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { FsError } from '../types/errors.js';

export interface AtomicWriteOptions {
  mode?: number | undefined;
  encoding?: BufferEncoding | undefined;
}

export interface FileLockOptions {
  timeoutMs?: number | undefined;
  staleMs?: number | undefined;
}

export async function atomicWrite(
  targetPath: string,
  content: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);

  // Write content to tmp first; 'wx' ensures exclusive creation (fails if
  // tmp already exists — extremely unlikely with 6-byte random suffix).
  try {
    if (typeof content === 'string') {
      await fs.writeFile(tmp, content, { flag: 'wx', encoding: opts.encoding ?? 'utf8' });
    } else {
      await fs.writeFile(tmp, content, { flag: 'wx' });
    }
    try {
      const fh = await fs.open(tmp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      // fsync best-effort
    }
    // Now safely read mode from target (if it exists) and apply to tmp before rename.
    // Prefer opts.mode for new files; for existing files preserve their mode.
    let mode: number | undefined;
    try {
      const stat = await fs.stat(targetPath);
      mode = stat.mode & 0o777;
    } catch {
      mode = opts.mode;
    }
    if (mode !== undefined) {
      await fs.chmod(tmp, mode);
    }
    await renameWithRetry(tmp, targetPath);
    // P3 #20 (before-release.md): on Windows, fs.rename (MoveFileExW) does
    // not preserve Unix permission bits — the chmod above applies to the tmp
    // file, but the rename may reset the destination's mode to the Windows
    // default. Re-apply the mode after rename on win32 so an edited file
    // keeps its executable bit (or any non-default permission). On POSIX,
    // rename preserves metadata so this is a no-op (chmod is idempotent and
    // cheap), but we gate it on win32 to avoid the extra stat+chmod on the
    // common path.
    if (mode !== undefined && process.platform === 'win32') {
      try {
        await fs.chmod(targetPath, mode);
      } catch {
        // Best-effort: a transient EPERM (antivirus lock) should not fail
        // the write — the content is already on disk.
      }
    }
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, `.${path.basename(targetPath)}.lock`);
  // A lock holder can be scheduled out for several seconds when the full test
  // suite (or a busy workstation) is spawning many child processes. Five
  // seconds was short enough to turn ordinary contention into a dropped
  // best-effort index write. Keep the wait bounded, but leave enough headroom
  // for the holder to resume and release before stale-lock recovery applies.
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const staleMs = opts.staleMs ?? 30_000;
  const started = Date.now();
  let handle: fs.FileHandle | undefined;

  for (;;) {
    try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}:${Date.now()}`);
      break;
    } catch (err) {
      // If fs.open succeeded but handle.writeFile threw (e.g. ENOSPC, EIO),
      // `handle` owns an open exclusive lock file. Close the handle and remove
      // the orphan lock so the next iteration (or a peer) can acquire it
      // without timing out on the stale-lock window or dead-looping on EEXIST.
      if (handle) {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
        handle = undefined;
      }
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT means the directory was deleted (e.g. by concurrent cleanup).
      // Recreate it and retry acquiring the lock.
      if (code === 'ENOENT') {
        await fs.mkdir(dir, { recursive: true });
        continue;
      }
      if (code !== 'EEXIST' && code !== 'EPERM') throw err;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        throw new FsError({
          message: `Timed out waiting for file lock: ${targetPath}`,
          code: 'FS_ATOMIC_WRITE_FAILED',
          path: targetPath,
          context: { timeoutMs },
        });
      }
      // Wait for the lock to be released, using a filesystem watcher for
      // nearly-instant wake-up instead of polling. The watcher is best-effort:
      // a safety timeout fires at most every 100ms so we don't busy-wait.
      await waitForLockRelease(lockPath, timeoutMs - elapsed);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await handle?.close();
    } catch {
      // ignore
    }
    try {
      await fs.unlink(lockPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Watch a lock file's parent directory for the file being removed (unlinked),
 * which signals that the lock holder has released it. A safety timeout caps
 * the wait so the overall `withFileLock` timeout is always respected.
 *
 * Uses a bounded safety interval (up to 100ms) so even if `fs.watch` is
 * unavailable or misses the event, we never busy-wait at 25ms fixed polling.
 */
async function waitForLockRelease(lockPath: string, remainingMs: number): Promise<void> {
  const parentDir = path.dirname(lockPath);
  const lockName = path.basename(lockPath);
  const intervalMs = Math.min(remainingMs, 100);

  return new Promise<void>((resolve) => {
    let settled = false;
    let watcher: FSWatcher | null = null;

    // Safety timer — always fires, even if fs.watch is unavailable.
    const timer = setTimeout(() => {
      settled = true;
      watcher?.close();
      resolve();
    }, intervalMs);

    try {
      watcher = watchDir(parentDir, (eventType, filename) => {
        if (settled) return;
        // 'rename' fires on unlink on most platforms; 'change' is a
        // conservative fallback for environments that only emit 'change'.
        if (filename === lockName && (eventType === 'rename' || eventType === 'change')) {
          settled = true;
          clearTimeout(timer);
          watcher?.close();
          resolve();
        }
      });
    } catch {
      // fs.watch not supported (e.g. some container environments, network
      // filesystems). Clear the safety timer and fall back to a single
      // short delay — the caller's loop will retry on the next iteration.
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        setTimeout(resolve, Math.min(remainingMs, 25));
      }
      return;
    }

    // Re-check lock existence after setting up the watch to close the race
    // where the lock was released between our last EEXIST check and now.
    fs.access(lockPath).then(
      () => {
        // Lock still exists — the watch (or safety timer) will resolve.
      },
      () => {
        // Lock was already released — respond immediately.
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          watcher?.close();
          resolve();
        }
      },
    );
  });
}

// On Windows, fs.rename over an existing file can fail with EPERM/EBUSY/EACCES
// when antivirus, file indexers, editor file watchers, or a concurrent writer
// briefly hold a handle on the destination. These are transient — retry with a
// short backoff before giving up. POSIX renames are atomic and won't hit this.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  if (process.platform !== 'win32') {
    await fs.rename(from, to);
    return;
  }
  const delays = [10, 25, 60, 120, 250];
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || i === delays.length) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
    }
  }
  throw lastErr;
}
