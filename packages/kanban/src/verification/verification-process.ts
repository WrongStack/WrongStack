import { type ChildProcess, spawn } from 'node:child_process';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { BoundedProcessOutput } from './command-security.js';

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** When true, the command was rejected by the security gate before execution. */
  rejected?: boolean | undefined;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

function armCappedTimeout(delayMs: number, onExpire: () => void): () => void {
  const safeDelay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
  const deadline = Date.now() + safeDelay;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = (remaining: number): void => {
    if (cancelled) return;
    if (timer) clearTimeout(timer);
    const chunk = Math.min(Math.max(0, remaining), MAX_TIMEOUT_MS);
    timer = setTimeout(() => {
      if (cancelled) return;
      const left = deadline - Date.now();
      if (left > 0) {
        arm(left);
        return;
      }
      onExpire();
    }, chunk);
    timer.unref?.();
  };
  arm(safeDelay);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

/** cmd.exe metacharacters — same set as core's `buildWin32CmdShimInvocation`. */
const WIN32_CMD_META = /[&|<>"%^\r\n\0]/;

/**
 * A Windows `.cmd` shim needs cmd.exe, but `spawn(..., { shell: true })` joins
 * command and args unquoted (DEP0190): a project path with a space split the
 * shim path and nothing ran. Quote every token behind `call`, as core's
 * `buildWin32CmdShimInvocation` does (kanban sits below core and cannot import
 * it). Tokens carrying cmd metacharacters are refused, never escaped.
 */
function win32CmdShimSpawn(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } | string {
  const bad = [command, ...args].find((token) => WIN32_CMD_META.test(token));
  if (bad !== undefined) {
    return `Refusing to run a .cmd shim with a cmd.exe metacharacter in ${JSON.stringify(bad)}.`;
  }
  const quote = (token: string) => `"${token.replace(/(\\+)$/, '$1$1')}"`;
  const line = ['call', quote(command), ...args.map(quote)].join(' ');
  return { command: process.env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/c', line] };
}

export class VerificationProcessRunner {
  constructor(readonly projectRoot: string) {}

  private terminateProcessTree(child: ChildProcess, detachedProcessGroup: boolean): void {
    const pid = child.pid;
    if (typeof pid === 'number' && process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        const forceKillChild = (): void => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The process already exited.
          }
        };
        killer.once('error', forceKillChild);
        killer.once('close', (code) => {
          if (code !== 0) forceKillChild();
        });
        killer.unref();
        return;
      } catch {
        // Fall through to direct termination.
      }
    }
    try {
      if (typeof pid === 'number' && detachedProcessGroup) {
        process.kill(-pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'verification_process_termination_failed',
            message: 'Unable to terminate the verification child process.',
            pid,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  async runGitCommand(
    args: string[],
    timeoutMs = 30_000,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ stdout: string; stderr: string }> {
    // The repository's config names programs status/diff/add run
    // (fsmonitor, `.gitattributes` filters); when they cannot be switched
    // off, git does not run.
    const isolation = await gitIsolationEnv(this.projectRoot, { baseEnv: env });
    if (!isolation) {
      throw new Error('git isolation unavailable: the repository config could not be read');
    }
    return new Promise((resolve, reject) => {
      const detachedProcessGroup = process.platform !== 'win32';
      const child = spawn('git', args, {
        cwd: this.projectRoot,
        env: { ...env, ...isolation },
        windowsHide: true,
        detached: detachedProcessGroup,
      });
      const stdout = new BoundedProcessOutput();
      const stderr = new BoundedProcessOutput();
      let settled = false;

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.append(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.append(chunk);
      });

      const cancelTimer = armCappedTimeout(timeoutMs, () => {
        if (settled) return;
        settled = true;
        this.terminateProcessTree(child, detachedProcessGroup);
        reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
      });

      child.on('close', (code) => {
        cancelTimer();
        if (settled) return;
        settled = true;
        if (code === 0) resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr.toString().slice(0, 500)}`));
      });
      child.on('error', (err) => {
        cancelTimer();
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  /**
   * Spawn a trusted local test runner with an argument array. This private
   * helper is never exposed as a model-selected executable surface.
   */
  async runProcess(
    command: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; shell?: boolean | undefined },
  ): Promise<CommandResult> {
    const start = Date.now();
    const displayCommand = [command, ...args].join(' ');
    const shim =
      opts.shell && process.platform === 'win32' ? win32CmdShimSpawn(command, args) : null;
    if (typeof shim === 'string') {
      return { command: displayCommand, exitCode: -1, stdout: '', stderr: shim, durationMs: 0 };
    }
    return new Promise<CommandResult>((resolve) => {
      const detachedProcessGroup = process.platform !== 'win32';
      let child: ChildProcess;
      try {
        child = shim
          ? spawn(shim.command, shim.args, {
              cwd: opts.cwd,
              windowsHide: true,
              windowsVerbatimArguments: true,
              detached: detachedProcessGroup,
            })
          : spawn(command, args, {
              cwd: opts.cwd,
              shell: opts.shell ?? false,
              windowsHide: true,
              detached: detachedProcessGroup,
            });
      } catch (error) {
        // Node validates spawn arguments synchronously (ERR_INVALID_ARG_VALUE,
        // e.g. a null byte in argv) before any 'error' event can fire, so this
        // throw cannot reach the structured handler below. Every failure mode
        // must resolve as a CommandResult: the only caller chain (runCommand →
        // CommandPlugin.verify → VerifierRegistry.verify → verifyTaskCompletion
        // Phase 2) has no try/catch, so a rejection here would crash the whole
        // verification run instead of failing one check — the same class of
        // malformed input runTest rejects structurally for null-byte patterns.
        return resolve({
          command: displayCommand,
          exitCode: -1,
          stdout: '',
          stderr: `--- spawn error: ${error instanceof Error ? error.message : String(error)} ---`,
          durationMs: Date.now() - start,
        });
      }
      const stdout = new BoundedProcessOutput();
      const stderr = new BoundedProcessOutput();
      let timedOut = false;
      let settled = false;

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.append(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.append(chunk);
      });

      let cancelTimer: (() => void) | undefined;
      const finish = (exitCode: number, suffix = ''): void => {
        if (settled) return;
        settled = true;
        cancelTimer?.();
        resolve({
          command: displayCommand,
          exitCode,
          stdout: stdout.toString(),
          stderr: `${stderr.toString()}${suffix}`,
          durationMs: Date.now() - start,
        });
      };

      cancelTimer = armCappedTimeout(opts.timeoutMs, () => {
        timedOut = true;
        this.terminateProcessTree(child, detachedProcessGroup);
        finish(-1, `\n--- timed out after ${opts.timeoutMs}ms ---`);
      });

      child.on('close', (code) => {
        finish(
          timedOut ? -1 : (code ?? -1),
          timedOut ? `\n--- timed out after ${opts.timeoutMs}ms ---` : '',
        );
      });
      child.on('error', () => {
        finish(
          -1,
          timedOut ? `\n--- timed out after ${opts.timeoutMs}ms ---` : '\n--- spawn error ---',
        );
      });
    });
  }
}
