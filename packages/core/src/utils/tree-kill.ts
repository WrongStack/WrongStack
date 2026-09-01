import { spawn } from 'node:child_process';
import { buildChildEnv } from './child-env.js';

/**
 * Minimal shape shared by Node's `ChildProcess` and lighter child wrappers.
 * `ChildProcess.kill` returns boolean; a no-arg `kill(): void` is assignable to
 * this wider signature, so callers can pass either.
 */
export interface KillableChild {
  readonly pid?: number | undefined;
  /** Non-null once Node has observed that the child exited. */
  readonly exitCode?: number | null | undefined;
  kill(signal?: NodeJS.Signals | number): boolean | void;
}

export interface TreeKillOptions {
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
 * Kill a spawned process AND its descendants.
 *
 * On Windows a tool launched through a `.cmd` / cmd.exe shim (npx→node, uvx,
 * pnpm, a language server, …) is a grandchild of the tracked `cmd.exe` wrapper,
 * so a bare `child.kill()` signals only the wrapper and orphans the real
 * process, which then accumulates across every close/restart/idle-sleep.
 * `taskkill /T /F` tears down the whole tree, with a direct kill as the
 * fallback when spawning taskkill fails.
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
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        // H-8 convention (spawn-convention test): taskkill needs PATH only —
        // do not hand it the credential-bearing parent environment.
        env: buildChildEnv(),
        windowsHide: true,
      });
      killer.once('error', directKill);
      killer.unref();
    } catch {
      directKill();
    }
    return;
  }

  if (force) {
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
