import { existsSync, rmSync } from 'node:fs';

/**
 * Watches for the session host's stop request: a file at `path`. When it appears the file is
 * removed and `stop` runs once. The host used to end every engine with a hard process-tree
 * kill, so no conversation journal got its `session_end` (each looked like a crash on the next
 * launch) and an engine's unused boot session stayed a 0-byte transcript the empty-session
 * sweep can never prove empty. Asking first lets the engine run its graceful shutdown; the host
 * still stops it hard when it does not exit in time.
 */
export function watchStopRequest(
  path: string,
  stop: () => void,
  { pollMs = 250, exists = existsSync } = {},
): () => void {
  const timer = setInterval(() => {
    if (!exists(path)) return;
    clearInterval(timer);
    try {
      rmSync(path, { force: true });
    } catch {
      // The host removes a leftover request before it starts an engine on this id again.
    }
    stop();
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Runs the engine's graceful shutdown (the SIGTERM handlers), or exits when none is set up. */
export function stopGracefully(): void {
  if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM');
  else process.exit(0);
}
