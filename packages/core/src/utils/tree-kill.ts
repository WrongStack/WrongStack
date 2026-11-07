import { spawn } from 'node:child_process';
import { buildChildEnv } from './child-env.js';
import {
  terminateWin32Descendants,
  WIN32_NATIVE_CLEANUP_TIMEOUT_MS,
} from './win32-process-tree.js';

export { terminateWin32Descendants } from './win32-process-tree.js';

/**
 * Minimal shape shared by Node's `ChildProcess` and lighter child wrappers.
 * `ChildProcess.kill` returns boolean; a no-arg `kill(): void` is assignable to
 * this wider signature, so callers can pass either.
 */
export interface KillableChild {
  readonly pid?: number | undefined;
  /** Non-null once Node has observed that the child exited. */
  readonly exitCode?: number | null | undefined;
  /** Non-null once Node has observed that the child was ended by a signal. */
  readonly signalCode?: NodeJS.Signals | null | undefined;
  kill(signal?: NodeJS.Signals | number): boolean | void;
}

export interface TreeKillOptions {
  /**
   * With force=true on POSIX, kill the dedicated group led by this child.
   * Opt in only for a child spawned with detached=true; never for an arbitrary PID.
   */
  processGroupLeader?: boolean | undefined;
  /**
   * Skip the graceful SIGTERM and go straight to SIGKILL on POSIX. Windows
   * always uses `taskkill /T /F` regardless (there is no graceful signal for a
   * process tree there). Use this for a force-escalation step invoked after a
   * graceful close has already timed out. Default false.
   */
  force?: boolean | undefined;
  /**
   * POSIX graceful mode only: delay in ms before the SIGKILL backstop fires
   * after the initial SIGTERM. Default 2000.
   */
  graceMs?: number | undefined;
}

/**
 * Bound a stalled taskkill without interrupting a legitimate Windows tree walk.
 * Real /T enumeration can exceed eight seconds; killing its shell at five
 * seconds breaks the parent chain before descendants have been collected.
 * Successful taskkill completion still settles immediately.
 */
export const WIN32_TASKKILL_BACKSTOP_MS = 30_000;
/** Complete Windows stop budget: taskkill plus its bounded native fallback. */
export const WIN32_TREE_KILL_BUDGET_MS =
  WIN32_TASKKILL_BACKSTOP_MS + WIN32_NATIVE_CLEANUP_TIMEOUT_MS;

/** The parts of a spawned taskkill process the backstop listens to. */
export interface TaskkillHandle {
  once(event: 'error' | 'close', listener: () => void): unknown;
  unref(): void;
}

/**
 * Chain a direct kill after taskkill, for when taskkill leaves the child alive.
 *
 * taskkill can exit non-zero (a race inside its tree walk, access denied) or
 * stall for seconds on a loaded host; firing it and forgetting it left the
 * child running until it exited on its own. The direct kill waits for taskkill
 * to settle, or for {@link WIN32_TASKKILL_BACKSTOP_MS}, because killing the
 * root first breaks taskkill's parent-pid walk and orphans grandchildren.
 * `child.kill()` signals through the process handle, never a recycled PID.
 */
export function settleWin32Kill(
  killer: TaskkillHandle,
  child: KillableChild,
  directKill: () => void,
  backstopMs = WIN32_TASKKILL_BACKSTOP_MS,
): void {
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (child.exitCode != null || child.signalCode != null) return;
    terminateWin32Descendants(child);
    directKill();
  };
  const timer = setTimeout(settle, backstopMs);
  timer.unref?.();
  killer.once('error', settle);
  killer.once('close', settle);
  killer.unref();
}

/**
 * Kill a spawned process AND its descendants.
 *
 * On Windows a tool launched through a `.cmd` / cmd.exe shim (npx→node, uvx,
 * pnpm, a language server, …) is a grandchild of the tracked `cmd.exe` wrapper,
 * so a bare `child.kill()` signals only the wrapper and orphans the real
 * process, which then accumulates across every close/restart/idle-sleep.
 * `taskkill /T /F` tears down the whole tree, with a direct kill as the
 * fallback when spawning taskkill fails or it leaves the child alive.
 *
 * POSIX sends SIGTERM then a SIGKILL backstop (graceful — the default), or
 * SIGKILL immediately when `force` is set.
 *
 * Accepts a minimal {@link KillableChild} so it works with both full
 * `ChildProcess` objects and lighter wrappers whose `kill()` takes no argument.
 */
export function treeKill(child: KillableChild, opts: TreeKillOptions = {}): void {
  const force = opts.force ?? false;
  const directKill = (): void => {
    try {
      child.kill(force ? 'SIGKILL' : undefined);
    } catch {
      /* already gone */
    }
  };

  if (child.pid === undefined) {
    directKill();
    return;
  }

  if (process.platform === 'win32') {
    // Same stale-PID rule as the POSIX backstop: once Node has observed the
    // exit (a code, or a signal after an earlier kill), `taskkill /T /F` by
    // that PID may hit an unrelated process tree.
    if (child.exitCode != null || child.signalCode != null) return;
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        // H-8 convention (spawn-convention test): taskkill needs PATH only —
        // do not hand it the credential-bearing parent environment.
        env: buildChildEnv(),
        windowsHide: true,
      });
      settleWin32Kill(killer, child, directKill);
    } catch {
      directKill();
    }
    return;
  }

  if (force) {
    const pid = child.pid;
    if (
      opts.processGroupLeader === true &&
      child.exitCode == null &&
      child.signalCode == null &&
      Number.isInteger(pid) &&
      pid > 1 &&
      pid !== process.pid &&
      pid !== process.ppid
    ) {
      try {
        process.kill(-pid, 'SIGKILL');
        return;
      } catch {
        // The dedicated group is gone; the child handle remains safe to signal.
      }
    }
    directKill();
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    // Do not signal by a stale PID after Node has observed the child exit. On a
    // busy host that PID may already belong to an unrelated process.
    if (child.exitCode !== undefined && child.exitCode !== null) return;
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, opts.graceMs ?? 2000).unref();
}
