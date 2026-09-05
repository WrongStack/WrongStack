import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Context } from '@wrongstack/core/agent';
import {
  emitProcessCompleted,
  emitProcessOutput,
  emitProcessStarted,
} from '@wrongstack/core/observability';
import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { type DangerAssessment, detectDanger } from './_danger-detect.js';
import { buildChildEnv } from './_env.js';
import { createOutputSpool, spoolNote } from './_output-spool.js';
import { COMMAND_OUTPUT_MAX_BYTES, normalizeCommandOutput, safeResolveReal } from './_util.js';
import { buildWin32CmdShimInvocation, resolveWin32Command } from './_win32-resolve.js';
import { checkExecKillCommand } from './exec-kill-guard.js';
import { DEFAULT_ALLOWED_COMMANDS } from './exec-allowlist.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';

const isWin = process.platform === 'win32';

// The live, effective allowlist: DEFAULT ∪ config.allow − config.deny. Replaced
// wholesale by configureExecPolicy(); defaults until boot wires the config.
let allowedCommands: Set<string> = new Set(DEFAULT_ALLOWED_COMMANDS);

const normalizeCmd = (c: string): string => c.trim();

/**
 * Apply the configured exec command policy. Recomputes the effective allowlist
 * as `DEFAULT ∪ allow − deny`. Call once at boot from
 * `config.tools.exec.{allow,deny}`. Idempotent (always rebuilt from defaults).
 *
 * SECURITY: `allow` must originate from TRUSTED config only — the config loader
 * strips `tools.exec.allow` from the untrusted in-project repo config before it
 * reaches here. `deny` is safe from any source (it only narrows).
 */
export function configureExecPolicy(
  opts: { allow?: readonly string[] | undefined; deny?: readonly string[] | undefined } = {},
): void {
  const next = new Set(DEFAULT_ALLOWED_COMMANDS);
  for (const c of opts.allow ?? []) {
    const n = normalizeCmd(c);
    if (n) next.add(n);
  }
  for (const c of opts.deny ?? []) next.delete(normalizeCmd(c));
  allowedCommands = next;
}

/** Reset the exec allowlist to the built-in defaults (tests / re-init). */
export function resetExecPolicy(): void {
  allowedCommands = new Set(DEFAULT_ALLOWED_COMMANDS);
}

// -----------------------------------------------------------------------
// Danger-detection bypass (config.tools.exec.danger.bypass)
// -----------------------------------------------------------------------

/**
 * Set of rule ids that should be skipped during danger detection. Wired
 * from `config.tools.exec.danger.bypass` at boot. Mirrors the
 * `allowedCommands` pattern above: defaults to empty, replaced wholesale
 * by `configureDangerBypass()`, reset by `resetDangerBypass()`.
 *
 * SECURITY: like `allow`, this is a per-rule weakening of the danger
 * gate. The boot path strips `tools.exec.danger.bypass` from in-project
 * repo config; only trusted config (user-global, system) sets it.
 */
let dangerBypass: ReadonlySet<string> = new Set();

/**
 * Apply the configured danger-bypass policy. Each id in `bypass` is
 * added to the effective skip set; duplicates are fine. Idempotent.
 *
 * Call once at boot from `config.tools.exec.danger.bypass`.
 */
export function configureDangerBypass(opts: { bypass?: readonly string[] | undefined } = {}): void {
  const next = new Set<string>();
  for (const id of opts.bypass ?? []) {
    const trimmed = id.trim();
    if (trimmed) next.add(trimmed);
  }
  dangerBypass = next;
}

/** Reset the danger-bypass set to empty (tests / re-init). */
export function resetDangerBypass(): void {
  dangerBypass = new Set();
}

/**
 * Read-only view of the active bypass set. `detectDanger()` takes a
 * `bypass` argument directly, so consumers should prefer passing this
 * rather than reading the set and matching themselves.
 */
export function getDangerBypass(): ReadonlySet<string> {
  return dangerBypass;
}

