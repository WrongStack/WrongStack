import { WRONGSTACK_RUNTIME_VERSION } from './runtime-version.js';

/**
 * Replacing a project daemon of an older release (see `shouldReplaceOlderDaemon`): the client
 * that reached it asks it to stop and fails that connect with `OlderDaemonError`; its election
 * loop then starts a daemon of its own release, and ends an old one that keeps answering.
 * Clients of the older release reuse a newer daemon, so a project converges on the newest.
 */

/** A project daemon of an older release that the client asked to stop; `pid` is its own. */
export class OlderDaemonError extends Error {
  constructor(
    message: string,
    readonly pid: number | undefined,
  ) {
    super(message);
    this.name = 'OlderDaemonError';
  }
}

/** The part of a daemon connection's socket that `retireOlderDaemon` uses. */
export interface OlderDaemonSocket {
  readonly destroyed: boolean;
  write(frame: string): unknown;
  destroy(): void;
}

/** The `reason` a client gives in the shutdown request it sends an older daemon. */
export const OLDER_RELEASE_REPLACEMENT = 'older-release-replacement';

/** Consecutive older daemons asked to stop before the one still answering is ended. */
const STOP_REQUESTS_BEFORE_ENDING = 3;

/**
 * Sends `shutdownFrame()` (an authenticated shutdown request in the daemon's own protocol) and
 * closes the connection; returns the error that fails this connect.
 */
export function retireOlderDaemon(
  socket: OlderDaemonSocket | null | undefined,
  shutdownFrame: () => string,
  hello: { pid?: unknown; runtimeVersion?: unknown },
  service: string,
): OlderDaemonError {
  if (socket && !socket.destroyed) {
    try {
      socket.write(shutdownFrame());
    } catch {
      // A daemon that cannot hear the request is ended after repeated attempts.
    }
    const timer = setTimeout(() => socket.destroy(), 25);
    timer.unref?.();
  }
  const version = String(hello.runtimeVersion);
  const pid =
    typeof hello.pid === 'number' && Number.isSafeInteger(hello.pid) && hello.pid > 0
      ? hello.pid
      : undefined;
  return new OlderDaemonError(
    `${service} ${version} is older than this client ${WRONGSTACK_RUNTIME_VERSION}`,
    pid,
  );
}

/**
 * How long a client waits for an older daemon it asked to stop to exit before starting its own.
 * A 1.7.2 daemon's shutdown is bounded at about two seconds. Kanban and Session Catalog daemons
 * of that release remove their Unix socket path as they finish, after their listener already
 * released it, so a successor bound sooner would be left unreachable.
 */
const OLDER_DAEMON_EXIT_GRACE_MS = 2_500;

/**
 * The election-loop step after a failed connect: true when `error` is an older daemon that was
 * asked to stop, once that daemon has exited (or `exitGraceMs` passed), so the caller starts its
 * own daemon at once instead of waiting out the spawn cadence. `attempts` carries the count
 * across the loop; at the third, the daemon is ended.
 */
export async function replaceOlderDaemon(
  error: unknown,
  attempts: { count: number },
  exitGraceMs = OLDER_DAEMON_EXIT_GRACE_MS,
): Promise<boolean> {
  if (!(error instanceof OlderDaemonError)) return false;
  attempts.count++;
  if (attempts.count >= STOP_REQUESTS_BEFORE_ENDING) forceStopDaemon(error.pid);
  const deadline = Date.now() + exitGraceMs;
  do await new Promise((resolve) => setTimeout(resolve, 50));
  while (isRunning(error.pid) && Date.now() < deadline);
  return true;
}

/** Whether `pid` is a running process other than this one (`EPERM`: running, not ours). */
function isRunning(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ends the daemon `pid`; false when there is none to end: no pid, this process, or one that
 * already exited or is not ours to end (`ESRCH`, `EPERM`).
 */
export function forceStopDaemon(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}
