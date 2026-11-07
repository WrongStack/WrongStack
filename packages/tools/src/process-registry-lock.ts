import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/persistence';

// A registry lock is only ever held for a brief read-modify-write; one older
// than this means the holder crashed. This is the ONLY stale signal on
// Windows, where process.kill(pid, 0) liveness checks are unreliable.
const LOCK_STALE_MS = 30_000;

export interface PersistentProcessEntry {
  pid: number;
  name: string;
  command: string;
  startedAt: number;
  lastHeartbeat: number;
  sessionId?: string;
  instanceId: string;
  /** Hostname where this process is running */
  hostname: string;
  protected: boolean;
  /** How this process was spawned: 'fork' (child_process.fork), 'spawn' (child_process.spawn), 'main' (the main WrongStack process itself) */
  spawnMode: 'fork' | 'spawn' | 'main';
  /** Parent PID if spawned via fork/spawn */
  parentPid?: number;
  /** OS platform where this entry was created */
  platform: string;
}

export interface PersistentRegistryData {
  version: 1;
  instances: Map<string, PersistentProcessEntry>;
  protectedPatterns: string[];
  lastCleanup: number;
}

/**
 * Map key for one entry. PIDs are host-local, so the same number on two
 * machines is two different processes: keying by the PID alone let a foreign
 * entry answer a local kill-protection query and let one host's heartbeat
 * overwrite another's entry on a shared home directory. A legacy entry with no
 * hostname is assumed to be local, preserving protection after an upgrade.
 */
export function registryEntryKey(hostname: string | undefined, pid: number): string {
  const host = typeof hostname === 'string' && hostname.length > 0 ? hostname : os.hostname();
  return `${host}:${pid}`;
}

/**
 * Acquire a file lock using flock-style locking.
 * On Windows, uses a separate lockfile with atomic rename.
 */
export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

/**
 * Remove the lock only when the file captured is still the one judged stale.
 * `unlink(path)` after the re-read raced a second stealer that removed the stale
 * lock and created a fresh one in between, deleting a LIVE lock. Renaming
 * captures exactly one file; a live lock caught that way is linked back (the
 * breakStaleLock contract of withFileLock in @wrongstack/persistence).
 */
async function breakStaleLock(lockfilePath: string, staleContent: string): Promise<void> {
  const grave = `${lockfilePath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await fs.rename(lockfilePath, grave);
  } catch {
    return;
  }
  const captured = await fs.readFile(grave, 'utf-8').catch(() => undefined);
  if (captured !== staleContent) await fs.link(grave, lockfilePath).catch(() => undefined);
  await fs.unlink(grave).catch(() => undefined);
}

export async function acquireLock(
  lockfilePath: string,
  timeoutMs = 5000,
): Promise<() => Promise<void>> {
  const start = Date.now();
  const pidStr = String(process.pid);
  const hostStr = os.hostname();

  // Ensure the parent directory exists. The registry creates it
  // fire-and-forget at construction, so on fast runners the first
  // acquireLock can race ahead of that mkdir and hit ENOENT (seen on
  // Linux CI in bash-kill-guard-paths). The writeFile below produces
  // the authoritative error if creation genuinely fails.
  try {
    await fs.mkdir(path.dirname(lockfilePath), { recursive: true });
  } catch {
    // fall through — the loop's writeFile will surface real failures
  }

  while (Date.now() - start < timeoutMs) {
    try {
      // Try to create the lock file exclusively. Remember the exact content
      // this acquisition wrote: the release closure below may only remove the
      // lock while it is still OURS. If a holder stalls past LOCK_STALE_MS,
      // another instance steals the lock and replaces the file; blindly
      // unlinking on release would delete the NEW holder's lock and admit a
      // third writer into the section (same RACE-002/S7 contract as
      // withFileLock in @wrongstack/persistence).
      // A nonce keeps two acquisitions in one process within the same
      // millisecond from minting identical tokens — otherwise a stalled
      // holder's release would still recognise a stealer's lock as its own.
      // The timestamp stays LAST: the stale check reads the final field.
      const token = `${pidStr}:${hostStr}:${randomBytes(4).toString('hex')}:${Date.now()}`;
      await fs.writeFile(lockfilePath, token, { flag: 'wx' });
      return async () => {
        // A concurrent breakStaleLock renames a live lock aside for two fs
        // calls before linking it back; a release in that window reads ENOENT
        // and would leave the lock orphaned until LOCK_STALE_MS. Look again.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const current = await fs.readFile(lockfilePath, 'utf-8');
            if (current !== token) return;
            await fs.unlink(lockfilePath);
            return;
          } catch (err) {
            // Gone for good (stolen or cleaned up) — nothing to release.
            if (!isNodeError(err) || err.code !== 'ENOENT' || attempt === 4) return;
            await new Promise((r) => setTimeout(r, 10));
          }
        }
      };
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') {
        // Lock exists - decide whether it is stale and stealable.
        try {
          const content = await fs.readFile(lockfilePath, 'utf-8');
          const parts = content.split(':');
          const lockPid = parseInt(parts[0] ?? '0', 10);
          // Content is `pid:host:timestamp`; the last field is the
          // acquisition time (host is never empty, so index is safe).
          // A lock with no readable timestamp is a holder between writeFile's
          // exclusive create and its write (`Number('')` is 0, which read as
          // decades old and was stolen on sight) or one that crashed there.
          // Age it by the file's mtime instead, so only the crashed one goes.
          const tokenTs = Number(parts[parts.length - 1]);
          const lockTs =
            Number.isFinite(tokenTs) && tokenTs > 0
              ? tokenTs
              : (await fs.stat(lockfilePath)).mtimeMs;
          const staleByAge = Date.now() - lockTs > LOCK_STALE_MS;

          let holderDead = false;
          if (process.platform !== 'win32' && Number.isFinite(lockPid) && lockPid > 0) {
            try {
              process.kill(lockPid, 0); // Signal 0 just checks if process exists
            } catch {
              holderDead = true;
            }
          }

          // Steal when the holder is provably dead (Unix) OR the lock is older
          // than LOCK_STALE_MS. The age check is the only stale signal on
          // Windows — without it a crashed holder's lock wedges the registry,
          // and with it every kill-guard, permanently.
          if (holderDead || staleByAge) {
            // Re-read right before removing. Between our read and this unlink
            // another stealer may already have removed the stale lock and
            // become the fresh holder; unlinking now would destroy THAT
            // holder's live lock and put two writers in the section. Only
            // steal while the file still holds exactly the stale content we
            // observed (same recheck discipline as withFileLock in
            // @wrongstack/persistence).
            const recheck = await fs.readFile(lockfilePath, 'utf-8').catch(() => undefined);
            if (recheck === content) await breakStaleLock(lockfilePath, content);
            continue;
          }
        } catch {
          // The lock EXISTS (EEXIST above) but cannot be read right now. An
          // unreadable lock is more plausibly a LIVE one under a transient
          // sharing violation (AV scan, indexer) than a stale one — and the
          // age check above is, per this file's own contract, the ONLY stale
          // signal on Windows. Unlinking here admitted a second writer into
          // the section beside the real holder. Fail closed instead: wait and
          // retry; a genuinely stale lock becomes stealable once readable,
          // and the acquisition timeout fails closed otherwise.
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }

        // Holder still alive and lock fresh — wait before retrying
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to acquire lock after ${timeoutMs}ms`);
}