/** Whether `cmd` is currently in the effective exec allowlist. */
export function isExecCommandAllowed(cmd: string): boolean {
  return allowedCommands.has(normalizeCmd(cmd));
}

/** Snapshot of the effective allowlist (sorted) — for tests / diagnostics. */
export function getExecAllowlist(): string[] {
  return [...allowedCommands].sort();
}

const MAX_ARGS = 20;
// 200 KB — larger than bash's 32 KB cap. exec commands produce structured,
// predictable output (build logs, test results, git diffs) that the agent
// needs in full. 200 KB is safe for context windows ≥200K tokens while
// still preventing a rogue build from filling the context.
const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// Hard ceiling for the per-call `timeout` parameter. The old clamp used
// DEFAULT_TIMEOUT_MS as the ceiling too, which silently capped EVERY call at
// 30s no matter what the model asked for — long builds/test runs then died
// at 30s with exit 124 and no explanation. 10 minutes matches bash's ceiling.
const MAX_TIMEOUT_MS = 600_000;

// Per-command hard-blocks. Keep this list narrow: `exec` is already a
// confirm-gated tool with argv passed as an array and cwd confined to the
// project. These patterns should block clear sandbox escapes / destructive
// operations, not normal development workflows that happen to execute code.
const BLOCKED_ARG_PATTERNS: Record<string, RegExp[]> = {
  python: [],
  // git --exec=<cmd> runs arbitrary commands via upload-pack/receive-pack;
  // -C <dir> changes working directory, bypassing cwd sandbox;
  // -c/--config <k>=<v> injects config that runs commands
  // (e.g. core.sshCommand, core.pager, http.proxy, alias.x=!cmd).
  git: [
    /^--exec=/,
    /^--upload-pack=/,
    /^--receive-pack=/,
    /^-C$/,
    /^-c$/,
    /^--config$/,
    /^-c=/,
    /^--config=/,
    /^--config-env=/,
  ],
  node: [],
  go: [],
  bun: [],
  docker: [],
  // find -exec/-ok/-execdir execute arbitrary commands
  find: [
    /^-exec$/,
    /^-exec;$/,
    /^-ok$/,
    /^-ok;$/,
    /^-execdir$/,
    /^-execdir;$/,
    /^-exec=/,
    /^-ok=/,
    /^-execdir=/,
  ],
  // rm -rf / is catastrophic — block absolute paths, home, dot-dirs,
  // and glob patterns that could expand to dangerous targets.
  // `rm -rf ./src/*` expands to project files; `rm -rf ../../` escapes upward;
  // `rm -rf /*` targets the filesystem root. All are blocked.
  rm: [/^\//, /^[A-Za-z]:[\\/]/, /^~\//, /^~$/, /^\.$/, /^\.\.$/, /\*$/, /\/$/, /\/\*$/, /\.\//],
  // npm/pnpm subcommands are checked separately below. Matching every arg here
  // over-blocked normal dev flows such as `pnpm vitest run ...`.
  npm: [],
  pnpm: [],
  npx: [],
};

/**
 * Options blocked by NAME, independent of how the value is attached.
 *
 * `BLOCKED_ARG_PATTERNS` above is prefix-anchored on `--opt=`, but every
 * option parser this tool fronts also accepts `--opt value` as two argv
 * entries. `["push", "--exec", "./evil.sh"]` therefore walked straight past a
 * table whose whole purpose was to stop `--exec`. Matching the option NAME —
 * after splitting off any `=value` — closes both spellings with one entry.
 *
 * The git set is deliberately wider than the `=`-anchored table it supplements:
 *
 * - `--exec` / `--upload-pack` / `--receive-pack` run an arbitrary command via
 *   the transport layer. `_danger-detect.ts` (`git-exec`) already enumerated
 *   the bare forms, so the *advisory* layer warned about invocations the
 *   *blocking* layer let through. One table, both spellings, no drift.
 * - `--exec-path` makes git resolve non-builtin subcommands from a caller-named
 *   directory, so `git --exec-path=/tmp/x status` runs `/tmp/x/git-status`.
 * - `--git-dir` / `--work-tree` relocate the repository and working tree, which
 *   is the same cwd-sandbox escape `-C` is blocked for.
 */
const BLOCKED_OPTION_NAMES: Record<string, ReadonlySet<string>> = {
  git: new Set([
    '--exec',
    '--upload-pack',
    '--receive-pack',
    '--exec-path',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '-c',
    '--config',
    '--config-env',
    '-C',
  ]),
  find: new Set(['-exec', '-ok', '-execdir']),
};

/** `--opt=value` → `--opt`; everything else unchanged. */
function optionName(arg: string): string {
  const eq = arg.indexOf('=');
  return eq > 0 ? arg.slice(0, eq) : arg;
}

// Subcommand verbs only make sense in subcommand position. Keep externally
// destructive actions blocked there without rejecting harmless downstream args
// named "run", "publish", etc. passed to test runners or build tools.
const BLOCKED_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  docker: new Set(['push']),
  podman: new Set(['push']),
  npm: new Set(['publish', 'deploy']),
  pnpm: new Set(['publish', 'deploy']),
  yarn: new Set(['publish']),
};

