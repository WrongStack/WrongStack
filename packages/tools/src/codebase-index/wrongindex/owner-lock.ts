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
 * (sharing violation, reported as EBUSY/EPERM/EACCES). Elsewhere Node has no
 * `flock`, so a live owner process recorded next to an existing lock counts.
 */
export function isOwnedByWrongIndex(indexDir: string): boolean {
  const lock = path.join(indexDir, OWNER_LOCK_FILE);
  if (process.platform === 'win32') {
    let fd: number;
    try {
      fd = fs.openSync(lock, 'r');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    }
    fs.closeSync(fd);
    return false;
  }
  if (!fs.existsSync(lock)) return false;
  const owner = readWrongIndexOwner(indexDir);
  return typeof owner?.pid === 'number' && owner.pid > 0 && pidAlive(owner.pid);
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
