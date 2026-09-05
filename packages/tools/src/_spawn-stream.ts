import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  emitProcessCompleted,
  emitProcessOutput,
  emitProcessStarted,
} from '@wrongstack/core/observability';
import type { ToolProgressEvent } from '@wrongstack/core/types';
import { buildChildEnv } from '@wrongstack/core/utils';
import { createOutputSpool, spoolNote } from './_output-spool.js';
import { buildWin32CmdShimInvocation, resolveWin32Command } from './_win32-resolve.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';

const isWin = process.platform === 'win32';
export interface SpawnStreamResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  error?: string | undefined;
  /** When the output exceeded maxBytes, the FULL output was spooled here. */
  spoolPath?: string | undefined;
  /** Total output bytes produced (only set when spooled). */
  spoolBytes?: number | undefined;
}

interface SpawnStreamOptions {
  cmd: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal | undefined;
  maxBytes?: number | undefined;
  /** Bytes of new stdout/stderr to accumulate before yielding a `partial_output` event. */
  flushBytes?: number | undefined;
  /** Maximum chunks to buffer before applying backpressure to the child. Default 500. */
  maxQueueSize?: number | undefined;
  /** Maximum UTF-8 bytes retained in the producer/consumer queue. Defaults to 1 MiB. */
  maxQueueBytes?: number | undefined;
}

/**
 * Spawn a child process and yield `partial_output` progress events as
 * stdout/stderr arrive (batched by byte threshold), then return the full
 * buffered result. Shared between install/lint/format/typecheck/test/audit
 * so the TUI live tail sees consistent progress regardless of which tool
 * is running.
 */