const BLOCKED_SUBCOMMAND_SEQUENCES: Record<string, readonly (readonly string[])[]> = {
  yarn: [['npm', 'publish']],
};

function firstSubcommand(args: string[]): string | null {
  for (const arg of args) {
    if (arg === '--') return null;
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

function subcommandArgs(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg === '--') break;
    if (!arg.startsWith('-')) out.push(arg);
  }
  return out;
}

function validateArgs(cmd: string, args: string[]): string | null {
  const blockedSubcommands = BLOCKED_SUBCOMMANDS[cmd];
  const subcommand = firstSubcommand(args);
  if (blockedSubcommands && subcommand && blockedSubcommands.has(subcommand)) {
    return `Blocked subcommand "${subcommand}" for command "${cmd}"`;
  }

  const blockedSequences = BLOCKED_SUBCOMMAND_SEQUENCES[cmd];
  if (blockedSequences) {
    const actual = subcommandArgs(args);
    const blocked = blockedSequences.find((seq) => seq.every((part, idx) => actual[idx] === part));
    if (blocked) return `Blocked subcommand "${blocked.join(' ')}" for command "${cmd}"`;
  }

  // Name-based check first: it covers `--opt=value` and `--opt value` alike,
  // and reports the option rather than the spelling that happened to be used.
  const blockedOptions = BLOCKED_OPTION_NAMES[cmd];
  if (blockedOptions) {
    for (const arg of args) {
      if (arg === '--') break; // everything after `--` is a positional operand
      if (blockedOptions.has(optionName(arg))) {
        return `Blocked option "${optionName(arg)}" for command "${cmd}"`;
      }
    }
  }

  const blocked = BLOCKED_ARG_PATTERNS[cmd];
  if (!blocked) return null;

  for (const arg of args) {
    for (const pattern of blocked) {
      if (pattern.test(arg)) {
        return `Blocked argument "${arg}" for command "${cmd}" (matches security pattern ${pattern})`;
      }
    }
  }
  return null;
}

export interface ExecInput {
  command: string;
  args?: string[] | undefined;
  cwd?: string | undefined;
  timeout?: number | undefined;
}

export interface ExecOutput {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  allowed: boolean;
  /**
   * Heuristic danger assessment of the (cmd, args) pair. Populated for every
   * call (not just blocked ones) so the UI/TUI can render a banner when the
   * level is 'caution' or 'destructive'. See `_danger-detect.ts` for the
   * rule set.
   *
   * Pre-execution error returns (allowlist miss, circuit breaker, etc.)
   * report `level: 'safe'` because the command never actually ran; the UI
   * should surface the error separately and not also a danger warning.
   */
  danger: DangerAssessment;
}

