import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Tool } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  emitProcessCompleted,
  emitProcessOutput,
  emitProcessStarted,
} from '@wrongstack/core/observability';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { type DangerAssessment, detectDanger } from './_danger-detect.js';
import { buildChildEnv } from './_env.js';
import { createOutputSpool, finishCommandOutput } from './_output-spool.js';
import {
  commandOutputPreviewBytes,
  createCommandOutputCapture,
  normalizeCommandOutput,
  safeResolveReal,
} from './_util.js';
import {
  buildWin32CmdShimInvocation,
  isWinCmdShim,
  resolveWin32Command,
} from './_win32-resolve.js';
import { DEFAULT_ALLOWED_COMMANDS } from './exec-allowlist.js';
import { validateArgs } from './exec-arg-validation.js';
import { execSafetyCommandName, normalizeExecCommandName } from './exec-command-name.js';
import { validateGitDevelopmentArgs } from './exec-git-development-args.js';
import { checkExecKillCommand } from './exec-kill-guard.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';

const isWin = process.platform === 'win32';

// The live, effective allowlist: DEFAULT ∪ config.allow − config.deny. Replaced
// wholesale by configureExecPolicy(); defaults until boot wires the config.
let allowedCommands: Set<string> = new Set([...DEFAULT_ALLOWED_COMMANDS].map(normalizeCmd));
let deniedCommands: Set<string> = new Set();

function normalizeCmd(c: string): string {
  return normalizeExecCommandName(c);
}

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
  const next = new Set([...DEFAULT_ALLOWED_COMMANDS].map(normalizeCmd));
  for (const c of opts.allow ?? []) {
    const n = normalizeCmd(c);
    if (n) next.add(n);
  }
  for (const c of opts.deny ?? []) next.delete(normalizeCmd(c));
  deniedCommands = new Set((opts.deny ?? []).map(normalizeCmd).filter(Boolean));
  allowedCommands = next;
}

/** Reset the exec allowlist to the built-in defaults (tests / re-init). */
export function resetExecPolicy(): void {
  allowedCommands = new Set([...DEFAULT_ALLOWED_COMMANDS].map(normalizeCmd));
  deniedCommands = new Set();
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

const DEFAULT_TIMEOUT_MS = 30_000;
// Hard ceiling for the per-call `timeout` parameter. The old clamp used
// DEFAULT_TIMEOUT_MS as the ceiling too, which silently capped EVERY call at
// 30s no matter what the model asked for — long builds/test runs then died
// at 30s with exit 124 and no explanation. 10 minutes matches bash's ceiling.
const MAX_TIMEOUT_MS = 600_000;

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
  /**
   * Always true on a returned result: refusals (allowlist miss, blocked args,
   * kill guard, cwd containment, circuit breaker) THROW instead, so the
   * executor records them as failed calls. Kept for output-shape stability.
   */
  allowed: boolean;
  /**
   * Heuristic danger assessment of the (cmd, args) pair. Populated for every
   * call that ran so the UI/TUI can render a banner when the level is
   * 'caution' or 'destructive'. See `_danger-detect.ts` for the rule set.
   */
  danger: DangerAssessment;
}

