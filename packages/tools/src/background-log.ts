/**
 * Where a background shell's output goes: a log file in the project's state
 * directory (`<project dir>/bg-logs`), written by the child directly.
 *
 * A file rather than a pipe, because a background job must outlive the CLI: a
 * pipe's read end closes with the host, and the job's next write then dies of
 * EPIPE/SIGPIPE. The file is what the model reads to see a dev server's output,
 * and what the TUI's background strip shows the tail of.
 *
 * Old logs are pruned when a new one is opened: past the newest
 * `KEEP_LOGS`, or older than `MAX_AGE_MS`, except those of processes still
 * running.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';

const KEEP_LOGS = 40;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export interface BackgroundLog {
  path: string;
  fd: number;
}

function prune(dir: string, keep: ReadonlySet<string>): void {
  let entries: Array<{ file: string; mtime: number }>;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return;
  }
  const now = Date.now();
  entries.forEach(({ file, mtime }, index) => {
    if (keep.has(file)) return;
    // `keep` covers only this process. Every session of the project shares the
    // directory, so a quiet log of another live process fell out of the newest
    // KEEP_LOGS and was unlinked while its job still wrote to it.
    if (ownedByOtherLiveProcess(file)) return;
    if (index < KEEP_LOGS && now - mtime < MAX_AGE_MS) return;
    try {
      fs.unlinkSync(file);
    } catch {
      // Still open on Windows, or already gone: the next prune tries again.
    }
  });
}

/**
 * Open a fresh log for a background launch. `inUse` lists the logs of
 * processes still running, which pruning leaves alone. Returns `undefined`
 * when the directory cannot be written; the caller then discards the output
 * as before.
 */
/** The creating pid is the file name's last segment (see openBackgroundLog). */
function ownedByOtherLiveProcess(file: string): boolean {
  const pid = Number(/-(\d+)\.log$/.exec(path.basename(file))?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function openBackgroundLog(
  projectRoot: string,
  toolName: string,
  inUse: Iterable<string> = [],
): BackgroundLog | undefined {
  try {
    const dir = path.join(resolveWstackPaths({ projectRoot }).projectDir, 'bg-logs');
    fs.mkdirSync(dir, { recursive: true });
    prune(dir, new Set(inUse));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTool = toolName.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
    // A timestamp/PID pair can repeat between launches in the same clock tick.
    const file = path.join(dir, `${stamp}-${randomUUID()}-${safeTool}-${process.pid}.log`);
    return { path: file, fd: fs.openSync(file, 'ax', 0o600) };
  } catch {
    return undefined;
  }
}

/** Close the parent's copy once the child has its own. */
export function closeBackgroundLogFd(log: BackgroundLog | undefined): void {
  if (!log) return;
  try {
    fs.closeSync(log.fd);
  } catch {
    // Already closed.
  }
}

/** The last `maxLines` lines of a log, reading at most its last 64 KiB. */
export function tailBackgroundLog(file: string, maxLines: number): string[] {
  if (!Number.isFinite(maxLines)) return [];
  const limit = Math.floor(maxLines);
  if (limit <= 0) return [];
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').replace(/\r\n?/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    // A cut at the 64 KiB boundary leaves a partial first line.
    if (size > length) lines.shift();
    return lines.slice(-limit);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
