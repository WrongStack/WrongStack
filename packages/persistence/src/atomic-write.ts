import { randomBytes } from 'node:crypto';
import type { FSWatcher } from 'node:fs';
import { watch as watchDir } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  _filePermOps,
  restrictDirPermissions,
  restrictFilePermissions,
} from './file-permissions.js';

/**
 * A `.wrongstack` leaf directory with at most this many entries may be given
 * an inheritable owner-only ACL once instead of `icacls` on every write.
 * icacls re-applies a directory ACL to every existing child (recursively
 * through subdirectories) at O(files) cost on each call, so large or nested
 * trees keep the per-file path.
 */
const OWNER_ONLY_DIR_MAX_ENTRIES = 200;

export interface AtomicWriteOptions {
  mode?: number | undefined;
  encoding?: BufferEncoding | undefined;
}

export interface FileLockOptions {
  timeoutMs?: number | undefined;
  staleMs?: number | undefined;
}

export interface FileLockTimeoutDetails {
  targetPath: string;
  timeoutMs: number;
}

export interface PersistencePrimitiveOptions {
  createLockTimeoutError?: ((details: FileLockTimeoutDetails) => Error) | undefined;
}

export interface PersistencePrimitives {
  atomicWrite(
    targetPath: string,
    content: string | Uint8Array,
    opts?: AtomicWriteOptions,
  ): Promise<void>;
  atomicReplaceWithWriter<T>(
    targetPath: string,
    write: (handle: fs.FileHandle) => Promise<T>,
    opts?: AtomicWriteOptions,
  ): Promise<T>;
  ensureDir(dir: string): Promise<void>;
  withFileLock<T>(targetPath: string, fn: () => Promise<T>, opts?: FileLockOptions): Promise<T>;
}

/** A dependency-free structured error for persistence boundary failures. */
export class PersistenceFsError extends Error {
  override name = 'FsError';
  readonly code: string;
  readonly path?: string | undefined;
  readonly context?: Record<string, unknown> | undefined;

  constructor(opts: {
    message: string;
    code: string;
    path?: string | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super(opts.message, { cause: opts.cause });
    this.code = opts.code;
    this.path = opts.path;
    this.context = opts.context;
  }
}

/**
 * Create an isolated primitive set. Hosts may inject their own structured
 * timeout error without making this low-level package depend on that host.
 */
export function createPersistencePrimitives(
  options: PersistencePrimitiveOptions = {},
): PersistencePrimitives {
  const createLockTimeoutError =
    options.createLockTimeoutError ??
    (({ targetPath, timeoutMs }: FileLockTimeoutDetails) =>
      new PersistenceFsError({
        message: `Timed out waiting for file lock: ${targetPath}`,
        code: 'FS_ATOMIC_WRITE_FAILED',
        path: targetPath,
        context: { timeoutMs },
      }));

  /**
   * Shared tail of every atomic replace: fsync the temp file, carry the
   * target's permission bits over, and swap it in with the Windows-hardened
   * rename. Split out so `atomicWrite` (whole-buffer) and
   * `atomicReplaceWithWriter` (streaming) cannot drift apart.
   */
  /** Directory identity -> whether new files there already inherit owner-only ACLs. */
  const ownerOnlyDirs = new Map<string, Promise<boolean>>();

  /**
   * Windows only: make an eligible directory hand owner-only ACLs to the files
   * created in it, once per directory identity (a recreated directory is a new
   * identity). Must run BEFORE the temp file is created so it inherits the ACL.
   * False means "not eligible or not done" — the caller keeps per-file icacls.
   */
  async function prepareOwnerOnlyDir(dir: string): Promise<boolean> {
    if (_filePermOps.platform !== 'win32') return false;
    const resolved = path.resolve(dir);
    if (!resolved.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.wrongstack')) {
      return false;
    }
    let key: string;
    try {
      const stat = await fs.stat(resolved);
      key = `${resolved.toLowerCase()}|${stat.ino}|${stat.birthtimeMs}`;
    } catch {
      return false;
    }
    let pending = ownerOnlyDirs.get(key);
    if (!pending) {
      pending = hardenLeafDir(resolved);
      ownerOnlyDirs.set(key, pending);
    }
    return pending;
  }

  async function hardenLeafDir(dir: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (
        entries.length > OWNER_ONLY_DIR_MAX_ENTRIES ||
        entries.some((entry) => entry.isDirectory())
      ) {
        return false;
      }
    } catch {
      return false;
    }
    // restrictDirPermissions never throws; it reports failure through `warn`.
    let failed = false;
    await restrictDirPermissions(dir, {
      warn: () => {
        failed = true;
      },
    });
    return !failed;
  }

