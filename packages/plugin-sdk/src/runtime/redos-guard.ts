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
  // Embed source + input directly in the worker source string so we
  // don't depend on `workerData` (which has cross-platform quirks:
  // Windows + eval workers don't always receive workerData reliably).
  // Source + input are JSON-stringified so backticks/quotes/newlines
  // can't break the embedded literal.
  const workerSource = buildWorkerSource(re.source, input, re.flags);
  const worker = new Worker(workerSource, {
    eval: true,
    name: `redos-guard:${re.source.slice(0, 32)}`,
  });

  return new Promise<ReDoSResult>((resolve) => {
    let settled = false;

    const onMessage = (
      msg: { ok: true; match: RegExpExecArray | null } | { ok: false; error: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {
        // best-effort: terminate failure is not fatal, the worker
        // already reported its result via postMessage.
      });
      if (!msg.ok) {
        // Worker reported a thrown error (e.g. RangeError). Treat as
        // a timeout-equivalent — caller sees "this input is hostile".
        resolve({ timedOut: true, match: null });
        return;
      }
      resolve({ timedOut: false, match: msg.match });
    };

    const onError = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {
        // best-effort
      });
      // Worker errored (e.g. crashed during construction). Treat as
      // a timeout-equivalent.
      resolve({ timedOut: true, match: null });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const elapsedMs = Date.now() - start;
      // ACTUAL termination: worker.terminate() kills the regex
      // process. This is the structural fix for the bug class at
      // `runtime/index.ts:313`.
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
      resolve({ timedOut: true, match: null });
    }, opts.budgetMs);
    // Don't keep the process alive solely for this watchdog.
    (timer as { unref?: () => void }).unref?.();

    worker.on('message', onMessage);
    worker.on('error', onError);
  });
}

/**
 * Build the worker source string. The worker compiles a fresh
 * RegExp from `source`, applies `flags`, and runs `exec(input)`. We
 * deliberately use the regex source string (not the regex object)
 * because regex objects don't serialize cleanly across the worker
 * boundary — their `lastIndex` is host-side state.
 */
/**
 * Build the worker source string. Source + input + flags are
 * embedded directly via JSON.stringify so the worker doesn't
 * depend on `workerData` (cross-platform quirks: Windows + eval
 * workers don't always receive workerData reliably). The
 * `try { postMessage(...) } catch { postMessage(...) }` shape
 * preserves the contract that `onMessage` always receives a
 * `{ ok, ... }` payload.
 */
function buildWorkerSource(source: string, input: string, flags: string): string {
  // JSON.stringify escapes backticks, quotes, and newlines so the
  // embedded literal can't break the worker source.
  const S = JSON.stringify(source);
  const I = JSON.stringify(input);
  const F = JSON.stringify(flags);
  return `
const { parentPort } = require('node:worker_threads');
const source = ${S};
const input = ${I};
const flags = ${F};
try {
  const re = new RegExp(source, flags);
  const match = re.exec(input);
  // parentPort.postMessage, NOT bare postMessage: with eval:true
  // workers this Node version does not expose the bare postMessage
  // global — the worker throws ReferenceError at startup and the
  // host misreads it as a timeout (positive-path regression).
  parentPort.postMessage({ ok: true, match });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
`;
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
