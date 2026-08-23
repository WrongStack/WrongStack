/**
 * Crash- and Windows-safe file primitives behind {@link SessionRegistry}.
 *
 * The registry is one JSON file written by every WrongStack process, so its
 * write path carries all the platform scar tissue: an advisory lock file that a
 * crashed owner can leave behind, a fsync-before-rename that a system crash
 * would otherwise turn into a zero-filled registry, a copyFile fallback for
 * Windows MoveFile sharing violations, and temp-file litter from any of the
 * above. All of that lives here; `session-registry.ts` keeps the state machine.
 *
 * Every function is keyed on the registry file path rather than the registry
 * instance — none of them need registry state.
 *
 * @module session-registry-atomic-file
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import type { SessionRegistryEntry } from './session-registry-types.js';
import { isPidAlive } from '../utils/pid.js';

// A held lock is released within milliseconds; anything older is a crashed
// owner's leftover and is safe to break so writes never wedge permanently.
const STALE_LOCK_MS = 10_000;
/** Same-host live-owner cap — legit holds are well under this. */
const SAME_HOST_STALE_MS = 2 * STALE_LOCK_MS;
/** Also the scan interval for {@link pruneStaleTempFiles} — see its caller. */
export const STALE_TMP_MS = 60_000;
const MAX_STALE_TMP_FILES = 20;

/** Machine name stamped into locks so foreign hosts never misread a pid. */
const HOST_NAME = hostname();

/** `host:pid` owner stamp written into the advisory lock on acquisition. */
export function lockOwnerStamp(): string {
  return `${HOST_NAME}:${process.pid}`;
}

/**
 * Unlink `lockPath` only if it still carries OUR exact host:pid stamp. A
 * stale-lock breaker may have stolen the lock and re-stamped it with another
 * host:pid; the resumed holder must not remove the new owner's lock. An EMPTY
 * read is never ours to remove either — it may be the new owner's lock in its
 * open-to-stamp gap (that lock is mtime-bounded instead).
 *
 * Residual race: between the owner read and the unlink, a foreign-host lease
 * break could replace the lock; unlinking would then remove the new owner's
 * lock. Exploiting it requires a >STALE_LOCK_MS hold AND a rename+stamp
 * landing inside that microsecond window, so it is accepted and bounded by
 * the same foreign-lease logic that enabled it.
 */
export async function maybeUnlinkOwnedLock(lockPath: string): Promise<void> {
  const owner = await fs.readFile(lockPath, 'utf8').catch(() => null);
  if (owner === null || owner.trim() !== lockOwnerStamp()) return;
  // Bounded retry: Windows can transiently hold a freshly-written lock file
  // (AV scan, indexing); a one-shot swallow would leave our live lock behind
  // and double the recovery window for every waiter.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.unlink(lockPath);
      return;
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/**
 * Break a contended lock if it is stale: a same-host owner pid that is no
 * longer alive, or a foreign-host/ownerless lock older than
 * {@link STALE_LOCK_MS}. A live same-host owner's lock is only broken past
 * {@link SAME_HOST_STALE_MS} — a live-but-wedged holder must not degrade
 * cross-session writes forever, but mtime alone must not false-positive while
 * the holder is mid-critical-section. Returns true when the lock was removed
 * (caller should retry acquisition).
 *
 * Removal is an atomic RENAME to a unique tombstone, never unlink: with
 * unlink, two waiters can both read a stale lock and one's unlink can remove
 * the OTHER's fresh lock, letting both into the critical section (POSIX).
 * Rename wins for exactly one waiter; losers get ENOENT and simply retry.
 * (A rename landing after the winner re-created the lock could still move the
 * winner's fresh lock — a pre-existing microsecond TOCTOU; the caller's
 * stamp-guarded cleanup prevents the resumed holder from unlinking the new
 * owner's lock.)
 */
export async function breakStaleLock(lockPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(lockPath, 'utf8').catch(() => '');
    const trimmed = content.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      // Legacy bare-pid lock (pre host:pid stamps): preserve the old
      // dead-owner behavior; an alive/unparseable bare pid falls back to the
      // mtime lease cap.
      const barePid = Number.parseInt(trimmed, 10);
      if (Number.isInteger(barePid) && barePid > 0 && !isPidAlive(barePid)) {
        return await breakStaleLockVerified(lockPath, async () => {
          const reread = await fs.readFile(lockPath, 'utf8').catch(() => '');
          return reread.trim() === trimmed;
        });
      }
      return await breakStaleLockVerified(lockPath, async () => {
        const st = await fs.stat(lockPath);
        return Date.now() - st.mtimeMs > STALE_LOCK_MS;
      });
    }
    const ownerHost = trimmed.slice(0, colonIdx);
    const ownerPid = Number.parseInt(trimmed.slice(colonIdx + 1), 10);
    if (ownerHost === HOST_NAME && Number.isInteger(ownerPid) && ownerPid > 0) {
      if (isPidAlive(ownerPid)) {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > SAME_HOST_STALE_MS) {
          return await breakStaleLockVerified(lockPath, async () => {
            const st = await fs.stat(lockPath);
            return Date.now() - st.mtimeMs > SAME_HOST_STALE_MS;
          });
        }
        return false;
      }
      return await breakStaleLockVerified(lockPath, async () => {
        const reread = await fs.readFile(lockPath, 'utf8').catch(() => '');
        return reread.trim() === trimmed;
      });
    }
    // Foreign-host host:pid lock — pid not interpretable here; mtime lease only.
    return await breakStaleLockVerified(lockPath, async () => {
      const st = await fs.stat(lockPath);
      return Date.now() - st.mtimeMs > STALE_LOCK_MS;
    });
  } catch {
    // stat failed → the lock vanished underneath us; let the caller retry.
    /* v8 ignore next -- defensive: a vanished lock between read and stat is fine */
    return true;
  }
}

