/**
 * Detects an index held by the WrongIndex service.
 *
 * WrongIndex marks ownership of an index directory with
 * `<indexDir>/.wrongindex-owner.lock`, held open for as long as the owner
 * lives: without sharing on Windows, under `flock(LOCK_EX)` elsewhere. The OS
 * releases it when the owner exits or crashes. `.wrongindex-owner.json` beside
 * it is descriptive only and never trusted as the lock.
 *
 * WrongStack must not write (or migrate) an index another process owns, so
 * every local writer and every direct store consults this before opening the
 * database read-write.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const OWNER_LOCK_FILE = '.wrongindex-owner.lock';
export const OWNER_INFO_FILE = '.wrongindex-owner.json';

export interface WrongIndexOwnerInfo {
  owner?: string;
  instanceId?: string;
  pid?: number;
  epoch?: number;
  acquiredAtMs?: number;
}

/** Private supervisor-to-child request data, never a global environment bypass. */
export interface WrongIndexWriteDelegation {
  instanceId: string;
  pid: number;
  epoch: number;
}

const delegatedWrite = new AsyncLocalStorage<{
  indexDir: string;
  owner: WrongIndexWriteDelegation;
  active: boolean;
}>();

function canonicalIndexDir(indexDir: string): string {
  const resolved = fs.realpathSync.native(indexDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validDelegation(indexDir: string, expected: WrongIndexWriteDelegation): boolean {
  const actual = readWrongIndexOwner(indexDir);
  return (
    Number.isSafeInteger(expected.pid) &&
    expected.pid > 0 &&
    process.ppid === expected.pid &&
    Number.isSafeInteger(expected.epoch) &&
    expected.epoch > 0 &&
    typeof expected.instanceId === 'string' &&
    expected.instanceId.length > 0 &&
    actual?.pid === expected.pid &&
    actual.epoch === expected.epoch &&
    actual.instanceId === expected.instanceId &&
    isOwnedByWrongIndex(indexDir)
  );
}

/**
 * Run a supervised worker's single write while its parent keeps the OS lock.
 * The daemon validates the job fence and retains its run guard throughout.
 * A descriptive owner file alone never grants permission: the live lock,
 * direct parent PID, exact directory, instance and epoch must all match.
 * Async descendants lose permission when this call ends, including on error.
 * This is a cooperative writer protocol, not a sandbox against same-user code
 * that ignores the writer API and opens SQLite itself.
 */
export async function withWrongIndexWriteDelegation<T>(
  indexDir: string,
  owner: WrongIndexWriteDelegation,
  action: () => Promise<T>,
): Promise<T> {
  if (!owner || !validDelegation(indexDir, owner)) throw new IndexOwnedExternallyError(indexDir);
  const scope = { indexDir: canonicalIndexDir(indexDir), owner: { ...owner }, active: true };
  return delegatedWrite.run(scope, async () => {
    try {
      return await action();
    } finally {
      scope.active = false;
    }
  });
}

/** Write admission only; ownership detection itself always reports the owner. */
export function isWrongIndexWriteBlocked(indexDir: string): boolean {
  if (!isOwnedByWrongIndex(indexDir)) return false;
  const scope = delegatedWrite.getStore();
  if (!scope?.active) return true;
  try {
    return (
      canonicalIndexDir(indexDir) !== scope.indexDir || !validDelegation(indexDir, scope.owner)
    );
  } catch {
    return true;
  }
}

/** The descriptive owner record, when readable. */
export function readWrongIndexOwner(indexDir: string): WrongIndexOwnerInfo | null {
  try {
    const raw = fs.readFileSync(path.join(indexDir, OWNER_INFO_FILE), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as WrongIndexOwnerInfo) : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether WrongIndex currently owns the index in `indexDir`.
 *
 * Windows: the lock file cannot be opened while the owner holds it
 * (sharing violation, reported as EBUSY/EPERM/EACCES); a lock file left by a
 * service that is gone opens fine and does not count. Elsewhere Node has no
 * `flock`: a live `wrongindexd` process recorded next to the lock counts.
 * WrongStack's own engine must keep working without WrongIndex, so anything
 * short of a live owner is "not owned".
 */
export function isOwnedByWrongIndex(indexDir: string): boolean {
  const lock = path.join(indexDir, OWNER_LOCK_FILE);
  if (process.platform === 'win32') {
    // A stale lock file (service gone, uninstalled) opens fine: not owned.
    // A sharing violation is retried once, so a scanner holding the file
    // for a moment is not mistaken for the service.
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd: number;
      try {
        fd = fs.openSync(lock, 'r');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') return false;
        if (attempt === 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          continue;
        }
        return true;
      }
      fs.closeSync(fd);
      return false;
    }
    return false;
  }
  // Elsewhere Node cannot test the owner's flock. Count the index as owned
  // only when the recorded owner is a live WrongIndex service process, so a
  // stale lock whose pid was reused never blocks WrongStack's own engine.
  if (!fs.existsSync(lock)) return false;
  const owner = readWrongIndexOwner(indexDir);
  if (typeof owner?.pid !== 'number' || owner.pid <= 0 || !pidAlive(owner.pid)) return false;
  try {
    return fs.readFileSync(`/proc/${owner.pid}/comm`, 'utf8').trim().startsWith('wrongindexd');
  } catch {
    // No /proc (macOS): the WrongIndex service does not run there yet.
    return false;
  }
}

/** Raised when a local write would touch an index WrongIndex owns. */
export class IndexOwnedExternallyError extends Error {
  constructor(indexDir: string) {
    const owner = readWrongIndexOwner(indexDir);
    super(
      `The codebase index in ${indexDir} is owned by the WrongIndex service` +
        (owner?.pid ? ` (pid ${owner.pid})` : '') +
        '; WrongStack will not write it locally. Set indexing.service to "auto" or ' +
        '"wrongindex" to use the service, or release ownership in WrongIndex.',
    );
    this.name = 'IndexOwnedExternallyError';
  }
}