export async function* spawnStream(
  opts: SpawnStreamOptions,
): AsyncGenerator<ToolProgressEvent, SpawnStreamResult> {
  const signal = opts.signal;
  const max = opts.maxBytes ?? 999_999_999;
  const flushAt = opts.flushBytes ?? 4 * 1024;
  const maxQueue = opts.maxQueueSize ?? 500;
  const maxQueueBytes = opts.maxQueueBytes ?? 1024 * 1024;
  let stdout = '';
  let stderr = '';
  let stdoutRetainedBytes = 0;
  let stderrRetainedBytes = 0;
  let pending = '';
  let error: string | undefined;
  // Full-output spool: stdout/stderr keep only the first `max` bytes for the
  // model. Once the combined output exceeds that, the FULL stream goes to a
  // file and the result carries a marker — so a huge vitest/tsc run lands on
  // disk, not in the host heap or the chat history.
  const spool = createOutputSpool({ tool: opts.cmd, thresholdBytes: max });

  const resolved = resolveWin32Command(opts.cmd);
  const needsShell = isWin && (resolved.endsWith('.cmd') || resolved.endsWith('.bat'));
  const shim = needsShell ? buildWin32CmdShimInvocation(resolved, opts.args) : null;
  const cmd = shim?.command ?? resolved;
  const args = shim?.args ?? opts.args;

  // On Windows the abort signal is handled manually below instead of being
  // passed to spawn(): Node's built-in handling kills only the direct child.
  // With the .cmd/.bat shell wrapper the real command (vitest, tsc, …) is a
  // *grandchild* of cmd.exe — killing the wrapper orphans it, the orphan
  // keeps the inherited stdio pipes open (so 'close' never fires) and
  // streams into this process for the rest of the session. registry.kill()
  // tree-kills via taskkill /T instead — same rationale as bash.ts/exec.ts.
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: buildChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(isWin || !signal ? {} : { signal }),
    ...(shim ? { windowsVerbatimArguments: shim.windowsVerbatimArguments } : {}),
  });

  // Register with the global registry so Ctrl+C / /kill can find and
  // tree-kill it — spawnStream consumers (test/lint/typecheck/install/…)
  // were previously invisible to the registry.
  const registry = getProcessRegistry();
  const pid = child.pid;
  const processStartedAt = Date.now();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let telemetryCompleted = false;
  emitProcessStarted({
    ...(pid !== undefined ? { pid } : {}),
    parentPid: process.pid,
    command: redactCommand(`${opts.cmd} ${opts.args.join(' ')}`),
    args: redactCommand(opts.args.join(' ')).split(' ').filter(Boolean),
    cwd: opts.cwd,
    background: false,
    startedAt: new Date(processStartedAt).toISOString(),
  });
  if (typeof pid === 'number') {
    registry.register({
      pid,
      name: opts.cmd,
      command: redactCommand(`${opts.cmd} ${opts.args.join(' ')}`),
      startedAt: Date.now(),
      child,
    });
  }

  type Chunk = {
    kind: 'out' | 'err' | 'close' | 'error';
    data: string;
    bytes: number;
    code?: number | undefined;
    signal?: string | undefined;
  };
  const queue: Chunk[] = [];
  let queuedBytes = 0;
  let waiter: (() => void) | undefined;
  let paused = false;
  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w();
    }
  };

  // Resume the stream when there's room in the queue
  const resume = () => {
    if (
      paused &&
      queue.length <= Math.floor(maxQueue / 2) &&
      queuedBytes <= Math.floor(maxQueueBytes / 2)
    ) {
      paused = false;
      child.stdout?.resume();
      child.stderr?.resume();
    }
  };

  // Note: chunks may still arrive briefly after pause() (already in flight) —
  // they are accumulated and queued rather than dropped, so the queue can
  // overshoot maxQueue by a few entries but no output is silently lost.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  const onOut = (c: Buffer) => {
    const s = stdoutDecoder.write(c);
    stdoutBytes += c.byteLength;
    emitProcessOutput({ pid, stream: 'stdout', chunk: c });
    if (s.length > 0) {
      if (stdoutRetainedBytes < max) {
        const retained = utf8Prefix(s, max - stdoutRetainedBytes);
        stdout += retained;
        stdoutRetainedBytes += Buffer.byteLength(retained, 'utf8');
      }
      spool.write(s);
      queue.push({ kind: 'out', data: s, bytes: c.byteLength });
      queuedBytes += c.byteLength;
      wake();
    }
    // Apply backpressure if queue is growing faster than we consume
    if (!paused && (queue.length >= maxQueue || queuedBytes >= maxQueueBytes)) {
      paused = true;
      child.stdout?.pause();
      child.stderr?.pause();
    }
  };
  const onErr = (c: Buffer) => {
    const s = stderrDecoder.write(c);
    stderrBytes += c.byteLength;
    emitProcessOutput({ pid, stream: 'stderr', chunk: c });
    if (s.length > 0) {
      if (stderrRetainedBytes < max) {
        const retained = utf8Prefix(s, max - stderrRetainedBytes);
        stderr += retained;
        stderrRetainedBytes += Buffer.byteLength(retained, 'utf8');
      }
      spool.write(s);
      queue.push({ kind: 'err', data: s, bytes: c.byteLength });
      queuedBytes += c.byteLength;
      wake();
    }
    if (!paused && (queue.length >= maxQueue || queuedBytes >= maxQueueBytes)) {
      paused = true;
      child.stdout?.pause();
      child.stderr?.pause();
    }
  };
  child.stdout?.on('data', onOut);
  child.stderr?.on('data', onErr);
  child.on('error', (e) => {
    error = e.message;
    const bytes = Buffer.byteLength(e.message, 'utf8');
    queue.push({ kind: 'error', data: e.message, bytes });
    queuedBytes += bytes;
    wake();
  });
  const completeTelemetry = (code: number, signal?: string | undefined, timedOut = false) => {
    if (telemetryCompleted) return;
    telemetryCompleted = true;
    emitProcessCompleted({
      ...(pid !== undefined ? { pid } : {}),
      exitCode: code,
      ...(signal ? { signal } : {}),
      durationMs: Date.now() - processStartedAt,
      stdoutBytes,
      stderrBytes,
      timedOut,
      endedAt: new Date().toISOString(),
    });
  };
  child.on('close', (code, signal) => {
    if (typeof pid === 'number') registry.unregister(pid);
    const restOut = stdoutDecoder.end();
    if (restOut) {
      if (stdoutRetainedBytes < max) {
        const retained = utf8Prefix(restOut, max - stdoutRetainedBytes);
        stdout += retained;
        stdoutRetainedBytes += Buffer.byteLength(retained, 'utf8');
      }
      spool.write(restOut);
      queue.push({ kind: 'out', data: restOut, bytes: 0 });
    }
    const restErr = stderrDecoder.end();
    if (restErr) {
      if (stderrRetainedBytes < max) {
        const retained = utf8Prefix(restErr, max - stderrRetainedBytes);
        stderr += retained;
        stderrRetainedBytes += Buffer.byteLength(retained, 'utf8');
      }
      spool.write(restErr);
      queue.push({ kind: 'err', data: restErr, bytes: 0 });
    }
    const exitCode = code ?? (signal ? 1 : 0);
    completeTelemetry(exitCode, signal ?? undefined);
    queue.push({
      kind: 'close',
      data: '',
      bytes: 0,
      code: exitCode,
      ...(signal ? { signal } : {}),
    });
    wake();
  });

  // Abort: tree-kill the child and wake the consumer loop with a synthetic
  // close (exit code 124, matching exec.ts's timeout convention). Without
  // the sentinel the loop can park forever on `waiter` when the pipes are
  // paused (queue full) or a win32 orphan holds them open — the executor's
  // iter.return() then never completes, the tool call hangs for the rest of
  // the session and retains the queue (up to maxQueue chunks) on the heap.
  //
  // Only on Windows: on POSIX the signal is already passed to spawn() above
  // (line 72) so Node.js handles the kill via the signal; attaching a second
  // handler here would double-kill the child and leak the listener when the
  // generator exits without aborting.
  const onAbort = () => {
    if (typeof pid === 'number') {
      registry.kill(pid, { force: true });
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    queue.push({ kind: 'close', data: '', bytes: 0, code: 124 });
    completeTelemetry(124, 'SIGKILL', true);
    wake();
  };
  if (isWin && signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let exitCode = 0;
  let spawnFailed = false;
  try {
    for (;;) {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
      const chunk = queue.shift()!;
      queuedBytes -= chunk.bytes;
      // Resume reading after consuming a chunk
      resume();
      if (chunk.kind === 'close') {
        // If we already saw a spawn error (ENOENT etc.), keep exitCode=1
        // rather than the negative platform code Node fabricates.
        if (!spawnFailed) exitCode = chunk.code ?? 0;
        break;
      }
      if (chunk.kind === 'error') {
        spawnFailed = true;
        exitCode = 1;
        // close usually follows
        continue;
      }
      pending += chunk.data;
      if (pending.length >= flushAt) {
        yield { type: 'partial_output', text: pending };
        pending = '';
      }
    }
    if (pending.length > 0) {
      yield { type: 'partial_output', text: pending };
    }

    const spooled = spool.finalize();
    return {
      // The marker rides on stdout's tail so every consumer's head+tail
      // normalization keeps it without per-tool changes.
      stdout: spooled ? stdout + spoolNote(spooled) : stdout,
      stderr,
      exitCode,
      truncated: stdoutBytes > stdoutRetainedBytes || stderrBytes > stderrRetainedBytes,
      error,
      spoolPath: spooled?.path,
      spoolBytes: spooled?.bytes,
    };
  } finally {
    // Teardown — this generator can be abandoned mid-stream (executor
    // timeout/abort, or the consumer erroring out of its for-await loop).
    // The data handlers would otherwise stay attached and keep queueing
    // output with no consumer (bounded only by the pause cap), and a
    // surviving child would keep the closures — queue, output buffers,
    // child handle — alive until OOM. Detach the handlers, destroy the
    // pipes, and make sure nothing is left running.
    spool.finalize(); // idempotent — closes the file if the stream was abandoned
    if (isWin && signal) signal.removeEventListener('abort', onAbort);
    child.stdout?.off('data', onOut);
    child.stderr?.off('data', onErr);
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.exitCode === null && !child.killed) {
      if (typeof pid === 'number') {
        registry.kill(pid, { force: true });
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}
