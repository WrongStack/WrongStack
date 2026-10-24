import { spawn } from 'node:child_process';
import type { AnyHookOutcome, HookInput, HookOutcome } from '@wrongstack/contracts/types/hooks';
import type { Logger } from '@wrongstack/contracts/types/logger';
import { buildChildEnv } from '../utils/child-env.js';
import { toErrorMessage } from '../utils/error.js';
import { settleWin32Kill } from '../utils/tree-kill.js';
import { buildWin32CmdShimInvocation } from '../utils/win32-cmd.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

// Allowlist of safe shell commands for hooks. Commands not in this list are rejected.
// This prevents arbitrary command execution if a hook config file is compromised.
// For custom commands, operators should either:
//   1. Use absolute paths to trusted executables
//   2. Create wrapper scripts under .wrongstack/hooks/ and reference them by absolute path
const ALLOWED_SHELL_COMMANDS = new Set([
  // POSIX shells + Windows shells
  'bash',
  'sh',
  'dash',
  'zsh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  // Script interpreters — hooks are routinely small node/python scripts
  'node',
  'deno',
  'bun',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'python',
  'python3',
  'perl',
  'ruby',
  // Utilities
  'echo',
  'cat',
  'grep',
  'sed',
  'awk',
  'find',
  'sort',
  'uniq',
  'wc',
  'head',
  'tail',
  'cut',
  'tr',
  'tee',
  'xargs',
  'printf',
  'test',
  'expr',
  // File operations
  'ls',
  'stat',
  'touch',
  'mkdir',
  'rm',
  'cp',
  'mv',
  'chmod',
  'chown',
  // Network (read-only)
  'curl',
  'wget',
  // Git (common operations)
  'git',
  'diff',
  'merge',
  // Process
  'ps',
  'kill',
  'pgrep',
  'pkill',
  // Text processing
  'jq',
  'yq',
  // System info
  'uname',
  'hostname',
  'whoami',
  'date',
]);

/** Allowlisted commands that are `.cmd` shims on Windows (npm, corepack). */
const WIN32_CMD_SHIM_COMMANDS = new Set(['npm', 'npx', 'pnpm', 'yarn']);

/**
 * Whether a hook executable is a `.cmd`/`.bat` on Windows, which `spawn`
 * without a shell cannot launch: bare shim names fail ENOENT, an absolute
 * `.cmd` wrapper fails EINVAL (CVE-2024-27980 guard).
 */
function isWin32CmdShim(executable: string): boolean {
  return /\.(?:cmd|bat)$/i.test(executable) || WIN32_CMD_SHIM_COMMANDS.has(executable);
}

