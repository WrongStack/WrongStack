import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { WIN32_TREE_KILL_BUDGET_MS } from '@wrongstack/core/utils/tree-kill';
import { inheritedEnv } from './child-env.js';
import { treeKill } from './runner.js';

/**
 * Default cap on captured stdout+stderr. A runaway benchmark command (an
 * infinite log loop, a huge stack trace) would otherwise grow the captured
 * strings without bound and OOM the runner. Mirrors the spirit of Node's
 * child_process.exec `maxBuffer`, but instead of erroring we truncate, kill the
 * process tree, and flag the result — keeping execCommand's never-reject contract.
 */
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MiB

/** How long after a tree kill to wait for `close` before giving up on the pipes. */
const KILL_GRACE_MS = process.platform === 'win32' ? WIN32_TREE_KILL_BUDGET_MS + 1000 : 5_000;

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
  /** Kills the process tree when aborted (the bench was stopped). */
  signal?: AbortSignal | undefined;
}): Promise<ExecResult> {
  const useShell = opts.shell ?? true;
  const maxBufferBytes = positiveSafeInteger(opts.maxBufferBytes, DEFAULT_MAX_BUFFER_BYTES);
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
          env: { ...inheritedEnv(), ...opts.env },
          windowsHide: true,
          detached: process.platform !== 'win32',
          shell: true,
        });
      } else {
        // No shell: args are passed verbatim to the program, so nothing in them
        // is interpreted. Preferred for git/python/etc.
        child = spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env: { ...inheritedEnv(), ...opts.env },
          windowsHide: true,
          detached: process.platform !== 'win32',
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
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    let killBackstop: NodeJS.Timeout | undefined;
    let killStarted = false;
    // Kill the tree, then stop waiting for `close` after a grace period: a
    // descendant that survived still holds the stdio pipes, and `close` never
    // fires while it does — the grader then hung the whole bench run forever.
    const killTree = () => {
      if (killStarted) return;
      killStarted = true;
      // The command deadline cannot replace an earlier buffer limit or caller abort
      // while Windows is still enumerating the process tree.
      clearTimeout(timer);
      try {
        child.stdin?.destroy();
      } catch {
        /* v8 ignore next -- defensive catch never throws in node */
      }
      // treeKill only — a direct child.kill() first killed the cmd.exe wrapper
      // on Windows, and `taskkill /T` cannot walk the tree from a dead root, so
      // npm → jest survived the timeout. treeKill keeps its own direct-kill
      // fallback (taskkill /T on Windows, process-group SIGKILL on POSIX).
      treeKill(child);
      killBackstop ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(child.exitCode);
      }, KILL_GRACE_MS);
      killBackstop.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);
    const onAbort = () => killTree();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Append a chunk to the target stream up to the shared byte budget. Once the
    // combined stdout+stderr budget is exhausted, stop buffering and kill the
    // process tree so a runaway command can't OOM the runner.
    const appendCapped = (
      chunk: Buffer,
      decoder: StringDecoder,
      append: (s: string) => void,
    ): void => {
      if (truncated) return;
      const remaining = maxBufferBytes - bufferedBytes;
      if (chunk.length <= remaining) {
        bufferedBytes += chunk.length;
        append(decoder.write(chunk));
        return;
      }
      // Keep only what fits, on a UTF-8 boundary, then cut the process off.
      if (remaining > 0) {
        // `remaining` is a byte budget, but slicing mid-sequence would leave a
        // dangling multi-byte char that toString('utf8') turns into U+FFFD.
        // Walk back to the start of the trailing incomplete sequence so the
        // retained tail is always valid UTF-8 with no replacement chars.
        let cut = remaining;
        // `cut` stays < chunk.length (this branch runs only when chunk.length > remaining),
        // so the index is always defined; `!` silences strict-mode possibly-undefined.
        while (cut > 0 && (chunk[cut]! & 0xc0) === 0x80) cut--;
        append(decoder.write(chunk.subarray(0, cut)));
        bufferedBytes = maxBufferBytes;
      }
      truncated = true;
      killTree();
    };

    child.stdout?.on('data', (d: Buffer) => appendCapped(d, stdoutDecoder, (s) => (stdout += s)));
    child.stderr?.on('data', (d: Buffer) => appendCapped(d, stderrDecoder, (s) => (stderr += s)));

    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killBackstop);
      opts.signal?.removeEventListener('abort', onAbort);
      if (!truncated) {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      resolve({ exitCode, stdout, stderr, timedOut, truncated });
    };

    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      done(null);
    });
    child.on('close', (code) => done(code));
  });
}

function positiveSafeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return Number.isSafeInteger(normalized) && normalized >= 1 ? normalized : fallback;
}

/** Quote a single arg for the shell only when it contains whitespace. */
function shellQuote(arg: string): string {
  if (arg.length > 0 && !/\s/.test(arg)) return arg;
  // Wrap in double quotes and escape any embedded double quotes. Sufficient for
  // the benchmark's own test commands (no untrusted shell metacharacters).
  return `"${arg.replace(/"/g, '\\"')}"`;
}
