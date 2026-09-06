/**
 * Running a benchmark command N times and reducing it to a measurement.
 *
 * Deliberately boring: spawn, wait, extract, repeat. The interesting decisions
 * (is this better? do we keep it?) live in `perf-stats.ts` where they can be
 * tested without a subprocess. What this module owns is the part that has to be
 * right for the numbers to mean anything at all — warmup runs are discarded,
 * output is capped so a chatty benchmark cannot become a memory incident, and a
 * hung run is torn down by process *tree* so a `.cmd` shim on Windows cannot
 * orphan the real workload.
 *
 * @module performance/perf-runner
 */
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { buildChildEnv } from '../utils/child-env.js';
import { treeKill } from '../utils/tree-kill.js';
import { type MetricExtractor, type PerfRunOutput, wallTimeExtractor } from './perf-extractors.js';
import { summarize } from './perf-stats.js';
import { DEFAULT_RUNS, type PerfMeasurement, type PerfMetricId } from './perf-types.js';

/**
 * Per-stream output cap.
 *
 * A benchmark that prints per-iteration progress can emit hundreds of megabytes
 * across a 5-run measurement. Extractors only ever look at a summary line, so
 * keeping the tail is both sufficient and the difference between a measurement
 * and an OOM.
 */
const MAX_STREAM_BYTES = 1_000_000;

export interface MeasureOptions {
  /** Full command line, run through the platform shell. */
  command: string;
  cwd: string;
  metric: PerfMetricId;
  /** Repeat count after warmup. Minimum 3; defaults to {@link DEFAULT_RUNS}. */
  runs?: number;
  /** Discarded runs before measurement starts. Defaults to 1. */
  warmup?: number;
  /** Per-run timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Defaults to wall-clock time. */
  extract?: MetricExtractor;
  /** Treat a non-zero exit as a usable run. Off by default. */
  allowFailure?: boolean;
  signal?: AbortSignal;
}

/**
 * How long to wait for stdio to drain after the child has already exited.
 *
 * `close` only fires once EVERY stdio stream has ended, and a grandchild that
 * outlived the kill still holds the inherited pipe open — so `close` may never
 * arrive. The child's exit status is already known at that point, so settle on
 * it after a short flush window instead of waiting forever.
 */
const STREAM_FLUSH_GRACE_MS = 250;

/**
 * Hard settle window after a timeout kill. If neither `exit` nor `close`
 * follows the kill (an unkillable process, a shell that forked before it
 * could exec), the run is still reported as timed out rather than hanging
 * the caller — which is what the timeout existed to prevent.
 */
const KILL_SETTLE_GRACE_MS = 2_000;

/** Append to a bounded tail buffer, keeping the last {@link MAX_STREAM_BYTES}. */
function appendCapped(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length <= MAX_STREAM_BYTES ? next : next.slice(next.length - MAX_STREAM_BYTES);
}

/** Run the command once. Never throws for a failed command — reports it. */
export async function runOnce(
  options: Pick<MeasureOptions, 'command' | 'cwd' | 'timeoutMs' | 'env' | 'signal'>,
): Promise<PerfRunOutput & { timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      // H-8 (security report VF-09): this was an explicit `{...process.env}`
      // with `shell:true` — every credential in the parent environment was
      // handed to an arbitrary shell command line. Use the shared filtered
      // child env; caller-provided `options.env` entries still overlay it.
      env: { ...buildChildEnv(), ...options.env },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const pendingTimers: NodeJS.Timeout[] = [];

    /** Settle after `delayMs` unless the normal path got there first. */
    const settleLater = (exitCode: number | null, delayMs: number): void => {
      const timer = setTimeout(() => finish(exitCode), delayMs);
      timer.unref();
      pendingTimers.push(timer);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      treeKill(child, { force: true });
      settleLater(null, KILL_SETTLE_GRACE_MS);
    }, timeoutMs);

    const onAbort = () => {
      timedOut = true;
      treeKill(child, { force: true });
      settleLater(null, KILL_SETTLE_GRACE_MS);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const pending of pendingTimers) clearTimeout(pending);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, wallMs: Date.now() - startedAt, exitCode, timedOut });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString('utf8'));
    });
    // `error` fires instead of `close` when the shell itself cannot start.
    child.on('error', (error) => {
      stderr = appendCapped(stderr, `\n${(error as Error).message}\n`);
      finish(null);
    });
    // `exit` means the status is known; `close` additionally waits for stdio
    // to end, which a surviving grandchild can defer indefinitely. Prefer
    // `close` when it comes, but never depend on it.
    child.on('exit', (code) => settleLater(code, STREAM_FLUSH_GRACE_MS));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Run the workload `warmup + runs` times and reduce it to one measurement.
 *
 * Throws when fewer than three usable runs survive: three is the minimum the
 * contract's noise band is defined over, and a measurement built from one or
 * two samples has no spread to compare against.
 */
export async function measure(options: MeasureOptions): Promise<PerfMeasurement> {
  const runs = Math.max(3, options.runs ?? DEFAULT_RUNS);
  const warmup = Math.max(0, options.warmup ?? 1);
  const extract = options.extract ?? wallTimeExtractor;
  const notes: string[] = [];
  const samples: number[] = [];
  const startedAt = Date.now();

  for (let index = 0; index < warmup; index += 1) {
    const result = await runOnce(options);
    if (result.exitCode !== 0 && !options.allowFailure) {
      notes.push(`warmup ${index + 1} exited ${String(result.exitCode)}`);
    }
  }

  for (let index = 0; index < runs; index += 1) {
    if (options.signal?.aborted) {
      notes.push(`aborted after ${samples.length} run(s)`);
      break;
    }
    const result = await runOnce(options);
    if (result.timedOut) {
      notes.push(`run ${index + 1} timed out and was killed`);
      continue;
    }
    if (result.exitCode !== 0 && !options.allowFailure) {
      notes.push(`run ${index + 1} exited ${String(result.exitCode)}; discarded`);
      continue;
    }
    const value = extract(result);
    if (value === undefined || !Number.isFinite(value)) {
      notes.push(`run ${index + 1} produced no metric value; discarded`);
      continue;
    }
    samples.push(value);
  }

  if (samples.length < 3) {
    throw new Error(
      `measure(): only ${samples.length} usable run(s) out of ${runs} for \`${options.command}\`. ` +
        `A baseline needs at least 3. ${notes.join('; ') || 'No diagnostics were captured.'}`,
    );
  }
  if (samples.length < runs) {
    notes.push(`${runs - samples.length} run(s) discarded; stats cover ${samples.length}`);
  }

  return {
    ...summarize(samples),
    metric: options.metric,
    command: options.command,
    cwd: options.cwd,
    samples,
    startedAt,
    finishedAt: Date.now(),
    notes,
  };
}

/**
 * One-line machine description for the `machine:` field of a round.
 *
 * A measurement without the machine it ran on is not comparable to anything,
 * and comparing across machines is the most common way a ratchet lies.
 */
export function describeMachine(): string {
  const cores = os.cpus().length;
  const model = os.cpus()[0]?.model?.trim().replace(/\s+/g, ' ') ?? 'unknown CPU';
  const gb = Math.round(os.totalmem() / 1024 ** 3);
  return `${model} / ${cores}c / ${gb}GB / ${os.platform()} ${os.release()} / node ${process.versions.node}`;
}
