/**
 * Redos guard — run a regex inside a `node:worker_threads` worker so
 * the host can actually terminate it on a wall-clock budget.
 *
 * Why a worker thread?
 *   A `setTimeout`-based watchdog cannot interrupt a synchronous
 *   CPU-bound regex in Node.js's single-threaded event loop. The
 *   `setImmediate`/`setTimeout` race fires whichever wins the next
 *   event-loop tick; if the regex blocks the loop synchronously for
 *   7 seconds, the timer has long since fired and the regex still
 *   returns a result — only after the loop is unblocked does the
 *   `setImmediate` callback resume and resolve `{ timedOut: false }`.
 *
 *   The only honest fix is to run the regex in a separate thread that
 *   the host can `worker.terminate()`. `node:worker_threads` gives us
 *   that, and the per-thread cost is amortized by the runtime helper
 *   itself (the host doesn't pay for the thread except when it
 *   invokes `withReDoSGuard`).
 *
 * Why is this here, not inside each plugin?
 *   Three plugins (`secret-scanner`, `prompt-firewall`, `path-guard`)
 *   need the same contract. Three copies would drift; one copy is
 *   auditable and testable.
 *
 * Contract:
 *   `withReDoSGuard(re, input, ms)` returns:
 *     { timedOut: false, match: RegExpExecArray | null }   on normal completion
 *     { timedOut: true,  match: null }                     on timeout
 */

import { Worker } from 'node:worker_threads';

export interface ReDoSResult {
  /** True when the regex did not complete within the wall-clock budget. */
  timedOut: boolean;
  /** The match result (groups, indices) when `timedOut === false`; null otherwise. */
  match: RegExpExecArray | null;
}

export interface ReDoSOptions {
  /** Wall-clock budget in ms. Default 50. */
  budgetMs?: number;
  /**
   * Optional hook invoked exactly once when the budget is exceeded.
   * Called synchronously after the regex is terminated. Default: no-op.
   */
  onTimeout?: (info: { regex: RegExp; input: string; budgetMs: number; elapsedMs: number }) => void;
}

/**
 * Single-slot warm worker pool. The worker is spawned lazily on the first
 * guarded call, reused for subsequent sequential calls, and terminated
 * whenever a budget expires or the worker errors — the
 * runaway-regex-kills-its-thread contract is identical to the previous
 * spawn-per-call design; only the spawn is amortized. Overlapping calls
 * fall back to spawning their own worker (one idle slot is kept).
 */
let warm: Worker | null = null;
let callSeq = 0;

/**
 * Run `re.exec(input)` inside a worker thread with a wall-clock
 * watchdog. The worker is terminated when the budget elapses; the
 * regex cannot keep running.
 *
 * Returns a Promise; resolved with `{ timedOut, match }`.
 */
