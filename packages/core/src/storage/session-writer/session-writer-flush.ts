import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import type { SessionEvent } from '../../types/session.js';

export function isClosedHandleError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBADF' || code === 'ERR_CLOSED_RESOURCE' || code === 'ERR_INVALID_HANDLE';
}

export function flushBufferSync(filePath: string, events: SessionEvent[]): void {
  if (events.length === 0 || !filePath) return;
  const batch = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'a');
    writeSync(fd, batch, null, 'utf8');
    fsyncSync(fd);
  } catch {
    // best-effort — process is exiting either way
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}
