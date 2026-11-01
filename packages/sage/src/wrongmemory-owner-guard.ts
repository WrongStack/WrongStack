/**
 * WM-107: SAGE honors the WrongMemory owner guard.
 *
 * A WrongMemory daemon that owns a project-local store for writing holds an
 * OS-level exclusive lock on `<store-dir>/wrongmemory-owner.lock` for as long
 * as its writable handle is open. An unmodified SAGE ignored that lock, so a
 * WrongStack in `local` mode could open the same `sage.db` as a second
 * writer. SAGE now checks the guard before opening its store and refuses
 * while a WrongMemory owner holds it: set `Sage.service.mode` to
 * `wrongmemory` (or `auto`) to use the service, or release the store there
 * (`wrongmemory project detach <id>`) to hand it back.
 *
 * On Windows the lock is a whole-file `LockFileEx`, so reading the file fails
 * while it is held (`EBUSY`/`EPERM`) and succeeds once it is released. Where
 * locks are advisory, the diagnostic `pid` in the file is checked for
 * liveness instead (conservative: a live pid counts as an owner).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const WRONGMEMORY_OWNER_LOCK_FILE = 'wrongmemory-owner.lock';

export class SageStoreOwnedByWrongMemoryError extends Error {
  readonly code = 'SAGE_STORE_OWNED_BY_WRONGMEMORY' as const;
  constructor(readonly storeDir: string) {
    super(
      `The SAGE store in ${storeDir} is owned by the WrongMemory service; WrongStack will not open it as a second writer. ` +
        'Set Sage.service.mode to "wrongmemory" (or "auto") to use it through the service, ' +
        'or release it there with `wrongmemory project detach <id>`.',
    );
    this.name = 'SageStoreOwnedByWrongMemoryError';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a live WrongMemory owner holds the store in `storeDir`. */
export function wrongMemoryOwnsStore(
  storeDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const lock = path.join(storeDir, WRONGMEMORY_OWNER_LOCK_FILE);
  let content: string;
  try {
    content = fs.readFileSync(lock, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    // Held: the owner's exclusive lock refuses the read.
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
  }
  if (platform === 'win32') return false; // readable = released
  try {
    const pid = (JSON.parse(content.trim().split('\n')[0] ?? '{}') as { pid?: unknown }).pid;
    return typeof pid === 'number' && pid !== process.pid && pidAlive(pid);
  } catch {
    return false;
  }
}

/** Throw {@link SageStoreOwnedByWrongMemoryError} when WrongMemory owns the store. */
export function assertStoreNotOwnedByWrongMemory(storeDir: string): void {
  if (wrongMemoryOwnsStore(storeDir)) throw new SageStoreOwnedByWrongMemoryError(storeDir);
}
