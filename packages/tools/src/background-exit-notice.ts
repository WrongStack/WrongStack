/**
 * Exit notices for background shell processes.
 *
 * `bash`/`pwsh` with `background: true` used to hand back a pid and a log
 * file and then go silent: the model either polled the log turn after turn or
 * forgot the process. When the launching agent is a leader (the only agent
 * that receives deliveries), the exit now becomes a `[RUNTIME NOTICE]` with
 * the exit code, the duration and the last log lines. A running loop gets it
 * at the next iteration; an idle leader is woken for it.
 *
 * A process WrongStack itself killed (`/kill`, session cleanup, shutdown) is
 * still reported, but never wakes the leader: the user caused that outcome.
 */

import { open } from 'node:fs/promises';
import { enqueueRuntimeNotice, resolveRuntimeNoticeTarget } from '@wrongstack/coordination';
import { getProcessRegistry } from './process-registry.js';

const TAIL_BYTES = 4_096;
const TAIL_LINES = 20;
const COMMAND_PREVIEW_CHARS = 300;
/** Terminal escape sequences (colors, cursor moves) stripped from log tails. */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Appended to a background launch result when its exit will be reported. */
export const BACKGROUND_EXIT_NOTICE_HINT =
  'You will receive a [RUNTIME NOTICE] when this process exits (exit code and last log lines); do not poll the log just to see whether it finished.';

/**
 * The session whose leader hears about this launch's exit, or `undefined`
 * when the caller opted out or is not a leader.
 */
export function backgroundExitNoticeTarget(
  ctx: unknown,
  notifyOnExit: boolean | undefined,
): string | undefined {
  if (notifyOnExit === false) return undefined;
  try {
    return resolveRuntimeNoticeTarget(ctx);
  } catch {
    return undefined;
  }
}

export function formatNoticeDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Last lines of a log file, bounded, without terminal escapes. */
export async function readLogTail(path: string, maxLines = TAIL_LINES): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let lines = buffer.toString('utf8').replace(ANSI_PATTERN, '').split(/\r?\n/);
    // A read that starts mid-file starts mid-line: drop the fragment.
    if (size > length) lines = lines.slice(1);
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
    return lines.slice(-maxLines);
  } finally {
    await handle.close();
  }
}

export interface BackgroundExitInfo {
  /** Leader session from {@link backgroundExitNoticeTarget}. */
  sessionId: string;
  tool: 'bash' | 'pwsh';
  pid: number;
  /** Already redacted. */
  command: string;
  startedAt: number;
  code: number | null;
  signal: string | null;
  logFile?: string | undefined;
}

/** Queue the exit notice. Never throws; a failed tail read just omits the log lines. */
export function reportBackgroundExit(info: BackgroundExitInfo): void {
  const ended = getProcessRegistry()
    .recentlyEnded()
    .find((p) => p.pid === info.pid);
  const killed = ended?.killed === true;
  const duration = formatNoticeDuration(Date.now() - info.startedAt);
  const subject = `Background ${info.tool} process ${info.pid}`;
  const title = killed
    ? `${subject} was stopped by WrongStack after ${duration}.`
    : info.signal
      ? `${subject} ended by signal ${info.signal} after ${duration}.`
      : `${subject} exited with code ${info.code ?? 'unknown'} after ${duration}.`;
  const command =
    info.command.length > COMMAND_PREVIEW_CHARS
      ? `${info.command.slice(0, COMMAND_PREVIEW_CHARS - 1)}…`
      : info.command;

  void (async () => {
    const body = [`command: ${command}`];
    if (info.logFile) {
      body.push(`log_file: ${info.logFile}`);
      try {
        const tail = await readLogTail(info.logFile);
        body.push(
          tail.length > 0 ? `last ${tail.length} log line(s):\n${tail.join('\n')}` : 'log: (empty)',
        );
      } catch {
        // The log may already be pruned; the notice stands without it.
      }
    }
    try {
      enqueueRuntimeNotice(info.sessionId, {
        source: 'process',
        handle: String(info.pid),
        seq: `exit@${info.startedAt}`,
        title,
        body: body.join('\n'),
        wake: !killed,
      });
    } catch {
      // Delivery is best-effort; it must never disturb process teardown.
    }
  })();
}
