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
import { toErrorMessage } from '@wrongstack/core/utils';
import { detectDanger } from './_danger-detect.js';
import { buildChildEnv } from './_env.js';
import { createOutputSpool, spoolNote } from './_output-spool.js';
import { diagnoseBashism, shellArgs } from './_shell-pick.js';
import { commandOutputPreviewBytes, normalizeCommandOutput, safeResolveReal } from './_util.js';
import { resolvePowerShell } from './_win32-resolve.js';
import { closeBackgroundLogFd, openBackgroundLog } from './background-log.js';
import { checkAndBlockKillCommand } from './bash-kill-guard.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';
import { mergeDanger, tokenizePwshCommand, wrapPwshCommand } from './pwsh-command.js';
import type { PwshInput, PwshOutput } from './pwsh-types.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const STREAM_FLUSH_INTERVAL_MS = 200;
const STREAM_FLUSH_BYTES = 4 * 1024;
const MAX_QUEUE_CHUNKS = 500;

/** `pwsh` tool execution: spawn, stream output, and settle the final result. */
export async function* executePwshStream(
  ...executionArgs: Parameters<NonNullable<Tool<PwshInput, PwshOutput>['executeStream']>>
): AsyncGenerator<ToolStreamEvent<PwshOutput>> {
  const [input, ctx, opts] = executionArgs;
  if (!input?.command || typeof input.command !== 'string' || !input.command.trim()) {
    throw new ToolValidationError({
      message: 'pwsh: command is required and cannot be empty',
      field: 'command',
    });
  }

  const callerSignal = opts?.signal ?? ctx?.signal ?? new AbortController().signal;
  if (callerSignal.aborted) {
    yield {
      type: 'final',
      output: {
        output: '',
        exit_code: 124,
        timed_out: false,
        pid: null,
        error: 'Aborted',
      },
    };
    return;
  }

  const killCheck = await checkAndBlockKillCommand(input.command);
  if (killCheck.blocked) {
    throw new Error(`pwsh: ${killCheck.reason}`);
  }

  const isWin = os.platform() === 'win32';
  const bin = isWin ? resolvePowerShell('pwsh.exe') : 'pwsh';
  const encodedCommand = Buffer.from(wrapPwshCommand(input.command), 'utf16le').toString('base64');
  const args = [...shellArgs('pwsh'), encodedCommand];

  let targetCwd: string;
  try {
    targetCwd = await safeResolveReal(input.workdir ?? ctx.workingDir ?? ctx.projectRoot, ctx);
  } catch (err) {
    throw new Error(`pwsh: ${(err as Error).message}`, { cause: err });
  }

  const isBackground = !!(input.run_in_background || input.background);
  const registry = getProcessRegistry();

  // Refusals and launch failures below THROW: a returned `error` field is
  // recorded by the executor as a successful call. Non-zero exits, timeouts
  // and aborts remain data (the command did run).
  if (!registry.beforeCall(isBackground)) {
    throw new Error(
      'pwsh: circuit breaker open — too many consecutive failures or slow calls. Use /kill to inspect or /kill reset to recover.',
    );
  }

  const env = buildChildEnv(ctx.session?.id);
  const startedAt = Date.now();
  const detached = !isWin;

  if (isBackground) {
    // Output goes to a file the child writes itself (see background-log.ts).
    const bgLog = openBackgroundLog(ctx.projectRoot, 'pwsh', registry.logFiles());
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd: targetCwd,
        env,
        detached,
        stdio: ['ignore', bgLog?.fd ?? 'ignore', bgLog?.fd ?? 'ignore'],
        windowsHide: true,
      });
    } catch (err) {
      closeBackgroundLogFd(bgLog);
      // Spawn threw — release the breaker reservation the successful
      // beforeCall(isBackground) took, mirroring the child 'error'/'close'
      // handlers below.
      registry.afterCall(Date.now() - startedAt, true, isBackground);
      emitProcessStarted({
        parentPid: process.pid,
        command: redactCommand(`${bin} ${args.join(' ')}`),
        args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
        cwd: targetCwd,
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
      throw new Error(`pwsh: spawn failed: ${toErrorMessage(err)}`, {
        cause: err,
      });
    }

    closeBackgroundLogFd(bgLog);
    const pid = child.pid;
    let bgTelemetryCompleted = false;
    let bgErrorOccurred = false;
    // Set by the close handler below so a late 'error' after 'close'
    // cannot double-record an already-settled call.
    let bgSettled = false;

    emitProcessStarted({
      ...(pid !== undefined ? { pid } : {}),
      parentPid: process.pid,
      command: redactCommand(`${bin} ${args.join(' ')}`),
      args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
      cwd: targetCwd,
      background: true,
      startedAt: new Date(startedAt).toISOString(),
    });

    const completeBackground = (exitCode: number, sig?: string | undefined) => {
      if (bgTelemetryCompleted) return;
      bgTelemetryCompleted = true;
      emitProcessCompleted({
        ...(pid !== undefined ? { pid } : {}),
        exitCode,
        ...(sig ? { signal: sig } : {}),
        durationMs: Date.now() - startedAt,
        stdoutBytes: 0,
        stderrBytes: 0,
        timedOut: false,
        endedAt: new Date().toISOString(),
      });
    };

    if (typeof pid === 'number') {
      registry.register({
        pid,
        name: 'pwsh',
        command: redactCommand(input.command),
        startedAt: Date.now(),
        sessionId: ctx.session?.id,
        child,
        processGroupLeader: detached && child.pid === pid,
        background: true,
        ...(bgLog ? { logFile: bgLog.path } : {}),
      });

      child.on('close', (code, signal) => {
        bgSettled = true;
        registry.unregister(pid);
        if (bgErrorOccurred) return;
        const failed = (code !== 0 && code !== null) || !!signal;
        registry.afterCall(Date.now() - startedAt, failed, isBackground);
        completeBackground(code ?? (signal ? 1 : 0), signal ?? undefined);
      });

      child.on('error', () => {
        if (bgSettled) return;
        // No unregister on 'error': it does not imply the child terminated
        // (Node also emits it for failed kills while the child is still
        // alive), and the 'close' handler above owns unregistering.
        // Keeping the entry keeps a still-alive process visible to /ps,
        // killAll and session cleanup (chimera Medium, mirrors bash.ts).
        bgErrorOccurred = true;
        registry.afterCall(Date.now() - startedAt, true, isBackground);
        completeBackground(1);
      });

      child.unref();

      const jobId = `job_${pid}`;
      ctx.recordSideEffect?.({
        toolUseId: `pwsh-bg-${Date.now()}`,
        toolName: 'pwsh',
        ts: new Date().toISOString(),
        input: { command: redactCommand(input.command), background: true },
        outcome: `started background job ${jobId} (PID: ${pid})`,
        risk: 'shell',
      });

      yield {
        type: 'final',
        output: {
          output: `Background job started: ${jobId} (PID: ${pid})\nWorking directory: ${targetCwd}`,
          exit_code: null,
          timed_out: false,
          pid,
          job_id: jobId,
          ...(bgLog ? { log_file: bgLog.path } : {}),
        },
      };
      return;
    }

    completeBackground(1);
    throw new Error('pwsh: failed to obtain PID for background process');
  }

  // Foreground / Synchronous execution
  const previewBytes = commandOutputPreviewBytes();
  const spool = createOutputSpool({ tool: 'pwsh', thresholdBytes: previewBytes });
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, args, {
      cwd: targetCwd,
      env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    // Spawn threw — release the breaker reservation the successful
    // beforeCall(isBackground) took, mirroring the child 'error' handler.
    registry.afterCall(Date.now() - startedAt, true, isBackground);
    spool.finalize();
    emitProcessStarted({
      parentPid: process.pid,
      command: redactCommand(`${bin} ${args.join(' ')}`),
      args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
      cwd: targetCwd,
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
    throw new Error(`pwsh: spawn failed: ${toErrorMessage(err)}`, {
      cause: err,
    });
  }

  const pid = child.pid;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let telemetryCompleted = false;

  emitProcessStarted({
    ...(pid !== undefined ? { pid } : {}),
    parentPid: process.pid,
    command: redactCommand(`${bin} ${args.join(' ')}`),
    args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
    cwd: targetCwd,
    background: false,
    startedAt: new Date(startedAt).toISOString(),
  });

  const completeForeground = (exitCode: number, sig?: string | undefined) => {
    if (telemetryCompleted) return;
    telemetryCompleted = true;
    emitProcessCompleted({
      ...(pid !== undefined ? { pid } : {}),
      exitCode,
      ...(sig ? { signal: sig } : {}),
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
      name: 'pwsh',
      command: redactCommand(input.command),
      startedAt: Date.now(),
      sessionId: ctx.session?.id,
      child,
      processGroupLeader: detached && child.pid === pid,
    });
  }

  const rawTimeout =
    typeof input.timeout_ms === 'number' && !Number.isNaN(input.timeout_ms)
      ? input.timeout_ms
      : DEFAULT_TIMEOUT_MS;
  // 0 = no wall-clock limit (still aborted by the caller's signal).
  const timeoutMs = rawTimeout === 0 ? undefined : Math.min(Math.max(1_000, rawTimeout), 600_000);

  let timedOut = false;
  const timers: NodeJS.Timeout[] = [];

  const killWithTimeout = (timeout: number) => {
    if (isWin) {
      if (typeof child.pid === 'number' && child.exitCode === null) {
        const attempted = registry.kill(child.pid, { force: true, graceMs: timeout });
        if (!attempted) {
          try {
            child.kill();
          } catch (err) {
            // Both the registry kill and the direct kill failed — the
            // timed-out child is leaked. Surface it instead of swallowing
            // silently so an operator can chase the process.
            console.log(
              JSON.stringify({
                level: 'warn',
                event: 'pwsh.kill_fallback_failed',
                pid: child.pid,
                platform: process.platform,
                error: toErrorMessage(err),
                message:
                  'pwsh child.kill() raised after the registry kill failed; process may be leaked',
              }),
            );
          }
        }
      }
      return;
    }
    if (typeof child.pid === 'number') {
      registry.kill(child.pid, { graceMs: timeout });
    } else {
      try {
        child.kill('SIGTERM');
      } catch (err) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'pwsh.sigterm_failed',
            platform: process.platform,
            error: toErrorMessage(err),
            message: 'pwsh child.kill("SIGTERM") raised on POSIX fallback; process may be leaked',
          }),
        );
      }
    }
  };

  if (timeoutMs !== undefined) {
    const timer = setTimeout(() => {
      timedOut = true;
      killWithTimeout(2000);
    }, timeoutMs);
    timers.push(timer);
  }

  const onAbort = () => killWithTimeout(2000);
  if (callerSignal.aborted) onAbort();
  else callerSignal.addEventListener('abort', onAbort, { once: true });

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

  let buf = '';
  let pending = '';
  let lastFlush = Date.now();
  const flush = () => {
    if (pending.length === 0) return null;
    const text = pending;
    pending = '';
    lastFlush = Date.now();
    return text;
  };

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

  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  const onData = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(chunk);
    if (stream === 'stdout') stdoutBytes += chunk.byteLength;
    else stderrBytes += chunk.byteLength;
    emitProcessOutput({ pid: pid ?? 0, stream, chunk });
    if (buf.length < previewBytes) {
      buf += text.slice(0, previewBytes - buf.length);
    }
    spool.write(text);
    pending += text;
    push({ kind: 'data', text });
    pauseIfFlooded();
  };

  const onStdoutData = (chunk: Buffer) => onData(chunk, 'stdout');
  const onStderrData = (chunk: Buffer) => onData(chunk, 'stderr');
  child.stdout?.on('data', onStdoutData);
  child.stderr?.on('data', onStderrData);

  let fgErrorOccurred = false;
  // Set synchronously inside the 'close' handler BEFORE pushing `end`, so
  // the generator can never observe end-of-stream without this flag being
  // observable in the finally block. Without it, the synchronous `return`
  // after consuming `end` raced Node's exitCode assignment and the finally
  // SIGKILLed a successfully-finished child (chimera Critical).
  let sawClose = false;
  child.on('error', (err) => {
    // Mirror of the close-handler guard below: Node may deliver 'error'
    // after 'close' (e.g. a failed kill on an already-reaped child). The
    // call has already settled, so a second afterCall would double-count
    // a breaker failure and this error chunk would never be consumed.
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

    const tail = stdoutDecoder.end() + stderrDecoder.end();
    if (tail) {
      if (buf.length < previewBytes) buf += tail.slice(0, previewBytes - buf.length);
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
          toolUseId: `pwsh-${Date.now()}`,
          toolName: 'pwsh',
          ts: new Date().toISOString(),
          input: { command: redactCommand(input.command) },
          outcome: isAbort ? 'aborted' : `error (${c.err.message})`,
          risk: 'shell',
        });
        if (!isAbort) {
          // The child process failed at the OS level (e.g. pwsh not
          // installed): a failed call, not an exit-code result.
          throw new Error(`pwsh: process error: ${c.err.message}`, { cause: c.err });
        }
        yield {
          type: 'final',
          output: {
            output: normalizeCommandOutput(buf) + (spooled ? spoolNote(spooled) : ''),
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
        const spooled = spool.finalize();
        let formattedOutput = normalizeCommandOutput(buf);
        if (c.code !== null && c.code !== 0 && !timedOut) {
          if (!formattedOutput.includes(`[exit code: ${c.code}]`)) {
            formattedOutput = formattedOutput
              ? `${formattedOutput}\n[exit code: ${c.code}]`
              : `[exit code: ${c.code}]`;
          }
        }

        // Auto-diagnosis on non-zero exit for common shell confusion
        const hint =
          !timedOut && typeof c.code === 'number' && c.code !== 0
            ? diagnoseBashism(input.command, 'pwsh')
            : undefined;

        // Classify the command under the argv shapes each rule family
        // expects, so none goes dark on this path:
        //   - `pwsh` + all tokens → PowerShell cmdlet rules
        //     (`Remove-Item -recurse -force …`);
        //   - first token as the program → native-binary rules
        //     (`chmod 777 …`, `git push --force …`), mirroring how the
        //     exec tool would see the same line;
        //   - the raw line → phrase scanners
        //     (`Set-ExecutionPolicy Bypass …`).
        const tokens = tokenizePwshCommand(input.command);
        const danger = mergeDanger(
          detectDanger('pwsh', tokens),
          detectDanger(tokens[0] ?? 'pwsh', tokens.slice(1)),
          detectDanger('pwsh', [input.command]),
        );
        const cautionText =
          danger.level === 'caution' && danger.reasons.length > 0
            ? `\n[caution: ${danger.reasons.join('; ')}]`
            : '';

        const finalResultText =
          formattedOutput +
          (spooled ? spoolNote(spooled) : '') +
          (hint ? `\n\n${hint}` : '') +
          cautionText;

        // One audit record per command: the error branch (above) already
        // recorded and returned when fgErrorOccurred is set — this
        // close-derived branch must never double-record (chimera Medium).
        if (!fgErrorOccurred) {
          ctx.recordSideEffect?.({
            toolUseId: `pwsh-${Date.now()}`,
            toolName: 'pwsh',
            ts: new Date().toISOString(),
            input: { command: redactCommand(input.command) },
            outcome: timedOut ? `timed out (exit ${c.code})` : `exit ${c.code}`,
            risk: 'shell',
          });
        }

        const isAborted = callerSignal.aborted;
        yield {
          type: 'final',
          output: {
            output: finalResultText,
            exit_code: timedOut || isAborted ? 124 : c.code,
            timed_out: timedOut || isAborted,
            pid: pid ?? null,
            ...(timedOut
              ? { error: 'Command timed out' }
              : isAborted
                ? { error: 'Command aborted by user or signal' }
                : {}),
          },
        };
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
    spool.finalize();
    callerSignal.removeEventListener('abort', onAbort);
    child.stdout?.off('data', onStdoutData);
    child.stderr?.off('data', onStderrData);
    child.stdout?.destroy();
    child.stderr?.destroy();
    // sawClose is set synchronously by the 'close' handler before `end` is
    // queued, so a normal completion can never race exitCode assignment
    // into a spurious SIGKILL (chimera Critical). Only a generator that
    // exited WITHOUT close (consumer break/throw while the child still
    // runs) reaches the kill here.
    if (!sawClose && child.exitCode === null && !child.killed) {
      if (typeof pid === 'number') registry.kill(pid, { force: true });
      else killWithTimeout(2000);
    }
  }
}
