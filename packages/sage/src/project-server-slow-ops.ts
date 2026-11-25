/**
 * Slow-dispatch reporting for the SAGE project server.
 */
import type { SageServerOperationName } from './project-server-protocol.js';

/** Per-op throttle so a persistent regression cannot flood stderr. */
const SLOW_OPERATION_THROTTLE_MS = 60_000;

/**
 * Build the daemon's slow-operation reporter. `stats` supplies the queue depth
 * and client count named in the report line. A dispatch slower than the
 * threshold is reported on stderr.
 *
 * SQLite is synchronous and this daemon runs one event loop, so a slow
 * operation is never slow for its caller alone — every other client of the
 * project waits behind it, and a queue deep enough makes them fail with their
 * own 30s call timeout somewhere else entirely. That is how an FTS join-order
 * regression (seconds per `searchSage` under one SQLite build, milliseconds
 * under another) stayed invisible until unrelated ops started timing out. One
 * throttled line names the op and the queue depth instead.
 *
 * `WRONGSTACK_SAGE_SLOW_OP_MS` overrides the threshold; 0 reports every
 * request, which is what the lifecycle test asserts against. The threshold is
 * read when the reporter is built (daemon start), as before.
 */
export function createSlowOperationReporter(
  stats: () => { pendingRequests: number; clients: number },
): (op: SageServerOperationName, durationMs: number) => void {
  const SLOW_OPERATION_WARN_MS = (() => {
    const raw = Number(process.env['WRONGSTACK_SAGE_SLOW_OP_MS']);
    return Number.isFinite(raw) && raw >= 0 ? raw : 1_000;
  })();
  const lastSlowReportAt = new Map<string, number>();
  return function reportSlowOperation(op: SageServerOperationName, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < SLOW_OPERATION_WARN_MS) return;
    const now = Date.now();
    const previous = lastSlowReportAt.get(op);
    if (previous !== undefined && now - previous < SLOW_OPERATION_THROTTLE_MS) return;
    lastSlowReportAt.set(op, now);
    const { pendingRequests, clients } = stats();
    process.stderr.write(
      `sage project server: ${op} took ${Math.round(durationMs)}ms ` +
        `(queued=${pendingRequests}, clients=${clients}) — every client waits behind it
`,
    );
  };
}
