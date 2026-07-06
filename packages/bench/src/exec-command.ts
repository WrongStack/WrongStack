import { spawn } from 'node:child_process';
import { treeKill } from './runner.js';

/**
 * Default cap on captured stdout+stderr. A runaway benchmark command (an
 * infinite log loop, a huge stack trace) would otherwise grow the captured
 * strings without bound and OOM the runner. Mirrors the spirit of Node's
 * child_process.exec `maxBuffer`, but instead of erroring we truncate, kill the
 * process tree, and flag the result — keeping execCommand's never-reject contract.
 */
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * True when combined stdout+stderr hit maxBufferBytes and capture was cut
   * short. Optional so existing ExecResult literals (test mocks, graders that
   * synthesise a result) stay valid; execCommand always sets it.
   */
  truncated?: boolean | undefined;
}

/**
 * Run a command (argv form) in a directory and capture its result. Used by the
 * deterministic graders to run a suite's own test command — the run's exit code
 * is the pass/fail signal, no LLM involved.
 *
 * Never rejects; a spawn failure surfaces as exitCode null with the error on
 * stderr.
 */
export function execCommand(opts: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Run through a shell. Needed for launchers that resolve platform wrappers
   * (`npm` → npm.cmd on Windows, `./gradlew`). Defaults to true. Pass false for
   * real executables (git, python, node, cargo, go) to avoid the shell entirely
   * — no metacharacter interpretation, no DEP0190, no injection surface.
   */
  shell?: boolean | undefined;
  /**
   * Max captured stdout+stderr in bytes before the process tree is killed and
   * the result is flagged `truncated`. Defaults to {@link DEFAULT_MAX_BUFFER_BYTES}
   * (10 MiB). Guards against a runaway command OOM-ing the runner.
   */
  maxBufferBytes?: number | undefined;
}): Promise<ExecResult> {
  const useShell = opts.shell ?? true;
  const maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  return new Promise<ExecResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      if (useShell) {
        // Build a SINGLE command string rather than passing an args array with
        // `shell:true` — the latter triggers Node's DEP0190 warning and does
        // not escape the args anyway. Trusted, benchmark-defined commands only.
        const line = [opts.command, ...opts.args.map(shellQuote)].join(' ');
        child = spawn(line, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          windowsHide: true,
          shell: true,
        });
      } else {
        // No shell: args are passed verbatim to the program, so nothing in them
        // is interpreted. Preferred for git/python/etc.
        child = spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          windowsHide: true,
        });
      }
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        /* v8 ignore next -- spawn throws Error subclasses; the String(err) branch is defensive. */
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        truncated: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;
    let bufferedBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // A naive child.kill() only signals the direct child — with shell:true
      // that's the /bin/sh or cmd.exe wrapper, leaving the actual test process
      // (npm/gradle/etc.) orphaned. treeKill tears down the whole process tree
      // (taskkill /T on Windows, SIGTERM→SIGKILL on POSIX).
      treeKill(child);
    }, opts.timeoutMs);

    // Append a chunk to the target stream up to the shared byte budget. Once the
    // combined stdout+stderr budget is exhausted, stop buffering and kill the
    // process tree so a runaway command can't OOM the runner.
    const appendCapped = (chunk: Buffer, append: (s: string) => void): void => {
      if (truncated) return;
      const remaining = maxBufferBytes - bufferedBytes;
      if (chunk.length <= remaining) {
        bufferedBytes += chunk.length;
        append(chunk.toString('utf8'));
        return;
      }
      // Keep only what fits, on a UTF-8 boundary, then cut the process off.
      if (remaining > 0) {
        append(chunk.subarray(0, remaining).toString('utf8'));
        bufferedBytes = maxBufferBytes;
      }
      truncated = true;
      treeKill(child);
    };

    child.stdout?.on('data', (d: Buffer) => appendCapped(d, (s) => (stdout += s)));
    child.stderr?.on('data', (d: Buffer) => appendCapped(d, (s) => (stderr += s)));

    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, truncated });
    };

    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      done(null);
    });
    child.on('close', (code) => done(code));
  });
}

/** Quote a single arg for the shell only when it contains whitespace. */
function shellQuote(arg: string): string {
  if (arg.length > 0 && !/\s/.test(arg)) return arg;
  // Wrap in double quotes and escape any embedded double quotes. Sufficient for
  // the benchmark's own test commands (no untrusted shell metacharacters).
  return `"${arg.replace(/"/g, '\\"')}"`;
}
