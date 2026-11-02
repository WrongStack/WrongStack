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
        'or release it there with `wstack sage service use local` (or `wrongmemory project detach <id>`).',
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

/**
 * Durable record, written by WrongMemory next to a store it adopted for
 * writing and removed only when the project is detached. Unlike the owner
 * lock it survives the daemon: a store with a marker belongs to WrongMemory
 * even while no daemon runs, and is reached through it (on demand), never
 * opened locally.
 */
export const WRONGMEMORY_ADOPTION_MARKER_FILE = 'wrongmemory-adopted.json';

export interface WrongMemoryAdoptionMarker {
  projectId?: string | undefined;
  dataRoot?: string | undefined;
}

/** The adoption marker in `storeDir`, or `undefined` when WrongMemory has not adopted it. */
export function readWrongMemoryAdoptionMarker(
  storeDir: string,
): WrongMemoryAdoptionMarker | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(storeDir, WRONGMEMORY_ADOPTION_MARKER_FILE), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Present but unreadable still marks the store as adopted.
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? {} : undefined;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    // WrongMemory writes the marker atomically: damaged content is still a marker.
    return {};
  }
  // A marker declares its schema; other JSON in this file is not one.
  const m = v as { schemaVersion?: unknown; projectId?: unknown; dataRoot?: unknown } | null;
  if (typeof m?.schemaVersion !== 'number') return undefined;
  return {
    projectId: typeof m.projectId === 'string' ? m.projectId : undefined,
    dataRoot: typeof m.dataRoot === 'string' && m.dataRoot ? m.dataRoot : undefined,
  };
}

/**
 * Whether WrongMemory owns the store in `storeDir`: it carries an adoption
 * marker, or a live WrongMemory owner holds its lock.
 */
export function wrongMemoryOwnsStore(
  storeDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (readWrongMemoryAdoptionMarker(storeDir)) return true;
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
