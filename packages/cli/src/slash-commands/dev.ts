import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Context } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import { buildWin32CmdShimInvocation } from '../utils/win32-cmd.js';
import type { SlashCommandContext } from './command-context.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LINES = 500;
/** Cap on accumulated stdout/stderr, mirroring the old execFile maxBuffer. */
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

/** Exit code when the program could not be spawned at all (ENOENT, EACCES,
 *  rejected by the win32 shim builder, unterminated quote) — the shell's
 *  command-not-found convention. Previously a string `error.code` mapped to
 *  `0` here and spawn failures rendered as a green OK (BIZ-001). */
const EXIT_SPAWN_FAILED = 127;
/** Exit code when the command was killed for exceeding its timeout — the
 * GNU `timeout(1)` convention. */
const EXIT_TIMEOUT = 124;

/** Signal-name → number table for the shell's 128+N death-by-signal
 * convention, covering the signals a foreign kill realistically uses. */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGALRM: 14,
  SIGTERM: 15,
};

/** Exit code for a child that died from a signal WE did not send (self-kill
 * or an external kill): 128+N for the known signals, and 125 — `timeout(1)`'s
 * "internal failure" code — as a conservative fallback. Never 0, never 124:
 * a foreign kill is not a timeout. */
function foreignSignalExitCode(signal: string): number {
  const n = SIGNAL_NUMBERS[signal];
  return n === undefined ? 125 : 128 + n;
}

export interface DevCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the process died from a signal (timeout kill or foreign). */
  killed: boolean;
  /** True when the program never started (not found / not executable /
   *  refused by the Windows shim builder). Rendered as SPAWN ERROR. */
  spawnFailed: boolean;
  /** Signal name when the process died from a signal (e.g. SIGTERM). */
  signalName?: string | undefined;
  /** True only when killed by the /dev timeout itself — not by a foreign
   *  signal. The distinction matters: both arrive at `close(null, signal)`,
   *  but only the former is a TIMEOUT. */
  timedOut?: boolean | undefined;
}

/**
 * Split a command line into program + argv, honoring single quotes, double
 * quotes, and backslash escapes. Deliberately NOT a shell: no variable
 * expansion, no globbing, no operators. Tokens are passed verbatim to a
 * shell-less spawn — which is what makes `&`, `|`, `;` inert on POSIX
 * (BIZ-001: the old code passed the whole string as one argv element, so
 * every command with arguments ENOENT'd) and lets the win32 shim builder
 * validate each token individually.
 *
 * Backslash handling is platform-aware (chimera follow-up to BIZ-002). On
 * POSIX, OUTSIDE quotes `\` escapes the next character (shell convention);
 * INSIDE double quotes it escapes only the four chars bash treats specially
 * there (" \ $ `) plus newline-continuation, and is literal otherwise. On
 * Windows it is the path separator and MUST stay literal everywhere —
 * treating it as an escape silently corrupted `C:\Users\foo` into
 * `C:Usersfoo`, defeating the very path-separator fix BIZ-002 made. Inside
 * single quotes everything is literal on both platforms.
 *
 * Throws on an unterminated quoted argument.
 */
export function tokenizeCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const isWin32 = platform === 'win32';
  const args: string[] = [];
  let current = '';
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      // Inside double quotes on POSIX, a backslash escapes ONLY the four
      // characters bash treats specially there (" \ $ `) — for anything else
      // (regex \d, \w, …) it is LITERAL, so `grep -E "\d+"` keeps its
      // backslash. A backslash before a newline is a line continuation:
      // both are dropped. Inside single quotes everything is literal
      // everywhere. On Windows a backslash is always a path separator.
      if (!isWin32 && char === '\\' && quote === '"' && i + 1 < command.length) {
        const next = command[i + 1]!;
        if (next === '\n') {
          i++; // line continuation — drop the backslash AND the newline
          continue;
        }
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i++;
          continue;
        }
        // Any other character: the backslash is literal — fall through.
      }
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (!isWin32 && char === '\\' && i + 1 < command.length) {
      current += command[++i];
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (quote) throw new Error(`Unterminated quoted argument in command: ${command}`);
  if (tokenStarted) args.push(current);
  return args;
}

function spawnFailure(stderr: string): DevCommandResult {
  return { stdout: '', stderr, exitCode: EXIT_SPAWN_FAILED, killed: false, spawnFailed: true };
}

