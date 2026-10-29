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