/**
 * Read and parse the persistent registry file.
 * Returns empty data if the file is missing, corrupted, or structurally wrong.
 */
function freshRegistryData(): PersistentRegistryData {
  return {
    version: 1,
    instances: new Map(),
    protectedPatterns: ['wrongstack', 'node'],
    lastCleanup: Date.now(),
  };
}

function isPersistentProcessEntry(val: unknown): val is PersistentProcessEntry {
  if (!val || typeof val !== 'object') return false;
  const e = val as Record<string, unknown>;
  return (
    typeof e.pid === 'number' &&
    Number.isFinite(e.pid) &&
    typeof e.name === 'string' &&
    typeof e.instanceId === 'string' &&
    typeof e.lastHeartbeat === 'number' &&
    Number.isFinite(e.lastHeartbeat)
  );
}

export async function readRegistryFile(filePath: string): Promise<PersistentRegistryData> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return freshRegistryData();
    throw err; // genuine IO error (EACCES, EMFILE…) — surface it
  }

  // A torn write (crash mid-persist) or hand-corruption must NOT throw here:
  // that would propagate through every kill-guard and wedge them forever with
  // no self-heal. Parse defensively and fall back to empty; the next write
  // overwrites the bad file.
  try {
    const parsed = JSON.parse(content) as Partial<PersistentRegistryData> & {
      instances?: unknown;
    };
    if (!parsed || typeof parsed !== 'object') return freshRegistryData();
    const base = freshRegistryData();
    const instances = new Map<string, PersistentProcessEntry>();
    if (Array.isArray(parsed.instances)) {
      for (const item of parsed.instances) {
        if (
          Array.isArray(item) &&
          item.length >= 2 &&
          (typeof item[0] === 'string' || typeof item[0] === 'number') &&
          isPersistentProcessEntry(item[1])
        ) {
          instances.set(registryEntryKey(item[1].hostname, item[1].pid), item[1]);
        }
      }
    }
    const protectedPatterns = Array.isArray(parsed.protectedPatterns)
      ? parsed.protectedPatterns.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : base.protectedPatterns;
    return {
      version: 1,
      instances,
      protectedPatterns,
      lastCleanup: typeof parsed.lastCleanup === 'number' ? parsed.lastCleanup : base.lastCleanup,
    };
  } catch {
    return freshRegistryData();
  }
}

/**
 * Write the registry file through the shared atomic persistence primitive.
 * Its Windows rename path retries transient sharing violations while leaving
 * the previous registry untouched if the bounded retries are exhausted.
 */
export async function writeRegistryFile(
  filePath: string,
  data: PersistentRegistryData,
): Promise<void> {
  const content = JSON.stringify(
    data,
    (_k, v) => {
      if (v instanceof Map) {
        return Array.from(v.entries());
      }
      return v;
    },
    2,
  );

  await atomicWrite(filePath, content);
}