/**
 * Run `/dev <command>` without a shell on POSIX and through the canonical
 * hardened cmd.exe shim on Windows.
 *
 * - POSIX: `spawn(program, args, { shell: false })` — metacharacters are
 *   literal argv, so `/dev git diff --stat` actually runs (BIZ-001).
 * - Windows: Node cannot spawn `.cmd`/`.bat` shims without a shell
 *   (CVE-2024-27980), so the invocation goes through
 *   {@link buildWin32CmdShimInvocation}, which quotes every token and refuses
 *   the real cmd.exe operators (`& | < > " %`, newlines) outright. Path
 *   separators are no longer blocked — they are not operators (BIZ-002).
 */
export function runCommand(
  cmd: string,
  cwd: string,
  timeout: number = DEFAULT_TIMEOUT_MS,
): Promise<DevCommandResult> {
  let program: string;
  let args: string[];
  try {
    const tokens = tokenizeCommand(cmd);
    program = tokens[0] ?? '';
    args = tokens.slice(1);
  } catch (err) {
    return Promise.resolve(spawnFailure(err instanceof Error ? err.message : String(err)));
  }
  if (!program) return Promise.resolve(spawnFailure('Empty command.'));

  let command: string;
  let spawnArgs: string[];
  let windowsVerbatimArguments: true | undefined;
  if (process.platform === 'win32') {
    try {
      const shim = buildWin32CmdShimInvocation(program, args);
      command = shim.command;
      spawnArgs = shim.args;
      windowsVerbatimArguments = shim.windowsVerbatimArguments;
    } catch (err) {
      return Promise.resolve(spawnFailure(err instanceof Error ? err.message : String(err)));
    }
  } else {
    command = program;
    spawnArgs = args;
  }

  return new Promise((resolve) => {
    // `spawn` can throw SYNCHRONOUSLY (argument-shape errors, oversized
    // verbatim command lines on Windows) — without this guard the promise
    // rejects instead of resolving with a spawn failure, and the caller's
    // result rendering never runs.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, spawnArgs, {
        cwd,
        timeout,
        windowsHide: true,
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
      });
    } catch (err) {
      resolve(spawnFailure(err instanceof Error ? err.message : String(err)));
      return;
    }
    let stdout = '';
    let stderr = '';
    // Manual cap — spawn streams, so execFile's maxBuffer does not apply.
    // Each stream decodes through its own StringDecoder: a socket chunk can
    // END in the middle of a multi-byte UTF-8 sequence, and per-chunk
    // toString('utf8') would emit U+FFFD for both halves of every sequence
    // split at a chunk edge. The decoder buffers the partial sequence and
    // completes it when the next chunk arrives.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const appendCapped = (acc: string, decoder: StringDecoder, chunk: Buffer): string =>
      acc.length >= MAX_STREAM_BYTES
        ? acc
        : acc + decoder.write(chunk).slice(0, MAX_STREAM_BYTES - acc.length);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, stdoutDecoder, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, stderrDecoder, chunk);
    });
    // A failed read pipe must not become an uncaught exception (execFile
    // attached stream handlers internally; raw spawn does not). Record what
    // we can and let `close` deliver the final result.
    child.stdout?.on('error', (err: Error) => {
      stderr = appendCapped(
        stderr,
        stderrDecoder,
        Buffer.from(`\n[stdout stream error: ${err.message}]`),
      );
    });
    child.stderr?.on('error', () => {
      // stderr itself failed — nowhere left to record; swallow.
    });

    let settled = false;
    const finish = (result: DevCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Spawn failures (ENOENT, EACCES, EMFILE) arrive here with a STRING
    // error.code — the case the old `typeof error?.code === 'number'`
    // mapping silently turned into exitCode 0 / green OK (BIZ-001).
    child.on('error', (err: Error) => {
      finish({
        stdout,
        stderr: err.message,
        exitCode: EXIT_SPAWN_FAILED,
        killed: false,
        spawnFailed: true,
      });
    });
    child.on('close', (code, signal) => {
      // This handle never calls kill() itself — the ONLY kill is the spawn
      // `timeout` option — so `child.killed` at close time means our timeout
      // fired. The raw close args differ by platform: POSIX reports
      // close(null, 'SIGTERM'), while Windows TerminateProcess reports
      // close(1, null) — a signal-gated timeout check would never fire on
      // Windows and the timeout would render as a plain EXIT 1.
      // `code !== 0` closes a boundary race: the spawn-timeout timer can
      // fire just before an independently-successful exit is reaped, and
      // close(0, null) must never be mislabeled 124/TIMEOUT. A genuine
      // timeout kill reports close(null, SIGTERM) on POSIX and close(1,
      // null) on Windows — both non-zero, both still caught.
      const timedOut = child.killed && code !== 0;
      const diedBySignal = signal !== null && !timedOut;
      const exitCode = timedOut
        ? EXIT_TIMEOUT
        : (code ?? (diedBySignal ? foreignSignalExitCode(signal ?? '') : EXIT_SPAWN_FAILED));
      finish({
        stdout,
        stderr,
        exitCode,
        killed: diedBySignal,
        spawnFailed: code === null && signal === null,
        ...(signal !== null ? { signalName: signal } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}

function formatOutput(
  cmd: string,
  result: {
    stdout: string;
    stderr: string;
    exitCode: number;
    killed: boolean;
    spawnFailed?: boolean;
    signalName?: string | undefined;
    timedOut?: boolean | undefined;
  },
  elapsed: number,
): string {
  const lines: string[] = [];

  // Header — SPAWN ERROR is distinct from a real non-zero exit so a missing
  // binary can never render as success again (BIZ-001). TIMEOUT is reserved
  // for our own timeout kill; a foreign signal renders as KILLED (name).
  const exitLabel = result.timedOut
    ? color.red('TIMEOUT')
    : result.killed
      ? color.red(`KILLED${result.signalName ? ` (${result.signalName})` : ''}`)
      : result.spawnFailed
        ? color.red('SPAWN ERROR')
        : result.exitCode === 0
          ? color.green('OK')
          : color.red(`EXIT ${result.exitCode}`);
  lines.push(`${color.cyan('$')} ${color.bold(cmd)}  ${exitLabel}  ${color.dim(`${elapsed}ms`)}`);

  // Output
  const combined = (result.stdout + result.stderr).trimEnd();
  if (combined) {
    const outputLines = combined.split('\n');
    const truncated = outputLines.length > MAX_OUTPUT_LINES;
    const shown = truncated ? outputLines.slice(0, MAX_OUTPUT_LINES) : outputLines;

    lines.push('');
    lines.push(color.dim('──'));
    for (const line of shown) {
      lines.push(line);
    }
    if (truncated) {
      lines.push(
        color.dim(
          `… (truncated, showing first ${MAX_OUTPUT_LINES} of ${outputLines.length} lines)`,
        ),
      );
    }
    lines.push(color.dim('──'));
  } else {
    lines.push(color.dim('(no output)'));
  }

  return lines.join('\n');
}

/**
 * `/dev <shell command>` — execute a shell command from the chat input and
 * display its output. The LLM does NOT see the result — this is a developer
 * convenience shortcut, not a tool invocation.
 */
export function buildDevCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'dev',
    category: 'Run',
    description: 'Run a shell command and see the output (LLM does not see it).',
    argsHint: '<shell command>',
    help: [
      'Usage:',
      '  /dev <shell command>    Run a command from the chat input.',
      '',
      'Examples:',
      '  /dev pnpm release:check',
      '  /dev git diff --stat',
      '  /dev ls -la src/',
      '',
      'The command runs in the current working directory. Output is displayed',
      'in the chat history but is NOT fed to the LLM — use this for your own',
      'eyes only. Timeout: 60s. Max output: 500 lines.',
      '',
      'This is a convenience shortcut — equivalent to switching to a terminal',
      'tab. For commands the LLM should see, use the `exec` tool instead.',
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const cmd = args.trim();
      if (!cmd) {
        return {
          message: `${color.yellow('Usage:')} /dev <shell command>\n\nExamples:\n  /dev pnpm release:check\n  /dev git diff --stat`,
        };
      }

      // Validation happens inside runCommand: tokenization errors and win32
      // shim rejections return a spawnFailed result instead of throwing.
      const cwd = opts.cwd;
      const startedAt = Date.now();

      opts.renderer.write(color.dim(`$ ${cmd}`));

      const result = await runCommand(cmd, cwd, DEFAULT_TIMEOUT_MS);
      const elapsed = Date.now() - startedAt;

      const display = formatOutput(cmd, result, elapsed);
      return { message: display };
    },
  };
}