/**
 * Re-verify the stale classification immediately before the atomic break, so a
 * winner that re-created the lock between classification and rename is not
 * displaced. The residual window shrinks to the two adjacent syscalls between
 * this verification and the rename.
 */
async function breakStaleLockVerified(
  lockPath: string,
  verify: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await verify())) return false;
  return (await breakLockAtomically(lockPath)) === true;
}

/**
 * Remove a stale lock file via atomic RENAME to a unique tombstone, never
 * unlink: with unlink, two waiters can both read a stale lock and one's
 * unlink can remove the OTHER's fresh lock, letting both into the critical
 * section (POSIX). Rename wins for exactly one waiter; losers get ENOENT and
 * simply keep waiting on the winner's fresh lock.
 */
async function breakLockAtomically(lockPath: string): Promise<boolean> {
  // `.tmp` suffix so pruneStaleTempFiles (session-registry) — or any future
  // store pruner — can reclaim a tombstone left by a breaker that died before
  // its fire-and-forget cleanup ran.
  const tombstone = `${lockPath}.stale-${randomUUID()}.tmp`;
  try {
    await fs.rename(lockPath, tombstone);
  } catch {
    // EPERM (AV), ENOENT (already broken), or a lost race — not ours to break.
    return false;
  }
  // The tombstone is ours alone — remove it right away.
  void fs.unlink(tombstone).catch(() => undefined);
  return true;
}

export async function writeAtomicFile(
  filePath: string,
  registry: Record<string, SessionRegistryEntry>,
): Promise<void> {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID().slice(0, 8)}.tmp`,
  );
  let tmpPersisted = false;
  try {
    // Write + fsync BEFORE the rename: without the fsync, a system crash
    // can journal the rename metadata while the data blocks were never
    // flushed, leaving a zero-filled (all-NUL) registry file on reboot.
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(registry, null, 2), 'utf8');
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    tmpPersisted = true;
    // Cross-platform atomic publish:
    //   1. POSIX: rename(2) is atomic; if the destination exists it is
    //      replaced in one step.
    //   2. Windows (Node 22): fs.rename uses MoveFile, which fails with
    //      EPERM/EBUSY when the destination is briefly held by an antivirus
    //      scan, a peer process reading the file, or an indexer.
    //      fs.copyFile uses CopyFileEx/CopyFile2 with REPLACE_EXISTING,
    //      which DOES overwrite an existing destination and tolerates short
    //      sharing-violation windows better than MoveFile. Doing copyFile
    //      first, then fs.unlink(tmp), gives us "best of both worlds":
    //      the published bytes are the freshly written + fsynced ones,
    //      and the destination is replaced even when MoveFile refuses.
    //      The publish is no longer strictly atomic across the OS boundary,
    //      but the only readers (cross-process observers) re-read after a
    //      brief settle, and we still hold the cross-process advisory lock
    //      so no concurrent writer can interleave.
    try {
      await fs.rename(tmp, filePath);
      tmpPersisted = false;
    } catch (renameErr) {
      const code = (renameErr as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        // Copy bytes to destination (REPLACE_EXISTING is the default for
        // fs.copyFile when COPYFILE_FAIL_IF_EXISTS is not set), fsync the
        // destination so readers don't see zero-filled data on a crash,
        // then drop the temp file.
        await fs.copyFile(tmp, filePath);
        try {
          const destHandle = await fs.open(filePath, 'r+');
          try {
            await destHandle.sync().catch(() => undefined);
          } finally {
            await destHandle.close();
          }
        } catch {
          // Best-effort fsync of the destination; failure is non-fatal
          // because we already wrote the bytes and the OS will flush.
        }
        await fs.unlink(tmp).catch(() => undefined);
        tmpPersisted = false;
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    /* v8 ignore start -- rename-failure cleanup: best-effort tmp unlink + rethrow (atomicUpdate swallows it) */
    if (tmpPersisted) await fs.unlink(tmp).catch(() => undefined);
    throw err;
    /* v8 ignore stop */
  }
}

export async function pruneStaleTempFiles(filePath: string): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const now = Date.now();
    const stale: Array<{ name: string; mtimeMs: number }> = [];

    for (const name of await fs.readdir(dir)) {
      const isTemp =
        (name.startsWith(`${base}.`) || name.startsWith(`.${base}.`)) && name.endsWith('.tmp');
      if (!isTemp) continue;
      /* v8 ignore start -- best-effort temp stat; .catch(null)+continue only fire when the temp vanished */
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!stat) continue;
      /* v8 ignore stop */
      if (now - stat.mtimeMs > STALE_TMP_MS) stale.push({ name, mtimeMs: stat.mtimeMs });
    }

    stale.sort((a, b) => a.mtimeMs - b.mtimeMs);
    await Promise.all(
      stale.slice(0, MAX_STALE_TMP_FILES).map(async ({ name }) => {
        /* v8 ignore start -- best-effort temp removal; .catch only fires if the temp vanished */
        await fs.unlink(path.join(dir, name)).catch(() => undefined);
        /* v8 ignore stop */
      }),
    );
  } catch {
    // best-effort cleanup must not block registry heartbeats
  }
}
