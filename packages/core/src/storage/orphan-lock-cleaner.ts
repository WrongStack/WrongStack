import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isPidAlive } from '../utils/pid.js';
import { toErrorMessage } from '../utils/error.js';

export interface OrphanLockCleanResult {
  cleanedGitLocks: string[];
  cleanedWorktrees: string[];
  errors: string[];
}

/**
 * Sweeps stale WrongStack worktree lockfiles left after an ungraceful
 * crash (SIGKILL, power outage, OOM). Does not touch Git's own
 * `.git/index.lock` — age is not a liveness signal for that mutex.
 */
export async function cleanOrphanLocks(
  projectRoot: string,
  options?: {
    isPidAlive?: (pid: number) => boolean;
    maxLockAgeMs?: number;
  },
): Promise<OrphanLockCleanResult> {
  const result: OrphanLockCleanResult = {
    cleanedGitLocks: [],
    cleanedWorktrees: [],
    errors: [],
  };

  const pidAlive = options?.isPidAlive ?? isPidAlive;
  const maxAgeMs = options?.maxLockAgeMs ?? 10 * 60 * 1000; // 10 minutes default max age for stale locks
  const now = Date.now();

  // `.git/index.lock` is Git's writer mutex, not a WrongStack artifact.
  // Age is not liveness: a long `git add`/`gc`/LFS fetch, or a git
  // process in another terminal, can hold the lock past any timeout.
  // Unlinking it while Git still has the inode open (Unix) lets a
  // second writer start and corrupt the index. Only locks we created
  // (worktree `.lock` files with a recorded pid) are safe to sweep.

  // Stale .wrongstack/worktrees lockfiles left by dead subagent processes
  const worktreesDir = path.join(projectRoot, '.wrongstack', 'worktrees');
  try {
    const entries = await fsp.readdir(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wtPath = path.join(worktreesDir, entry.name);
      const lockPath = path.join(wtPath, '.lock');
      try {
        const lockStat = await fsp.stat(lockPath).catch(() => null);
        if (lockStat) {
          const raw = await fsp.readFile(lockPath, 'utf8').catch(() => '');
          const pid = parseInt(raw.trim(), 10);
          if (Number.isInteger(pid) && pid > 0) {
            if (!pidAlive(pid)) {
              // Owning process is dead, remove stale lock
              try {
                await fsp.unlink(lockPath);
                result.cleanedWorktrees.push(wtPath);
              } catch (unlinkErr) {
                result.errors.push(
                  `Failed removing stale lock ${lockPath}: ${toErrorMessage(unlinkErr)}`,
                );
              }
            }
          } else if (now - lockStat.mtimeMs > maxAgeMs) {
            try {
              await fsp.unlink(lockPath);
              result.cleanedWorktrees.push(wtPath);
            } catch (unlinkErr) {
              result.errors.push(
                `Failed removing expired lock ${lockPath}: ${toErrorMessage(unlinkErr)}`,
              );
            }
          }
        }
      } catch (err) {
        result.errors.push(`Failed inspecting worktree ${entry.name}: ${toErrorMessage(err)}`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.errors.push(`Failed reading worktrees dir: ${toErrorMessage(err)}`);
    }
  }

  return result;
}