/** Absolute path on either platform (POSIX `/...` or Windows `C:\...` / `C:/...`). */
function isAbsoluteCommandPath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Split a hook command line into argv, honouring quotes the way a user
 * writing `sh -c "jq . >> log"` or `node "C:/Program Files/hook.js"` expects.
 *
 * Grouping only — there is NO shell: operators (`&&`, `|`, `;`, `>`) stay
 * literal arguments and nothing is expanded. Single quotes are fully literal;
 * inside double quotes a backslash escapes only `"` and `\`, so Windows paths
 * keep their backslashes. Outside quotes a backslash is literal too (a bare
 * `C:\hooks\run.cmd` must survive). An unterminated quote rejects the command
 * rather than guessing where the argument ends.
 *
 * The old whitespace split broke every quoted argument — including the
 * `sh -c "..."` escape hatch documented below — into fragments with stray
 * quote characters.
 */
function splitHookCommand(command: string): string[] | null {
  const argv: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        current += command[i + 1];
        i++;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) argv.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) return null;
  if (inToken) argv.push(current);
  return argv;
}

function isCommandAllowed(command: string): string[] | null {
  // Split the command into argv (quote-aware, see splitHookCommand). Shell
  // chaining operators (&&, ||, |, ;) are NOT interpreted — they become
  // literal arguments to the executable. Hooks that need pipes, redirects,
  // or variable expansion should use `sh -c "..."`.
  const argv = splitHookCommand(command.trim());
  if (!argv || argv.length === 0 || argv[0]!.length === 0) return null;
  const executable = argv[0]!;
  // Documented escape hatch #1: absolute paths reference operator-authored
  // trusted executables (incl. wrapper scripts under .wrongstack/hooks/) and
  // are allowed as-is — on both POSIX and Windows path syntax.
  if (isAbsoluteCommandPath(executable)) return argv;
  // Relative path with separators (e.g. ./scripts/hook.sh) — judge by filename.
  const commandName = /[\\/]/.test(executable)
    ? (executable.split(/[\\/]/).pop() ?? executable)
    : executable;

  if (ALLOWED_SHELL_COMMANDS.has(commandName)) return argv;
  return null;
}

export interface ShellHookSpec {
  command: string;
  timeoutMs?: number | undefined;
}

export type HookExecutionFailureKind =
  | 'aborted'
  | 'error'
  | 'exit'
  | 'invalid_output'
  | 'rejected'
  | 'timeout';

export interface HookExecutionFailure {
  kind: HookExecutionFailureKind;
  message: string;
}

export interface HookExecutionResult {
  outcome: AnyHookOutcome | null;
  failure?: HookExecutionFailure | undefined;
}

export interface HookExecutionOptions {
  signal?: AbortSignal | undefined;
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (typeof pid === 'number') {
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        // taskkill can exit without killing, stall, or report a failed spawn
        // as an 'error' event: the hook already resolved, so its process would
        // run on orphaned. Kill it directly once taskkill settles.
        settleWin32Kill(killer, child, () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        });
        return;
      } catch {
        // Fall through to direct kill.
      }
    } else {
      try {
        // Command hooks are detached into their own process group on POSIX.
        process.kill(-pid, 'SIGKILL');
        return;
      } catch {
        // Fall through to direct kill.
      }
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

/**
 * Run a shell hook (Claude-compatible). The `HookInput` JSON is written to the
 * command's stdin. Resolution rules, in order:
 *   - exit code 2 → `{ decision: 'block', reason: <stderr or stdout> }`
 *   - stdout parses as a JSON object → returned verbatim as a `HookOutcome`
 *   - otherwise → no-op (`null`)
 *
 * The hook never throws into the agent loop: spawn errors and timeouts resolve
 * to `null` and are logged. Output is capped at 64 KiB.
 */
export async function runShellHook(
  spec: ShellHookSpec,
  input: HookInput,
  logger?: Logger | undefined,
): Promise<HookOutcome | null> {
  const result = await runShellHookDetailed(spec, input, logger);
  if (result.outcome && 'action' in result.outcome) {
    if (result.outcome.action === 'deny') {
      return { decision: 'block', reason: result.outcome.reason };
    }
    if (result.outcome.action === 'mutate') {
      return { decision: 'allow', modifiedInput: result.outcome.input };
    }
    return { decision: 'allow' };
  }
  return result.outcome as HookOutcome | null;
}

/** Detailed executor used by HookRunner to apply per-hook failure policy. */
export async function runShellHookDetailed(
  spec: ShellHookSpec,
  input: HookInput,
  logger?: Logger | undefined,
  options: HookExecutionOptions = {},
): Promise<HookExecutionResult> {
  const timeoutMs = Math.max(1, Math.min(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10 * 60_000));

  if (splitHookCommand(spec.command.trim()) === null) {
    logger?.warn?.(`hook rejected: unterminated quote in command: ${spec.command}`);
    return {
      outcome: null,
      failure: { kind: 'rejected', message: 'hook command has an unterminated quote' },
    };
  }

  // Security: reject commands not in the allowlist
  const argv = isCommandAllowed(spec.command);
  if (!argv) {
    logger?.warn?.(`hook rejected: command not in allowlist: ${spec.command}`);
    return {
      outcome: null,
      failure: { kind: 'rejected', message: 'command is not in the hook allowlist' },
    };
  }

  return await new Promise<HookExecutionResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (v: HookExecutionResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // Security: spawn WITHOUT shell so the command string is never
      // interpreted by a shell — shell chaining operators (&&, ||, |, ;)
      // become literal arguments. The executable + args are split by
      // isCommandAllowed above. Hooks that need pipes/redirects should
      // use `sh -c "..."` which is allowlisted through sh/bash.
      let cmd = argv[0]!;
      let args = argv.slice(1);
      let windowsVerbatimArguments = false;
      if (process.platform === 'win32' && isWin32CmdShim(cmd)) {
        // Throws on cmd.exe metacharacters; the catch below reports it.
        const shim = buildWin32CmdShimInvocation(cmd, args);
        cmd = shim.command;
        args = shim.args;
        windowsVerbatimArguments = true;
      }
      child = spawn(cmd, args, {
        cwd: input.cwd,
        env: buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
      });
    } catch (err) {
      logger?.warn?.(`hook spawn failed: ${toErrorMessage(err)}`);
      return resolve({
        outcome: null,
        failure: { kind: 'error', message: `spawn failed: ${toErrorMessage(err)}` },
      });
    }

    const onAbort = () => {
      killProcessTree(child);
      done({ outcome: null, failure: { kind: 'aborted', message: 'hook invocation aborted' } });
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      logger?.warn?.(`hook command timed out after ${timeoutMs}ms: ${spec.command}`);
      killProcessTree(child);
      done({
        outcome: null,
        failure: { kind: 'timeout', message: `timed out after ${timeoutMs}ms` },
      });
    }, timeoutMs);

    let out = '';
    let err = '';
    let outTrunc = false;
    // Decode at the stream, not per chunk: a pipe chunk can end inside a
    // multi-byte character, and `chunk.toString('utf8')` turned each half into
    // U+FFFD — corrupting a `mutate` hook's rewritten tool input, or its
    // context, without any error. The stream decoder carries the partial
    // character into the next chunk.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (outTrunc) return;
      out += d;
      if (Buffer.byteLength(out, 'utf8') > MAX_OUTPUT_BYTES) {
        out = out.slice(0, MAX_OUTPUT_BYTES);
        outTrunc = true;
      }
    });
    child.stderr?.on('data', (d: string) => {
      if (err.length < MAX_OUTPUT_BYTES) err += d;
    });

    child.on('error', (e) => {
      logger?.warn?.(`hook command error: ${e instanceof Error ? e.message : String(e)}`);
      done({
        outcome: null,
        failure: { kind: 'error', message: e instanceof Error ? e.message : String(e) },
      });
    });

    child.on('close', (code) => {
      if (code === 2) {
        const reason = (err.trim() || out.trim() || 'blocked by hook').slice(0, 2_000);
        return done({ outcome: { action: 'deny', reason } });
      }
      if (code !== 0) {
        return done({
          outcome: null,
          failure: {
            kind: 'exit',
            message: (err.trim() || `hook exited with code ${String(code)}`).slice(0, 2_000),
          },
        });
      }
      if (!out.trim()) return done({ outcome: null });
      const parsed = parseHookOutcome(out);
      if (!parsed) {
        return done({
          outcome: null,
          failure: { kind: 'invalid_output', message: 'hook stdout was not valid outcome JSON' },
        });
      }
      done({ outcome: parsed });
    });

    // Feed the payload and close stdin so the command isn't left waiting.
    // The write can still fail ASYNCHRONOUSLY: a hook command that exits
    // without reading stdin leaves the pending write against a closed pipe
    // (EPIPE/EOF), and without an 'error' listener on the stream that
    // failure is an uncaught exception that kills the whole agent process —
    // the child 'error'/'close' handlers cover process errors only.
    child.stdin?.on('error', () => {
      /* handled: the child's close/error handlers settle the invocation */
    });
    try {
      child.stdin?.end(`${JSON.stringify(input)}\n`);
    } catch {
      /* the close/error handlers will resolve */
    }
  });
}

export function parseHookOutcome(stdout: string): AnyHookOutcome | null {
  const trimmed = stdout.trim();
  if (trimmed?.[0] !== '{') return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const outcome: HookOutcome = {};
    const common: {
      additionalContext?: string | undefined;
      contextAs?: 'inline' | 'separate' | undefined;
    } = {
      ...(typeof obj['additionalContext'] === 'string'
        ? { additionalContext: obj['additionalContext'] }
        : {}),
      ...(obj['contextAs'] === 'inline' || obj['contextAs'] === 'separate'
        ? { contextAs: obj['contextAs'] as 'inline' | 'separate' }
        : {}),
    };
    if ('action' in obj && obj['action'] !== undefined) {
      if (obj['action'] !== 'allow' && obj['action'] !== 'deny' && obj['action'] !== 'mutate') {
        return null;
      }
      if (obj['action'] === 'deny') {
        if (typeof obj['reason'] !== 'string' || !obj['reason'].trim()) return null;
        return { action: 'deny', reason: obj['reason'], ...common };
      }
      if (obj['action'] === 'mutate') {
        if (!obj['input'] || typeof obj['input'] !== 'object' || Array.isArray(obj['input']))
          return null;
        return {
          action: 'mutate',
          input: obj['input'] as Record<string, unknown>,
          ...(typeof obj['reason'] === 'string' ? { reason: obj['reason'] } : {}),
          ...common,
        };
      }
      return { action: 'allow', ...common };
    }
    if ('decision' in obj && obj['decision'] !== undefined) {
      if (obj['decision'] !== 'block' && obj['decision'] !== 'allow') return null;
      outcome.decision = obj['decision'];
    }
    if (typeof obj['reason'] === 'string') outcome.reason = obj['reason'];
    if (typeof obj['additionalContext'] === 'string') {
      outcome.additionalContext = obj['additionalContext'];
    }
    if ('modifiedInput' in obj && obj['modifiedInput'] !== undefined) {
      if (
        !obj['modifiedInput'] ||
        typeof obj['modifiedInput'] !== 'object' ||
        Array.isArray(obj['modifiedInput'])
      ) {
        return null;
      }
      outcome.modifiedInput = obj['modifiedInput'] as Record<string, unknown>;
    }
    if (obj['contextAs'] === 'inline' || obj['contextAs'] === 'separate') {
      outcome.contextAs = obj['contextAs'];
    }
    return outcome;
  } catch {
    return null;
  }
}
