import { entries } from './engine-values';
export interface SessionProcess {
  pid: number;
  command: string;
  tool: string;
  startedAt: number;
  status: string;
  protected: boolean;
  background: boolean;
  hasOutput: boolean;
}
export function sessionProcesses(
  payload: Record<string, unknown>,
  sessionId: string,
): SessionProcess[] {
  if (payload['sessionId'] !== sessionId || !Array.isArray(payload['processes']))
    throw Error('Process list belongs to another conversation or has no process records.');
  const rows = entries(payload['processes']);
  if (
    rows.length !== payload['processes'].length ||
    rows.some(
      (row) =>
        row['sessionId'] !== sessionId ||
        !Number.isSafeInteger(row['pid']) ||
        Number(row['pid']) < 1 ||
        typeof row['command'] !== 'string' ||
        typeof row['tool'] !== 'string' ||
        typeof row['startedAt'] !== 'number' ||
        !Number.isFinite(row['startedAt']) ||
        !Number.isFinite(new Date(row['startedAt']).getTime()) ||
        !['running', 'killed', 'exited'].includes(String(row['status'])),
    )
  )
    throw Error('The engine returned an unrecognized or differently owned process.');
  return rows.map((row) => ({
    pid: Number(row['pid']),
    command: String(row['command']),
    tool: String(row['tool']),
    startedAt: Number(row['startedAt']),
    status: String(row['status']),
    protected: row['protected'] === true,
    background: row['background'] === true,
    hasOutput: row['hasOutput'] === true,
  }));
}
/** A process the engine reports as ended, with the exit its child reported. */
export interface ReportedEnd {
  pid: number;
  command: string;
  tool: string;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  signal: string | null;
  killed: boolean;
  background: boolean;
}
/**
 * This session's ended processes from `process.list`, or null when the engine does not report
 * them (older engines). Rows of another session or with unreadable values are left out.
 */
export function reportedEnded(
  payload: Record<string, unknown>,
  sessionId: string,
): ReportedEnd[] | null {
  if (!Array.isArray(payload['ended'])) return null;
  return entries(payload['ended']).flatMap((row) =>
    row['sessionId'] === sessionId &&
    Number.isSafeInteger(row['pid']) &&
    typeof row['command'] === 'string' &&
    typeof row['tool'] === 'string' &&
    Number.isFinite(row['startedAt']) &&
    Number.isFinite(row['endedAt']) &&
    (row['exitCode'] === null || Number.isSafeInteger(row['exitCode'])) &&
    (row['signal'] === null || typeof row['signal'] === 'string')
      ? [
          {
            pid: Number(row['pid']),
            command: String(row['command']),
            tool: String(row['tool']),
            startedAt: Number(row['startedAt']),
            endedAt: Number(row['endedAt']),
            exitCode: row['exitCode'] as number | null,
            signal: row['signal'] as string | null,
            killed: row['killed'] === true,
            background: row['background'] === true,
          },
        ]
      : [],
  );
}
/** How an ended process finished, as reported; an unreported exit is never shown as success. */
export function endLabel(end: ReportedEnd): { text: string; failed: boolean | null } {
  // Windows reports a terminated process by its exit code rather than a signal.
  if (end.killed && end.exitCode !== null)
    return { text: `Terminated on request · exit code ${end.exitCode}`, failed: true };
  if (end.exitCode !== null)
    return end.exitCode === 0
      ? { text: 'Exit code 0', failed: false }
      : { text: `Exit code ${end.exitCode}`, failed: true };
  if (end.signal)
    return {
      text: `${end.killed ? 'Terminated on request' : 'Stopped'} · ${end.signal}`,
      failed: true,
    };
  return {
    text: end.killed ? 'Terminated on request · exit not reported' : 'Exit not reported',
    failed: null,
  };
}
export function sameSessionProcess(left: SessionProcess, right: SessionProcess): boolean {
  return (
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.command === right.command &&
    left.tool === right.tool
  );
}

/** Stable identity of one tracked process run; a reused PID gets a different key. */
export const processKey = (proc: SessionProcess) => `${proc.pid}:${proc.startedAt}`;

/** Only running, unprotected processes can be terminated. */
export const terminable = (proc: SessionProcess) => proc.status === 'running' && !proc.protected;

/**
 * Splits the picked processes against a fresh list: those still the same running,
 * unprotected process are sent; the rest are reported and never terminated.
 */
export function batchTermination(
  picked: readonly SessionProcess[],
  current: readonly SessionProcess[],
): { send: SessionProcess[]; skipped: SessionProcess[] } {
  const send: SessionProcess[] = [],
    skipped: SessionProcess[] = [];
  for (const proc of picked) {
    const fresh = current.find((row) => sameSessionProcess(row, proc));
    if (fresh && terminable(fresh)) send.push(fresh);
    else skipped.push(proc);
  }
  return { send, skipped };
}

export function batchTerminationSummary(
  total: number,
  done: readonly SessionProcess[],
  failed: readonly { proc: SessionProcess; error: string }[],
  skipped: readonly SessionProcess[],
): string {
  const parts = [`Termination acknowledged for ${done.length} of ${total} processes.`];
  if (failed.length)
    parts.push(
      `Failed: ${failed.map((item) => `PID ${item.proc.pid} (${item.error})`).join('; ')}.`,
    );
  if (skipped.length)
    parts.push(
      `Not sent because they exited, changed or became protected: ${skipped.map((proc) => `PID ${proc.pid}`).join(', ')}.`,
    );
  parts.push('Refresh verifies whether they are still tracked.');
  return parts.join(' ');
}

/** A process this window saw that the engine no longer tracks; its exit status is unknown. */
export interface EndedProcess {
  proc: SessionProcess;
  /** Last list that still contained it. */
  lastSeenAt: number;
  /** First list without it. */
  goneBy: number;
}

const MAX_ENDED = 50;

/**
 * Processes present in the previous list and missing from the current one, newest first and
 * bounded. A reused PID with a new start time is a different run, so its old run ends here.
 */
export function endedProcesses(
  ended: readonly EndedProcess[],
  previous: readonly SessionProcess[],
  current: readonly SessionProcess[],
  previousAt: number,
  now: number,
): EndedProcess[] {
  const gone = previous
    .filter((proc) => !current.some((row) => processKey(row) === processKey(proc)))
    .map((proc) => ({ proc, lastSeenAt: previousAt, goneBy: now }));
  if (!gone.length) return ended as EndedProcess[];
  const keys = new Set(gone.map((item) => processKey(item.proc)));
  return [...gone, ...ended.filter((item) => !keys.has(processKey(item.proc)))].slice(0, MAX_ENDED);
}

/** "3 min 12 s" style duration between two epoch-millisecond times. */
export function observedDuration(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