export function withReDoSGuard(
  re: RegExp,
  input: string,
  budgetMs: number = 50,
  options: ReDoSOptions = {},
): Promise<ReDoSResult> {
  const opts = { budgetMs, ...options };
  const start = Date.now();
  const id = ++callSeq;

  // Take the idle warm worker, or spawn one. Clearing `warm` marks this
  // worker in-flight: sequential callers reuse the pool, an overlapping
  // caller falls back to spawning its own worker (spawn-per-call shape).
  let worker: Worker;
  if (warm !== null) {
    worker = warm;
  } else {
    worker = spawnPoolWorker();
  }
  warm = null;
  worker.ref(); // in-flight worker keeps the event loop alive until the reply

  return new Promise<ReDoSResult>((resolve) => {
    let settled = false;

    const settle = (result: ReDoSResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Remove the pending once-listeners: the happy path fires 'message'
      // but never 'error', and per-call listeners would otherwise
      // accumulate on the long-lived pooled worker
      // (MaxListenersExceededWarning at call #11).
      worker.off('message', onMessage);
      worker.off('error', onError);
      resolve(result);
    };

    const onMessage = (
      msg:
        | { id: number; ok: true; match: RegExpExecArray | null }
        | { id: number; ok: false; error: string },
    ) => {
      if (settled || msg.id !== id) return;
      // Park the worker back in the single idle slot; terminate extras.
      worker.unref();
      if (warm === null) {
        warm = worker;
      } else {
        worker.terminate().catch(() => {
          // best-effort: an extra idle worker beyond the single pool slot
        });
      }
      if (!msg.ok) {
        // Worker reported a thrown error (e.g. RangeError). Treat as a
        // timeout-equivalent — caller sees "this input is hostile".
        settle({ timedOut: true, match: null });
        return;
      }
      settle({ timedOut: false, match: msg.match });
    };

    const onError = () => {
      if (settled) return;
      // Worker errored (e.g. crashed mid-run) and is unusable — the slot
      // stays empty and the next call respawns. Treat as a
      // timeout-equivalent.
      settle({ timedOut: true, match: null });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      const elapsedMs = Date.now() - start;
      // ACTUAL termination: worker.terminate() kills the regex
      // process. This is the structural fix for the bug class at
      // `runtime/index.ts:313`. The pooled worker is NOT parked after a
      // timeout — a runaway pattern dies with its thread; the next call
      // spawns a fresh worker.
      worker.terminate().catch(() => {
        // best-effort: terminate failure is fine, we're already
        // committed to timing out.
      });
      try {
        opts.onTimeout?.({
          regex: re,
          input,
          budgetMs: opts.budgetMs,
          elapsedMs,
        });
      } catch {
        // best-effort: a throwing onTimeout hook must not propagate
      }
      settle({ timedOut: true, match: null });
    }, opts.budgetMs);
    // Don't keep the process alive solely for this watchdog.
    (timer as { unref?: () => void }).unref?.();

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.postMessage({ id, source: re.source, flags: re.flags, input });
  });
}

/**
 * Persistent pooled worker source. Requests arrive at runtime via
 * postMessage — { id, source, flags, input } — and replies carry the same
 * id so replies always match their call. Source + flags travel as strings
 * because regex objects don't serialize cleanly across the worker
 * boundary (their `lastIndex` is host-side state); the worker compiles a
 * fresh RegExp per request. We deliberately avoid `workerData` (Windows +
 * eval workers don't always receive it reliably) and use
 * `parentPort.postMessage`, NOT bare postMessage — with eval:true workers
 * this Node version does not expose the bare postMessage global — the
 * worker would throw ReferenceError at startup and the host would misread
 * it as a timeout (positive-path regression).
 */
const POOLED_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (msg) => {
  const { id, source, flags, input } = msg;
  try {
    const re = new RegExp(source, flags);
    const match = re.exec(input);
    parentPort.postMessage({ id, ok: true, match });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
`;

/**
 * Spawn a pooled worker. Unref'd immediately: an idle pooled worker must
 * not keep the host process alive. It is ref()'d only while a guarded
 * call is in flight (see withReDoSGuard).
 */
function spawnPoolWorker(): Worker {
  const worker = new Worker(POOLED_WORKER_SOURCE, {
    eval: true,
    name: 'redos-guard:pool',
  });
  worker.unref();
  return worker;
}

/**
 * Convenience: build a guarded matcher.
 *
 * ```ts
 * const matchCredential = guardedMatcher(/AKIA[0-9A-Z]{16}/g, 25);
 * const r = await matchCredential(line);
 * if (r.timedOut) counters.redosTimeouts++;
 * else if (r.match) report(r.match);
 * ```
 */
export function guardedMatcher(
  re: RegExp,
  budgetMs: number = 50,
  onTimeout?: ReDoSOptions['onTimeout'],
): (input: string) => Promise<ReDoSResult> {
  return (input: string) => withReDoSGuard(re, input, budgetMs, onTimeout ? { onTimeout } : {});
}