const SAFE_DANGER: DangerAssessment = { level: 'safe', reasons: [] };

export const execTool: Tool<ExecInput, ExecOutput> = {
  name: 'exec',
  category: 'Shell',
  description:
    'Execute a command from a **curated command roster** with argument validation and confirm gating. ' +
    'This is the **preferred** alternative to the `bash` tool for running development tools (node, npm, pnpm, tsc, git, tests, linters, etc.). ' +
    'It is NOT a sandbox — several rostered commands (node, python, powershell, …) can run arbitrary code — so prefer least-privilege commands.',
  usageHint:
    'PREFERRED SHELL TOOL for most cases.\n\n' +
    'Use this instead of `bash` whenever possible.\n' +
    '- `command` must be in the allowlist. Defaults cover JS (node/npm/pnpm/yarn/bun/deno/tsc/vitest/eslint/biome), Go (`go build`/`go test`), Rust (cargo), Python (python/pip), Ruby (gem/bundle), JVM (java/mvn/gradle), .NET (dotnet), native (make/cmake), and git. Users can extend it via `tools.exec.allow` in config.\n' +
    '- Arguments are passed as a clean array (no shell interpretation).\n' +
    '- `cwd` is validated to stay inside the project.\n' +
    '- If a command is not allowlisted, the error explains how to add it; for one-off arbitrary commands, fall back to `bash` (with strong justification).\n' +
    'The curated roster + confirm gating narrows the surface compared to full shell access, ' +
    'but this is not a sandbox — prefer least-privilege commands.',
  selection: {
    doNotUseWhen:
      'the operation requires pipes, redirection, shell expansion, or a non-allowlisted command.',
    useInstead: ['bash'],
  },
  permission: 'confirm',
  // WS-046: without this, every exec call collapsed onto the bare tool name.
  // Three consequences followed: "always allow" stored a rule that could never
  // match, pressing "no" once blocked ALL exec for the session, and the
  // permission cache keyed one decision for every command. `subjectKey:
  // 'command'` renders the FULL invocation (`command` + `args`) — using the
  // program alone would make `exec git status` and `exec git push --force` the
  // same subject, so trusting one would silently authorize the other.
  subjectKey: 'command',
  mutating: true,
  riskTier: 'standard',
  // Executor-level abort ceiling. Must sit ABOVE the per-call timeout ceiling
  // (MAX_TIMEOUT_MS): the tool's own timer resolves with exit 124 + registry
  // tree-kill; the executor's AbortSignal.timeout is a blunt abort that would
  // otherwise fire first and discard the structured timeout result. The 10s
  // margin covers the kill/teardown window. (The executor additionally clamps
  // to config `tools.maxToolTimeoutMs`.)
  timeoutMs: MAX_TIMEOUT_MS + 10_000,
  capabilities: ['shell.restricted'],
  icon: 'terminal',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The base command to run. Must be in the internal allowlist (e.g. "node", "pnpm", "git", "tsc").',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments passed to the command. Passed as an array (no shell parsing).',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory. Must resolve inside the project root.',
      },
      timeout: {
        type: 'integer',
        description: 'Per-command timeout in milliseconds (default 30000, max 600000).',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    const registry = getProcessRegistry();
    if (!registry.canProceed) {
      return {
        command: input.command,
        args: input.args ?? [],
        stdout: '',
        stderr:
          'Circuit breaker is open — too many consecutive failures. Use /kill reset to recover.',
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger: SAFE_DANGER,
      };
    }

    const cmd = input.command.trim();
    if (!cmd)
      return {
        command: cmd,
        args: [],
        stdout: '',
        stderr: 'Empty command',
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger: SAFE_DANGER,
      };

    if (!isExecCommandAllowed(cmd)) {
      return {
        command: cmd,
        args: input.args ?? [],
        stdout: '',
        stderr:
          `Command "${cmd}" not in allowlist. ` +
          `Add it to your active profile config (~/.wrongstack/profiles/<name>/config.json) ` +
          `under "tools": { "exec": { "allow": ["${cmd}"] } }, ` +
          `or use the bash tool for one-off arbitrary commands.`,
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger: SAFE_DANGER,
      };
    }

    const args = (input.args ?? []).slice(0, MAX_ARGS);
    const rawTimeout =
      typeof input.timeout === 'number' && !Number.isNaN(input.timeout)
        ? input.timeout
        : DEFAULT_TIMEOUT_MS;
    const timeout = Math.max(1, Math.min(rawTimeout, MAX_TIMEOUT_MS));

    // Heuristic danger assessment. Computed once here, attached to every
    // return from this point on (including error returns) so the UI can
    // render a banner for 'caution' / 'destructive' levels. The `bypass`
    // argument is wired from `config.tools.exec.danger.bypass` (see
    // `configureDangerBypass`); rule ids in that set are skipped.
    const danger: DangerAssessment = detectDanger(cmd, args, dangerBypass);

    // Kill guard: check if the command targets protected WrongStack processes
    // (taskkill /F /IM node.exe, Stop-Process -Name node, wmic process delete, etc.)
    const killCheck = await checkExecKillCommand(cmd, args);
    if (killCheck.blocked) {
      return {
        command: cmd,
        args,
        stdout: '',
        stderr: killCheck.reason ?? 'Kill command blocked: targets a protected WrongStack process.',
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger,
      };
    }

    // Validate args against per-command security patterns
    const argError = validateArgs(cmd, args);
    if (argError) {
      return {
        command: cmd,
        args,
        stdout: '',
        stderr: argError,
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger,
      };
    }

    // Default cwd is the SESSION working dir (set via `set_working_dir`),
    // falling back to the launch cwd. Historically this ignored `workingDir`,
    // so `set_working_dir` silently had no effect on exec.
    const defaultCwd = ctx.workingDir ?? ctx.cwd;
    let cwd: string;
    try {
      // Resolve cwd inside the project root and verify realpath containment so
      // an in-project symlink cannot redirect allowlisted commands outside.
      cwd = input.cwd
        ? await safeResolveReal(input.cwd, ctx)
        : await safeResolveReal(defaultCwd, ctx);
    } catch {
      return {
        command: cmd,
        args,
        stdout: '',
        stderr: `cwd "${input.cwd ?? defaultCwd}" resolves outside project root`,
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger,
      };
    }
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    if (signal.aborted) {
      return {
        command: cmd,
        args,
        stdout: '',
        stderr: 'Aborted',
        exitCode: 124,
        truncated: false,
        allowed: true,
        danger,
      };
    }

    return runCommand(cmd, args, cwd, timeout, signal, ctx.session?.id, danger);
  },

  async cleanup(_input: ExecInput, ctx: Context): Promise<void> {
    const registry = getProcessRegistry();
    const sessionId = ctx.session?.id;
    if (!sessionId) return;
    for (const entry of registry.bySession(sessionId)) {
      if (entry.name !== 'exec') continue;
      if (entry.child && entry.child.exitCode !== null) continue;
      if (entry.protected) continue;
      registry.kill(entry.pid, { force: true });
    }
  },
};

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number,
  signal: AbortSignal,
  sessionId: string | undefined,
  danger: DangerAssessment,
): Promise<ExecOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const resolvedOnce = { value: false };
    const finish = (result: ExecOutput): void => {
      // Guard against double-resolve: 'error' and 'close' can both fire for
      // the same abort (Node's abort path emits both), and resolving twice
      // is a no-op but the extra work (normalizeCommandOutput, registry
      // bookkeeping, spool finalize) is wasted. First writer wins.
      if (resolvedOnce.value) return;
      resolvedOnce.value = true;
      resolve(result);
    };
    const startedAt = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let telemetryCompleted = false;
    let timedOut = false;
    const spool = createOutputSpool({ tool: `exec-${cmd}`, thresholdBytes: MAX_OUTPUT });

    if (signal.aborted) {
      spool.finalize();
      finish({
        command: cmd,
        args,
        stdout: '',
        stderr: 'Aborted',
        exitCode: 124,
        truncated: false,
        allowed: true,
        danger,
      });
      return;
    }

    // On Windows, .cmd/.bat files are not natively executable by CreateProcess.
    // resolveWin32Command() finds the full path, then the shim helper launches
    // it through cmd.exe without Node's deprecated shell+args path.
    const resolved = resolveWin32Command(cmd);
    const needsShell = isWin && (resolved.endsWith('.cmd') || resolved.endsWith('.bat'));
    const shim = needsShell ? buildWin32CmdShimInvocation(resolved, args) : null;
    const spawnCmd = shim?.command ?? resolved;
    const spawnArgs = shim?.args ?? args;

    const emitCompletedOnce = (
      exitCode: number,
      pid: number | undefined,
      signal?: string | undefined,
    ): void => {
      if (telemetryCompleted) return;
      telemetryCompleted = true;
      emitProcessCompleted({
        ...(pid !== undefined ? { pid } : {}),
        exitCode,
        ...(signal ? { signal } : {}),
        durationMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        timedOut,
        endedAt: new Date().toISOString(),
      });
    };

    // Wrap the entire spawn lifecycle in try/catch so a synchronous throw
    // (bad argv, ENOENT for missing binary, ERR_INVALID_ARG_TYPE for bad
    // signal, etc.) resolves the promise with an error response instead
    // of producing an unhandled rejection. Without this guard the
    // promise executor itself can throw, which Node treats as an
    // unhandled rejection and surfaces in process.on('unhandledRejection').
    let child: ReturnType<typeof spawn>;
    try {
      // On Windows the abort signal is handled manually below: Node's built-in
      // handling kills only the direct child, orphaning grandchildren (vitest
      // forks, dev servers, anything under a .cmd shim) that keep the inherited
      // stdio pipes open. registry.kill() tree-kills via taskkill instead.
      child = spawn(spawnCmd, spawnArgs, {
        cwd,
        env: buildChildEnv(sessionId),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(isWin ? {} : { signal }),
        ...(shim ? { windowsVerbatimArguments: shim.windowsVerbatimArguments } : {}),
      });
    } catch (err) {
      // spawn() can throw synchronously — e.g. ERR_INVALID_ARG_TYPE for a
      // malformed `signal`, or for some Node versions ENOENT when the binary
      // isn't on PATH. Convert to a graceful result so the tool caller
      // sees a structured error instead of an unhandled rejection that
      // would crash the host.
      spool.finalize();
      emitProcessStarted({
        parentPid: process.pid,
        command: redactCommand(`${cmd} ${args.join(' ')}`),
        args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
        cwd,
        background: false,
        startedAt: new Date(startedAt).toISOString(),
      });
      emitCompletedOnce(1, undefined);
      finish({
        command: cmd,
        args,
        stdout: '',
        stderr: `spawn failed: ${toErrorMessage(err)}`,
        exitCode: 1,
        truncated: false,
        allowed: true,
        danger,
      });
      return;
    }

    emitProcessStarted({
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      parentPid: process.pid,
      command: redactCommand(`${cmd} ${args.join(' ')}`),
      args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
      cwd,
      background: false,
      startedAt: new Date(startedAt).toISOString(),
    });

    // Attach the 'error' listener IMMEDIATELY after spawn, BEFORE any other
    // async setup (process registry call, setTimeout, abort listener). The
    // Node EventEmitter contract is that an 'error' event with no listener
    // rethrows on nextTick and crashes the entire process — this is the
    // exact failure mode issue #99 describes. Attach first, then do the
    // bookkeeping, so an abort / ENOENT / EPIPE that fires between spawn
    // and the rest of setup still has a listener attached.
    child.on('error', (err) => {
      // Distinguish an abort from a true spawn failure so the caller can
      // tell "the user cancelled this" apart from "the binary is missing".
      // The signal passed to spawn() is an AbortSignal; Node internally
      // converts the abort into an AbortError with `code: 'ABORT_ERR'`.
      const isAbort = err && (err as NodeJS.ErrnoException).code === 'ABORT_ERR';
      const stderrText = isAbort ? `Aborted: ${err.message}` : err.message;
      clearTimeout(timer);
      if (isWin) signal.removeEventListener('abort', onAbort);
      if (typeof pid === 'number') registry.unregister(pid);
      registry.afterCall(Date.now() - startedAt, true);
      spool.finalize();
      emitCompletedOnce(isAbort ? 124 : 1, child.pid, isAbort ? 'ABORT' : undefined);
      finish({
        command: cmd,
        args,
        stdout: normalizeCommandOutput(stdout),
        stderr: stderrText,
        exitCode: isAbort ? 124 : 1,
        truncated: Buffer.byteLength(stdout, 'utf8') > COMMAND_OUTPUT_MAX_BYTES,
        allowed: true,
        danger,
      });
    });

    const registry = getProcessRegistry();
    const pid = child.pid;
    if (typeof pid === 'number') {
      const fullCommand = `${cmd} ${args.join(' ')}`;
      registry.register({
        pid,
        name: 'exec',
        command: redactCommand(fullCommand),
        startedAt: Date.now(),
        sessionId,
        child,
      });
    }

    const timer = setTimeout(() => {
      killed = true;
      timedOut = true;
      if (typeof pid === 'number') registry.kill(pid);
      else child.kill('SIGTERM');
    }, timeout);

    const onAbort = () => {
      killed = true;
      if (typeof pid === 'number') registry.kill(pid, { force: true });
      else child.kill('SIGTERM');
    };
    if (isWin) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      stdoutBytes += chunk.byteLength;
      emitProcessOutput({ pid, stream: 'stdout', chunk });
      if (text.length > 0) {
        if (stdout.length < MAX_OUTPUT) stdout += text.slice(0, MAX_OUTPUT - stdout.length);
        spool.write(text);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      stderrBytes += chunk.byteLength;
      emitProcessOutput({ pid, stream: 'stderr', chunk });
      if (text.length > 0) {
        if (stderr.length < MAX_OUTPUT) stderr += text.slice(0, MAX_OUTPUT - stderr.length);
        spool.write(text);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (isWin) signal.removeEventListener('abort', onAbort);
      if (typeof pid === 'number') registry.unregister(pid);
      const durationMs = Date.now() - startedAt;
      const exitCode = killed ? 124 : (code ?? 1);
      emitCompletedOnce(exitCode, pid);
      registry.afterCall(durationMs, exitCode !== 0);
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail) {
        if (stdout.length < MAX_OUTPUT) stdout += stdoutTail.slice(0, MAX_OUTPUT - stdout.length);
        spool.write(stdoutTail);
      }
      const stderrTail = stderrDecoder.end();
      if (stderrTail) {
        if (stderr.length < MAX_OUTPUT) stderr += stderrTail.slice(0, MAX_OUTPUT - stderr.length);
        spool.write(stderrTail);
      }
      const spooled = spool.finalize();
      const isTruncated =
        stdoutBytes > MAX_OUTPUT ||
        stderrBytes > MAX_OUTPUT ||
        Buffer.byteLength(stdout, 'utf8') > COMMAND_OUTPUT_MAX_BYTES ||
        Buffer.byteLength(stderr, 'utf8') > COMMAND_OUTPUT_MAX_BYTES;
      finish({
        command: cmd,
        args,
        stdout: normalizeCommandOutput(stdout) + (spooled ? spoolNote(spooled) : ''),
        stderr: normalizeCommandOutput(stderr),
        exitCode,
        truncated: isTruncated,
        allowed: true,
        danger,
      });
    });
  });
}
