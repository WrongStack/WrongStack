/**
 * spawn-background — platform-independent background process spawning.
 *
 * Provides truly fire-and-forget background process execution that:
 *   - Works consistently on Windows and POSIX
 *   - Does not block the parent Node.js event loop
 *   - Creates a fully independent child process (new process group/session)
 *   - Does NOT register with the ProcessRegistry (fire-and-forget)
 *   - Does NOT affect the circuit breaker
 *
 * POSIX: Uses setsid() (detached: true) to create a new session, fully
 *        detaching from the parent's process group. The child becomes a
 *        daemon-like process.
 *
 * Windows: detached: false + windowsHide: true (CREATE_NO_WINDOW). This is
 *          deliberate: CreateProcess IGNORES CREATE_NO_WINDOW when combined
 *          with DETACHED_PROCESS (which detached: true sets), so a detached
 *          cmd.exe runs console-less and its console-app *grandchildren*
 *          (node, etc.) each allocate a fresh VISIBLE console window.
 *          CREATE_NO_WINDOW instead gives the child a hidden console that
 *          grandchildren inherit — no window ever appears. Windows children
 *          survive parent exit regardless of detached, and the hidden
 *          console also isolates them from the terminal's Ctrl+C, so
 *          nothing is lost by dropping DETACHED_PROCESS.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { buildChildEnv } from '@wrongstack/core/utils';
import * as os from 'node:os';
import { buildWin32CmdShimInvocation, resolveWin32Command } from './_win32-resolve.js';

const isWin = os.platform() === 'win32';

interface SpawnBackgroundOptions {
  /**
   * Shell command string to execute (e.g. `"node --version"`, `"npm run dev"`).
   *
   * ⚠️ SECURITY: This value is passed verbatim to the system shell
   * (`/bin/bash -c` on POSIX, `cmd.exe /c` on Windows). Shell metacharacters
   * (`;`, `&&`, `|`, `$()`, backticks, etc.) ARE interpreted. Never pass
   * untrusted or user-controlled input here — use {@link spawnBackgroundExec}
   * instead, which spawns a command + args array with no shell interpretation.
   */
  command: string;
  /** Arguments (for exec-style commands) */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Shell to use (default: system default) */
  shell?: string;
}

/**
 * Spawn a fully detached background process **via the system shell**.
 *
 * ⚠️ SECURITY: `opts.command` is interpreted by `/bin/bash -c` (POSIX) or
 * `cmd.exe /c` (Windows). This is an explicit shell-exec sink. If
 * `opts.command` contains untrusted or user-influenced input, it is a direct
 * command-injection vector. For untrusted input use {@link spawnBackgroundExec},
 * which takes a command + args array and never invokes a shell.
 *
 * @returns The spawned ChildProcess (already unref'd so it doesn't block exit)
 */
export function spawnBackground(opts: SpawnBackgroundOptions): {
  pid: number | null;
  child: ReturnType<typeof spawn>;
} {
  // Determine shell and args
  const shell = opts.shell ?? (isWin ? (process.env['COMSPEC'] ?? 'cmd.exe') : '/bin/bash');
  const shellArgs = isWin ? ['/c', opts.command] : ['-c', opts.command];

  // Platform-specific spawn options for maximum detachment.
  // win32 must NOT set detached: DETACHED_PROCESS makes Windows ignore
  // CREATE_NO_WINDOW, and the console-less cmd.exe's grandchildren then pop
  // visible console windows (see module doc).
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd ?? process.cwd(),
    env: buildChildEnv({ extra: opts.env }),
    stdio: 'ignore',
    detached: !isWin, // POSIX: setsid()
    windowsHide: true,
  };

  // On POSIX, the shell itself is spawned as the detached process leader.
  // The actual command runs as a child of that shell. This is fine for
  // fire-and-forget execution.
  const child = spawn(shell, shellArgs, spawnOpts);

  // Fire-and-forget: an unhandled 'error' event (e.g. ENOENT) would crash the
  // host process. Callers can still attach their own listener on `child`.
  child.on('error', (err) => {
    // ENOENT / EACCES on the binary itself is expected for missing commands;
    // don't crash the parent — just log at debug level.
    console.log(
      JSON.stringify({
        level: 'debug',
        event: 'spawn_error',
        cmd: opts.command,
        error: err.message,
      }),
    );
  });

  // Unref immediately so the parent can exit even if the child is still running
  child.unref();

  return {
    pid: child.pid ?? null,
    child,
  };
}

/**
 * Spawn a command (exec-style, no shell) as a detached background process.
 * This is more secure than {@link spawnBackground} since there are no shell
 * injection risks — args are passed as an argv array, never through a shell.
 *
 * On Windows, `.cmd`/`.bat` wrappers are launched through `cmd.exe` directly
 * because CreateProcess cannot run them natively. The shim helper rejects any
 * argument containing a cmd.exe injection metacharacter
 * (`& | < >` or newline) — the same guard used by exec.ts, _spawn-stream.ts,
 * and outdated.ts. Safe args pass through unchanged.
 *
 * @returns The spawned ChildProcess (already unref'd so it doesn't block exit)
 */
export function spawnBackgroundExec(
  command: string,
  args: string[] = [],
  cwd?: string,
  env?: Record<string, string>,
): {
  pid: number | null;
  child: ReturnType<typeof spawn>;
} {
  // Resolve .cmd/.bat on Windows. The resolver also finds the full path for
  // .exe binaries so spawn doesn't need PATHEXT.
  const resolved = resolveWin32Command(command);
  const needsShell = isWin && (resolved.endsWith('.cmd') || resolved.endsWith('.bat'));
  const shim = needsShell ? buildWin32CmdShimInvocation(resolved, args) : null;
  const cmd = shim?.command ?? resolved;
  const spawnArgs = shim?.args ?? args;

  // Same win32 rule as spawnBackground: detached + windowsHide conflict, and
  // the hidden console from CREATE_NO_WINDOW is what keeps any children of
  // the spawned command windowless.
  const spawnOpts: SpawnOptions = {
    cwd: cwd ?? process.cwd(),
    env: buildChildEnv({ extra: env }),
    stdio: 'ignore',
    detached: !isWin,
    windowsHide: true,
    ...(shim ? { windowsVerbatimArguments: shim.windowsVerbatimArguments } : {}),
  };

  const child = spawn(cmd, spawnArgs, spawnOpts);

  // Fire-and-forget: an unhandled 'error' event (e.g. ENOENT) would crash the
  // host process. Callers can still attach their own listener on `child`.
  child.on('error', (err) => {
    // ENOENT / EACCES on the binary itself is expected for missing commands;
    // don't crash the parent — just log at debug level.
    console.log(
      JSON.stringify({ level: 'debug', event: 'spawn_error', cmd: command, error: err.message }),
    );
  });

  // Unref immediately so the parent can exit even if the child is still running
  child.unref();

  return {
    pid: child.pid ?? null,
    child,
  };
}

// Re-export types
export type { ChildProcess } from 'node:child_process';
