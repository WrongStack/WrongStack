/**
 * Ownership holds on managed checkouts that outlive the manager instance that
 * created them — today an isolated Goal's workspace. The handle-free sweeps
 * (`cleanupAllManaged`, `removeOne`) see every checkout under the managed root
 * and could not tell a crashed run's leftover from a live Goal running in this
 * or another process, so an SDD run's stale sweep deleted a running Goal's
 * checkout and its unmerged branch.
 *
 * A hold is two records, because both kinds of sweeper exist:
 *  - an in-process count, for a sweeper in the SAME process (a WebUI server
 *    runs Goals and SDD runs side by side), and
 *  - `<worktreesRoot>/.holds/<slug>.json` carrying the holder's pid, for a
 *    sweeper in ANOTHER process. A marker whose pid is gone is stale: a
 *    crashed holder never blocks cleanup for good.
 *
 * @module worktree/worktree-hold
 */
import * as fsp from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { atomicWrite, isPidAlive } from '@wrongstack/core/utils';

interface HoldMarker {
  pid: number;
  ownerId: string;
  at: string;
}

const inProcessHolds = new Map<string, number>();
const holdGenerations = new Map<string, number>();

function holdKey(dir: string): string {
  const abs = resolve(dir);
  return process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs;
}

function markerPath(worktreesRoot: string, dir: string): string {
  return join(resolve(worktreesRoot), '.holds', `${basename(resolve(dir))}.json`);
}

async function readMarker(file: string): Promise<HoldMarker | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<HoldMarker> | null;
    return parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.ownerId === 'string' &&
      parsed.ownerId.trim().length > 0
      ? (parsed as HoldMarker)
      : null;
  } catch {
    return null;
  }
}

/**
 * Hold `dir` (a checkout under `worktreesRoot`) for `ownerId` until the
 * returned release runs. Idempotent release; nested holds are counted.
 */
export async function holdManagedWorktree(
  worktreesRoot: string,
  dir: string,
  ownerId: string,
): Promise<() => Promise<void>> {
  const key = holdKey(dir);
  const gen = (holdGenerations.get(key) ?? 0) + 1;
  holdGenerations.set(key, gen);
  inProcessHolds.set(key, (inProcessHolds.get(key) ?? 0) + 1);
  const file = markerPath(worktreesRoot, dir);
  try {
    await fsp.mkdir(join(resolve(worktreesRoot), '.holds'), { recursive: true });
    const marker: HoldMarker = { pid: process.pid, ownerId, at: new Date().toISOString() };
    await atomicWrite(file, JSON.stringify(marker), { mode: 0o600 });
  } catch {
    // The in-process hold still protects same-process sweeps; a missing
    // marker only weakens the cross-process guard.
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const left = (inProcessHolds.get(key) ?? 1) - 1;
    if (left > 0) {
      inProcessHolds.set(key, left);
      return;
    }
    inProcessHolds.delete(key);
    const current = await readMarker(file);
    if ((inProcessHolds.get(key) ?? 0) > 0 || holdGenerations.get(key) !== gen) return;
    if (current?.pid === process.pid) await fsp.unlink(file).catch(() => undefined);
  };
}

/** True while some live holder — this process or another — owns `dir`. */
export async function isManagedWorktreeHeld(worktreesRoot: string, dir: string): Promise<boolean> {
  if ((inProcessHolds.get(holdKey(dir)) ?? 0) > 0) return true;
  const marker = await readMarker(markerPath(worktreesRoot, dir));
  // Our own pid without an in-process hold is a marker a release failed to
  // remove; another live pid is a real holder.
  return marker !== null && marker.pid !== process.pid && isPidAlive(marker.pid);
}