  async function commitTemp(
    tmp: string,
    targetPath: string,
    opts: AtomicWriteOptions,
    dirIsOwnerOnly = false,
  ) {
    try {
      const fileHandle = await fs.open(tmp, 'r+');
      try {
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
    } catch {
      // fsync is best-effort; the atomic rename still protects readers.
    }

    // WS-045: an explicitly requested mode is a CEILING on permissiveness, not
    // a suggestion. This used to stat first and use `opts.mode` only when the
    // target did not exist — so a file created once as 0644 (by an older
    // version, a different tool, an inherited umask) could never be tightened:
    // every later `atomicWrite(..., {mode: 0o600})` silently re-applied 0644.
    //
    // The rule is now "most restrictive of the two" — a bitwise AND. Requested
    // 0600 over an existing 0644 gives 0600 (the fix); requested 0640 over an
    // existing 0600 still gives 0600, so a caller can never widen a file the
    // user or an earlier, stricter caller deliberately locked down. With no
    // requested mode the target's own bits are preserved unchanged, which is
    // what keeps a user's deliberate `chmod` on an ordinary config file.
    let mode: number | undefined;
    let existing: number | undefined;
    try {
      const stat = await fs.stat(targetPath);
      existing = stat.mode & 0o777;
    } catch {
      existing = undefined;
    }
    if (opts.mode !== undefined) {
      mode = existing === undefined ? opts.mode : opts.mode & existing;
    } else {
      mode = existing;
    }
    if (mode !== undefined) await fs.chmod(tmp, mode);

    // On Windows, MoveFileEx(..., MOVEFILE_REPLACE_EXISTING) fails with EPERM
    // if the existing destination file has the read-only attribute set. Temporarily
    // clear the read-only attribute on targetPath so the atomic rename succeeds;
    // the chmod below then re-applies the final intended mode.
    let clearedReadOnly = false;
    if (process.platform === 'win32' && existing !== undefined && (existing & 0o200) === 0) {
      clearedReadOnly = true;
      await fs.chmod(targetPath, 0o666).catch(() => undefined);
    }

    try {
      await renameWithRetry(tmp, targetPath);
    } catch (error) {
      if (clearedReadOnly && existing !== undefined) {
        await fs.chmod(targetPath, existing).catch(() => undefined);
      }
      throw error;
    }
    if (mode !== undefined && process.platform === 'win32') {
      await fs.chmod(targetPath, mode).catch(() => undefined);
    }
    // S3 (F2/G2/G3/G4): the `mode: 0o600` declaration on a write is the
    // caller's promise that the file is secret. POSIX honours it via
    // `chmod`; Windows does not — `chmod` only flips the read-only bit
    // and the renamed file inherits the parent directory's ACEs, so a
    // `CodexSandboxUsers`-style sibling account can read the secret.
    // Apply `restrictFilePermissions` on Windows when the mode is
    // an owner-only secret mode (group and other have no permissions) — it shells out
    // to `icacls` on Windows and re-applies the owning-user-only ACE.
    // POSIX already has the computed mode; applying the helper's fixed 0600
    // there would widen stricter modes such as 0400.
    // A hardened directory already gave the temp file an owner-only ACL.
    if (
      _filePermOps.platform === 'win32' &&
      mode !== undefined &&
      (mode & 0o077) === 0 &&
      !dirIsOwnerOnly
    ) {
      await restrictFilePermissions(targetPath, { warn: () => undefined }).catch(() => undefined);
    }
  }

  function isOwnerOnlyMode(mode: number | undefined): boolean {
    return mode !== undefined && (mode & 0o077) === 0;
  }

  function tempPathFor(targetPath: string): string {
    return path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`,
    );
  }

  async function atomicWrite(
    targetPath: string,
    content: string | Uint8Array,
    opts: AtomicWriteOptions = {},
  ): Promise<void> {
    await atomicReplaceWithWriter(
      targetPath,
      (handle) => handle.writeFile(content, { encoding: opts.encoding ?? 'utf8' }),
      opts,
    );
  }

  /**
   * Atomically replace `targetPath` with whatever `write` streams into the
   * handle it is given. Same durability and rename semantics as
   * {@link atomicWrite}, but the caller never has to materialize the new
   * contents in memory — the point of this variant. Used by log rotation,
   * where holding the retained tail as one buffer is exactly the allocation
   * spike being avoided.
   *
   * Returns whatever `write` returns. The temp file is removed if `write`
   * throws, so a failed rotation leaves the original file untouched.
   */
  async function atomicReplaceWithWriter<T>(
    targetPath: string,
    write: (handle: fs.FileHandle) => Promise<T>,
    opts: AtomicWriteOptions = {},
  ): Promise<T> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const dirIsOwnerOnly =
      isOwnerOnlyMode(opts.mode) && (await prepareOwnerOnlyDir(path.dirname(targetPath)));
    const tmp = tempPathFor(targetPath);
    let tempCreated = false;

    try {
      // Restrict the temp at creation; add owner write permission until commitTemp
      // applies the final ceiling so writing and fsync can finish first.
      const createMode = opts.mode !== undefined ? opts.mode | 0o200 : undefined;
      const handle = await fs.open(tmp, 'wx', createMode);
      tempCreated = true;
      let result: T;
      try {
        result = await write(handle);
      } catch (error) {
        // `write` already failed; a close error here would only mask the real
        // cause, so it stays swallowed on this path.
        await handle.close().catch(() => undefined);
        throw error;
      }
      // NOT swallowed on the success path: close() is where a buffered write
      // failure surfaces (ENOSPC/EIO/EDQUOT — the kernel accepts write() and
      // only reports at the last descriptor close). Discarding it would let
      // commitTemp rename a truncated temp file over a healthy target, which
      // is the one thing this primitive exists to prevent. commitTemp's fsync
      // cannot stand in for it: that block is deliberately best-effort.
      await handle.close();
      await commitTemp(tmp, targetPath, opts, dirIsOwnerOnly);
      return result;
    } catch (error) {
      // Any failed exclusive open leaves ownership elsewhere, regardless of its
      // error code. Only clean up after this invocation actually created the temp.
      if (tempCreated) {
        await fs.unlink(tmp).catch(() => undefined);
      }
      throw error;
    }
  }

  async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  async function withFileLock<T>(
    targetPath: string,
    fn: () => Promise<T>,
    opts: FileLockOptions = {},
  ): Promise<T> {
    const dir = path.dirname(targetPath);
    const lockPath = path.join(dir, `.${path.basename(targetPath)}.lock`);
    const timeoutMs =
      typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
        ? Math.max(0, opts.timeoutMs)
        : 15_000;
    const staleMs =
      typeof opts.staleMs === 'number' && Number.isFinite(opts.staleMs) && opts.staleMs > 0
        ? opts.staleMs
        : 30_000;
    const started = Date.now();
    let handle: fs.FileHandle | undefined;
    let attempt = 0;
    let mkdirRetries = 0;
    // Hoisted: the release path in `finally` compares the lock file's
    // contents against our token, so it must outlive the acquire loop.
    let myToken = '';

    // Every retry path funnels through here. Two of them used to `continue`
    // straight back to `fs.open` without consulting the deadline and without
    // yielding, which turned this loop into an unbounded 100%-CPU spin that
    // could never time out:
    //
    //  - a stale lock whose `unlink` keeps failing (Windows EPERM: the file is
    //    still open by a crashed holder, an AV scanner, or another user), and
    //  - a lock whose `stat` keeps failing (EPERM/EACCES on the lock file).
    //
    // Both are reachable in normal Windows operation, and every caller behind
    // this lock — chronicle journal, metrics store, knowledge graph, the HQ
    // event log, the review and annotation stores — hung forever with a core
    // pinned. Retries are now deadline-checked and backed off.
    const retryAfterBackoff = async (): Promise<void> => {
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) throw createLockTimeoutError({ targetPath, timeoutMs });
      const backoffMs = Math.min(2 ** attempt, 100, timeoutMs - elapsed);
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    };

    for (;;) {
      try {
        handle = await fs.open(lockPath, 'wx');
        // S7 (RACE-002 / G5): the previous lock wrote `${pid}:${mtime}`
        // and the `finally` branch unconditionally unlinked the file.
        // After a stale-break (a synchronous `bun:sqlite`/`node:sqlite`
        // burst blocks the heartbeat past `staleMs`), process A's
        // release would delete process B's live lock and admit a
        // third holder. The fix writes a 16-byte random token alongside
        // the pid; both the release path and the stale-break path read
        // it back and only unlink on a match, so an unrelated
        // live-actor lock is never stolen.
        myToken = randomBytes(16).toString('hex');
        await handle.writeFile(`${process.pid}:${myToken}`);
        break;
      } catch (error) {
        if (handle) {
          const owned = await handle.stat().catch(() => undefined);
          await handle.close().catch(() => undefined);
          const current = await fs.stat(lockPath).catch(() => undefined);
          if (
            owned &&
            current &&
            owned.ino === current.ino &&
            owned.dev === current.dev &&
            owned.birthtimeMs === current.birthtimeMs
          ) {
            await fs.unlink(lockPath).catch(() => undefined);
          }
          handle = undefined;
        }

        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          await fs.mkdir(dir, { recursive: true });
          // Creating the missing directory is forward progress, not contention,
          // so the first retry stays immediate and deadline-free — a caller
          // that passes `timeoutMs: 0` against a fresh directory must still be
          // able to acquire. A *repeated* ENOENT means something keeps removing
          // the directory underneath us, so every later retry is backed off.
          if (mkdirRetries++ === 0) continue;
          await retryAfterBackoff();
          continue;
        }
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
          throw error;
        }

        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            // Re-stat right before removing. A live holder's heartbeat (or a
            // fresh holder that just acquired) changes mtimeMs. Also compare
            // identity: coarse timestamp precision can give a replacement
            // inode the same mtime as the stale file we observed.
            const recheck = await fs.stat(lockPath).catch(() => undefined);
            if (
              recheck &&
              recheck.ino === stat.ino &&
              recheck.dev === stat.dev &&
              recheck.birthtimeMs === stat.birthtimeMs &&
              recheck.mtimeMs === stat.mtimeMs &&
              Date.now() - recheck.mtimeMs > staleMs
            ) {
              await breakStaleLock(lockPath, recheck);
            }
            await retryAfterBackoff();
            continue;
          }
        } catch {
          await retryAfterBackoff();
          continue;
        }

        const elapsed = Date.now() - started;
        if (elapsed >= timeoutMs) {
          throw createLockTimeoutError({ targetPath, timeoutMs });
        }
        await waitForLockRelease(lockPath, timeoutMs - elapsed);
      }
    }

    // Heartbeat: refresh the lock's mtime while fn() runs so a legitimately
    // long critical section (e.g. index compaction under a slow disk/AV) is
    // never mistaken for a stale lock and stolen by another process — which
    // would put two holders in the section and drop writes. A live holder now
    // stays fresh, so the stale-break path only fires for a crashed holder.
    // Refresh twice per stale window so a live holder never crosses staleMs.
    // The small floor only guards against a pathologically tiny staleMs.
    // (An eager unref'd interval is deliberate: it fires at staleMs/2 and is
    // cleared before its first tick for any short section, so the common path
    // pays no syscalls. Deferring or raising the floor beyond staleMs/2 would
    // let a long holder go stale before the first refresh and be stolen.)
    const refreshMs = Math.min(2_147_483_647, Math.max(1, Math.floor(staleMs / 2)));
    const heartbeat = setInterval(() => {
      const now = new Date();
      // Refresh the file we acquired, even if stale recovery replaced its
      // pathname. Updating by path would keep a different owner's lock alive.
      void handle?.utimes(now, now).catch(() => undefined);
    }, refreshMs);
    heartbeat.unref?.();

    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await handle?.close().catch(() => undefined);
      // S7 (RACE-002 / G5): only unlink the lock if its current
      // content still names our pid+token. If a stale-break had to
      // re-acquire the lock because a heartbeat missed the staleMs
      // window, the file is now a *different* live holder's lock and
      // unlinking it would be a lock-stealing bug.
      // A concurrent breakStaleLock renames a live lock aside before linking it
      // back; a release in that window reads ENOENT and would orphan the lock
      // until staleMs. Look again briefly before giving it up as gone.
      try {
        for (let look = 0; handle && look < 5; look++) {
          const contents = await fs
            .readFile(lockPath, 'utf8')
            .catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? undefined : ''));
          if (contents === undefined && look < 4) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            continue;
          }
          if (contents === `${process.pid}:${myToken}`) {
            await fs.unlink(lockPath).catch(() => undefined);
          }
          break;
        }
      } catch {
        // Best-effort cleanup; the heartbeat loop will reap it on
        // the next stale break if anything went wrong here.
      }
    }
  }

  return { atomicWrite, atomicReplaceWithWriter, ensureDir, withFileLock };
}

/**
 * Remove the stale lock `observed` and nothing else. Another waiter may break
 * the same stale lock and acquire a fresh one between our stat and our removal;
 * unlinking by pathname then deleted that live lock and admitted a second
 * holder. Renaming captures exactly one file: delete it only when it is the one
 * we judged stale, otherwise link the live lock back (same inode, so its
 * holder's token and heartbeat still apply).
 */
async function breakStaleLock(
  lockPath: string,
  observed: { ino: number; dev: number; birthtimeMs: number },
): Promise<void> {
  const grave = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await fs.rename(lockPath, grave);
  } catch {
    return;
  }
  const moved = await fs.stat(grave).catch(() => undefined);
  if (
    moved &&
    (moved.ino !== observed.ino ||
      moved.dev !== observed.dev ||
      moved.birthtimeMs !== observed.birthtimeMs)
  ) {
    await fs.link(grave, lockPath).catch(() => undefined);
  }
  await fs.unlink(grave).catch(() => undefined);
}

async function waitForLockRelease(lockPath: string, remainingMs: number): Promise<void> {
  const parentDir = path.dirname(lockPath);
  const lockName = path.basename(lockPath);
  const intervalMs = Math.min(remainingMs, 100);

  return new Promise<void>((resolve) => {
    let settled = false;
    let watcher: FSWatcher | null = null;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      watcher?.close();
      resolve();
    };
    const timer = setTimeout(settle, intervalMs);

    try {
      watcher = watchDir(parentDir, (eventType, filename) => {
        if (filename === lockName && (eventType === 'rename' || eventType === 'change')) {
          clearTimeout(timer);
          settle();
        }
      });
      watcher.on('error', () => {
        clearTimeout(timer);
        settle();
      });
    } catch {
      clearTimeout(timer);
      setTimeout(settle, Math.min(remainingMs, 25));
      return;
    }

    void fs.access(lockPath).catch(() => {
      clearTimeout(timer);
      settle();
    });
  });
}

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  if (process.platform !== 'win32') {
    await fs.rename(from, to);
    return;
  }

  // Windows readers (fs.open on the destination) can hold the file through
  // several rename attempts; ~4s total gives concurrent-process readers and
  // antivirus scanners time to release without failing the write. When all
  // retries are exhausted, the caller receives the original error and self-
  // heals on the next cycle — intentionally NOT falling back to copyFile,
  // which would break the atomic-write contract (a concurrent reader could
  // observe a torn destination during the copy).
  const delays = [10, 25, 60, 120, 250, 500, 1000, 2000];
  let attempt = 0;
  for (;;) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      let transient = code !== undefined && TRANSIENT_RENAME_CODES.has(code);
      if (transient) {
        // Windows reports EPERM when a regular temp file is renamed onto an
        // existing directory. That is a permanent type mismatch, not reader
        // contention, so retrying only delays the inevitable failure and emits
        // a misleading exhaustion warning (notably in conformance tests).
        // Check after the failed rename to keep the normal file-replacement
        // path race-free and retain retries for real file locks/AV scanners.
        try {
          const target = await fs.stat(to);
          if (target.isDirectory()) transient = false;
        } catch {
          // A missing or temporarily inaccessible target can still be a
          // transient Windows rename failure; preserve the retry policy.
        }
      }
      if (code === 'ENOENT') {
        // The temp was fsynced and chmod'd a moment before this rename, so
        // the source existed — an ENOENT here is a Windows AV/filter-driver
        // visibility race (the file is momentarily invisible to MoveFileEx),
        // not a deletion. Verify the source still exists: if it does, retry
        // like EPERM/EBUSY; if it is genuinely gone (concurrent cleanup),
        // waiting cannot heal it, so fail fast.
        try {
          await fs.stat(from);
          transient = true;
        } catch {
          transient = false;
        }
      }
      if (!transient || attempt === delays.length) {
        // All transient retries exhausted — emit a diagnostic warning so
        // operators know the atomic write failed without replacing the target.
        if (attempt === delays.length) {
          process.emitWarning(
            `Windows rename retries exhausted for '${from}' → '${to}' (code=${code}). ` +
              'Atomic write failed; the original target was left untouched.',
            { code: 'WRONGSTACK_WIN32_RENAME_EXHAUSTED' },
          );
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      attempt++;
    }
  }
}

const defaultPrimitives = createPersistencePrimitives();

export const atomicWrite = defaultPrimitives.atomicWrite;
export const atomicReplaceWithWriter = defaultPrimitives.atomicReplaceWithWriter;
export const ensureDir = defaultPrimitives.ensureDir;
export const withFileLock = defaultPrimitives.withFileLock;
