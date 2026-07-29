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
import * as path from 'node:path';
import type { SessionRegistryEntry } from './session-registry-types.js';
import { isPidAlive } from './utils/pid.js';

// A held lock is released within milliseconds; anything older is a crashed
// owner's leftover and is safe to break so writes never wedge permanently.
const STALE_LOCK_MS = 10_000;
/** Also the scan interval for {@link pruneStaleTempFiles} — see its caller. */
export const STALE_TMP_MS = 60_000;
const MAX_STALE_TMP_FILES = 20;

/**
 * Break a contended lock if it is stale: the recorded owner pid is no longer
 * alive, or the lock is older than {@link STALE_LOCK_MS}. Returns true when the
 * lock was removed (caller should retry acquisition). Best-effort and
 * race-tolerant — a fresh lock (age ~0, live owner) is never broken, so the
 * common concurrent case self-heals on the next heartbeat.
 */
export async function breakStaleLock(lockPath: string): Promise<boolean> {
  try {
    const [stat, content] = await Promise.all([
      fs.stat(lockPath),
      /* v8 ignore start -- best-effort lock-content read; .catch only fires if the lock vanished */
      fs.readFile(lockPath, 'utf8').catch(() => ''),
      /* v8 ignore stop */
    ]);
    const ageMs = Date.now() - stat.mtimeMs;
    const ownerPid = Number.parseInt(content.trim(), 10);
    const ownerDead =
      Number.isInteger(ownerPid) &&
      ownerPid > 0 &&
      ownerPid !== process.pid &&
      !isPidAlive(ownerPid);
    if (ownerDead || ageMs > STALE_LOCK_MS) {
      /* v8 ignore start -- best-effort stale-lock removal; .catch only fires if the lock vanished */
      await fs.unlink(lockPath).catch(() => undefined);
      /* v8 ignore stop */
      return true;
    }
    return false;
  } catch {
    // stat failed → the lock vanished underneath us; let the caller retry.
    /* v8 ignore next -- defensive: a vanished lock between stat and read is fine */
    return true;
  }
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

    stale.sort((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(
      stale.slice(MAX_STALE_TMP_FILES).map(async ({ name }) => {
        /* v8 ignore start -- best-effort temp removal; .catch only fires if the temp vanished */
        await fs.unlink(path.join(dir, name)).catch(() => undefined);
        /* v8 ignore stop */
      }),
    );
  } catch {
    // best-effort cleanup must not block registry heartbeats
  }
}
