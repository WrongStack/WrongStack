/**
 * Teardown-path error classification for the session writer.
 *
 * This module also carried a `flushBufferSync(filePath, events)` helper — a
 * naive "open, append, fsync, close" exit flush. `SessionWriteBuffer.flushSync`
 * (session-write-buffer.ts) superseded it with the version that actually
 * ships: it steals a queued batch so the sync append is the only writer,
 * defers rather than racing an in-flight async append, clears the buffer only
 * after `fsyncSync` returns, and emits the structured warnings the SIGKILL-trap
 * tests assert on. The helper here survived only in its own test.
 */
export function isClosedHandleError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBADF' || code === 'ERR_CLOSED_RESOURCE' || code === 'ERR_INVALID_HANDLE';
}