export const execTool: Tool<ExecInput, ExecOutput> = {
  name: 'exec',
  category: 'Shell',
  description:
    'Execute a command directly with argument validation and permission gating. Outside YOLO, the curated command roster applies; YOLO/YOLO+ accept other executables while explicit tools.exec.deny entries still refuse. ' +
    'This is the **preferred** alternative to the `bash` tool for running development tools (node, npm, pnpm, tsc, git, tests, linters, etc.). ' +
    'It is NOT a sandbox — several rostered commands (node, python, powershell, …) can run arbitrary code — so prefer least-privilege commands.',
  usageHint:
    'PREFERRED SHELL TOOL for most cases.\n\n' +
    'Use this instead of `bash` whenever possible.\n' +
    '- Outside YOLO, `command` must be in the allowlist. Defaults cover common development toolchains; extend them with `tools.exec.allow`. YOLO/YOLO+ permit additional executables; explicit `tools.exec.deny` entries still refuse.\n' +
    '- Supply only the executable in `command` (e.g. "uv") and put subcommands/options in `args` (e.g. ["run", "pytest"]). Windows executable suffixes and casing are normalized for policy checks; explicit paths require their own trusted allow entry.\n' +
    '- Arguments are passed as a clean array (no shell interpretation).\n' +
    '- In YOLO/YOLO+, Git global `-C <directory>` options follow the configured filesystem scope, and temporary color, line-ending, long-path and diff settings via `-c key=value` are accepted.\n' +
    '- `cwd` is validated to stay inside the project.\n' +
    '- If a command is not allowlisted, the error explains how to add it; for one-off arbitrary commands, fall back to `bash` (with strong justification).\n' +
    'The curated roster + confirm gating narrows the surface compared to full shell access, ' +
    'but this is not a sandbox — prefer least-privilege commands.',
  selection: {
    doNotUseWhen:
      'the operation requires pipes, redirection or shell expansion; outside YOLO, a non-allowlisted command also needs bash or an explicit config allowance.',
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
  // The tool owns its command timer and tree-kill settlement. Prompt mode
  // has a ten-minute ceiling; YOLO honors longer explicit durations and 0.
  // Keep only parent cancellation in the executor so its default ceiling
  // cannot interrupt a command the operator authorized for longer.
  managesOwnTimeout: true,
  timeoutMs: MAX_TIMEOUT_MS + 10_000,
  capabilities: ['shell.restricted'],
  icon: 'terminal',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Executable name or path. Outside YOLO it must be in the command roster; explicit tools.exec.deny entries apply in every mode.',
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
        description:
          'Per-command timeout in milliseconds (default 30000; prompt-mode max 600000). In YOLO/YOLO+, longer explicit timeouts are honored and 0 disables the command timer; parent cancellation still applies.',
      },
    },
    required: ['command'],
  },
  // Refusals (breaker, allowlist, blocked args, kill guard, cwd containment)
  // and launch failures THROW: a returned `allowed: false` / `exitCode: 1`
  // payload was recorded by the executor as a successful call. Non-zero
  // exits, timeouts and aborts remain data (the command did run).
  async execute(input, ctx, opts) {
    const registry = getProcessRegistry();
    if (!registry.canProceed) {
      throw new Error(
        'exec: circuit breaker is open — too many consecutive failures. Use /kill reset to recover.',
      );
    }

    const cmd = (input.command ?? '').trim();
    if (!cmd) throw new Error('exec: empty command');

    const unattended = opts?.autonomy === 'yolo' || opts?.autonomy === 'yolo-plus';
    const safetyCmd = execSafetyCommandName(cmd);
    if (deniedCommands.has(normalizeCmd(cmd)) || deniedCommands.has(safetyCmd)) {
      throw new Error(`exec: command "${cmd}" is explicitly denied by tools.exec.deny.`);
    }
    if (!unattended && !isExecCommandAllowed(cmd)) {
      throw new Error(
        `exec: command "${cmd}" not in allowlist. ` +
          `Add it to your active profile config (~/.wrongstack/profiles/<name>/config.json) ` +
          `under "tools": { "exec": { "allow": ["${cmd}"] } }, ` +
          `or use the bash tool for one-off arbitrary commands.`,
      );
    }

    const args = [...(input.args ?? [])];
    const rawTimeout =
      typeof input.timeout === 'number' && !Number.isNaN(input.timeout)
        ? input.timeout
        : DEFAULT_TIMEOUT_MS;
    const timeout =
      unattended && rawTimeout === 0
        ? undefined
        : Math.max(1, Math.min(rawTimeout, unattended ? 2_147_483_647 : MAX_TIMEOUT_MS));

    // Heuristic danger assessment. Computed once here, attached to every
    // return from this point on (including error returns) so the UI can
    // render a banner for 'caution' / 'destructive' levels. The `bypass`
    // argument is wired from `config.tools.exec.danger.bypass` (see
    // `configureDangerBypass`); rule ids in that set are skipped.
    let danger: DangerAssessment = detectDanger(safetyCmd, args, dangerBypass);

    // Kill guard: check if the command targets protected WrongStack processes
    // (taskkill /F /IM node.exe, Stop-Process -Name node, wmic process delete, etc.)
    const killCheck = await checkExecKillCommand(safetyCmd, args);
    if (killCheck.blocked) {
      throw new Error(
        `exec: ${killCheck.reason ?? 'Kill command blocked: targets a protected WrongStack process.'}`,
      );
    }

    // Default cwd is the SESSION working dir (set via `set_working_dir`),
    // falling back to the launch cwd. Historically this ignored `workingDir`,
    // so `set_working_dir` silently had no effect on exec.
    const defaultCwd = ctx.workingDir ?? ctx.cwd;
    const resolveCwd = async (): Promise<string> => {
      try {
        // Resolve cwd inside the project root and verify realpath containment so
        // an in-project symlink cannot redirect allowlisted commands outside.
        return input.cwd
          ? await safeResolveReal(input.cwd, ctx)
          : await safeResolveReal(defaultCwd, ctx);
      } catch (err) {
        throw new Error(`exec: cwd "${input.cwd ?? defaultCwd}" resolves outside project root`, {
          cause: err,
        });
      }
    };
    let cwd: string | undefined;
    let validatedGitArgumentIndexes: ReadonlySet<number> | undefined;
    if (unattended && safetyCmd === 'git') {
      cwd = await resolveCwd();
      const validatedGitArgs = await validateGitDevelopmentArgs(args, ctx, cwd);
      validatedGitArgumentIndexes = validatedGitArgs;
      if (validatedGitArgs.size > 0) {
        danger = detectDanger(
          safetyCmd,
          args.filter((_arg, index) => !validatedGitArgs.has(index)),
          dangerBypass,
        );
      }
    }
    const argError = validateArgs(safetyCmd, args, {
      allowPublish: unattended,
      validatedGitArgumentIndexes,
    });
    if (argError) throw new Error(`exec: ${argError}`);
    cwd ??= await resolveCwd();
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

    if (!registry.beforeCall()) {
      throw new Error(
        'exec: circuit breaker is open — too many consecutive failures. Use /kill reset to recover.',
      );
    }

    return runCommand(cmd, args, cwd, timeout, signal, ctx.session?.id, danger);
  },

  async cleanup(_input: ExecInput, ctx: Context): Promise<void> {
    const registry = getProcessRegistry();
    const sessionId = ctx.session?.id;
    if (!sessionId) return;
    for (const entry of registry.bySession(sessionId)) {
      if (entry.name !== 'exec') continue;
      if (entry.child && (entry.child.exitCode != null || entry.child.signalCode != null)) continue;
      if (entry.protected) continue;
      registry.kill(entry.pid, { force: true });
    }
  },
};

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number | undefined,
  signal: AbortSignal,
  sessionId: string | undefined,
  danger: DangerAssessment,
): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    // Head + rolling tail of each stream: a build or a test run prints its
    // verdict last, and a head-only buffer cut exactly that off.
    const previewBytes = commandOutputPreviewBytes();
    const stdout = createCommandOutputCapture(previewBytes);
    const stderr = createCommandOutputCapture(previewBytes);
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
    // A process that never ran (spawn threw, binary missing, EACCES) is a
    // failed call, not an exit-code result — reject so the executor records it.
    const fail = (err: Error): void => {
      if (resolvedOnce.value) return;
      resolvedOnce.value = true;
      reject(err);
    };
    const startedAt = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let telemetryCompleted = false;
    let timedOut = false;
    // Spool from the preview size, not the in-memory cap: output between the
    // two was head/tail-cut for the model yet never written to the spool.
    const spool = createOutputSpool({
      tool: `exec-${cmd}`,
      thresholdBytes: commandOutputPreviewBytes(),
    });

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
    // (bad argv, win32 cmd shim metacharacter error, ENOENT for missing binary,
    // ERR_INVALID_ARG_TYPE for bad signal, etc.) resolves the promise with an
    // error response instead of producing an unhandled rejection. Without this
    // guard the promise executor itself can throw, which Node treats as an
    // unhandled rejection and surfaces in process.on('unhandledRejection').
    let child: ReturnType<typeof spawn>;
    try {
      // On Windows, .cmd/.bat files are not natively executable by CreateProcess.
      // resolveWin32Command() finds the full path, then the shim helper launches
      // it through cmd.exe without Node's deprecated shell+args path.
      const resolved = resolveWin32Command(cmd);
      const needsShell = isWin && isWinCmdShim(resolved);
      const shim = needsShell ? buildWin32CmdShimInvocation(resolved, args) : null;
      const spawnCmd = shim?.command ?? resolved;
      const spawnArgs = shim?.args ?? args;

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
      // Mirror the child-'error' handler: a failed spawn is a breaker-counted
      // failure. (registry is declared below the catch — use the getter here.)
      getProcessRegistry().afterCall(Date.now() - startedAt, true);
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
      fail(new Error(`exec: spawn failed: ${toErrorMessage(err)}`, { cause: err }));
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

    const registry = getProcessRegistry();
    const pid = child.pid;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      killed = true;
      if (typeof pid === 'number') registry.kill(pid, { force: true });
      else child.kill('SIGTERM');
    };

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
      if (timer !== undefined) clearTimeout(timer);
      if (isWin) signal.removeEventListener('abort', onAbort);
      if (typeof pid === 'number') registry.unregister(pid);
      registry.afterCall(Date.now() - startedAt, true);
      spool.finalize();
      emitCompletedOnce(isAbort ? 124 : 1, child.pid, isAbort ? 'ABORT' : undefined);
      if (!isAbort) {
        fail(new Error(`exec: process error: ${err.message}`, { cause: err }));
        return;
      }
      finish({
        command: cmd,
        args,
        stdout: normalizeCommandOutput(stdout.text()),
        stderr: `Aborted: ${err.message}`,
        exitCode: 124,
        truncated: stdoutBytes > previewBytes,
        allowed: true,
        danger,
      });
    });

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

    if (timeout !== undefined) {
      timer = setTimeout(() => {
        killed = true;
        timedOut = true;
        if (typeof pid === 'number') registry.kill(pid);
        else child.kill('SIGTERM');
      }, timeout);
    }

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
        stdout.push(text);
        spool.write(text);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      stderrBytes += chunk.byteLength;
      emitProcessOutput({ pid, stream: 'stderr', chunk });
      if (text.length > 0) {
        stderr.push(text);
        spool.write(text);
      }
    });

    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (isWin) signal.removeEventListener('abort', onAbort);
      if (typeof pid === 'number') registry.unregister(pid);
      if (resolvedOnce.value) return;
      const durationMs = Date.now() - startedAt;
      const exitCode = killed ? 124 : (code ?? 1);
      emitCompletedOnce(exitCode, pid);
      registry.afterCall(durationMs, exitCode !== 0);
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail) {
        stdout.push(stdoutTail);
        spool.write(stdoutTail);
      }
      const stderrTail = stderrDecoder.end();
      if (stderrTail) {
        stderr.push(stderrTail);
        spool.write(stderrTail);
      }
      // The command-aware diet (`_output-diet.ts`) reads stdout, where test
      // runners and installers print; stderr keeps the plain normalization.
      finish({
        command: cmd,
        args,
        stdout: finishCommandOutput(spool, stdout.text(), [cmd, ...args].join(' ')),
        stderr: normalizeCommandOutput(stderr.text()),
        exitCode,
        truncated: stdoutBytes > previewBytes || stderrBytes > previewBytes,
        allowed: true,
        danger,
      });
    });
  });
}
