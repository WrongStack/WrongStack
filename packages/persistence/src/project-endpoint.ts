/**
 * Shared IPC endpoint ownership election for WrongStack project daemons.
 *
 * Every project daemon (kanban, sage, chronicle, mailbox, session-catalog,
 * codebase-index, governance) binds a deterministic per-project endpoint — a
 * Unix domain socket under the temp directory, or a Windows named pipe. The
 * bind IS the ownership election: whoever binds owns the project's state, and
 * every loser must exit rather than open a second writer.
 *
 * That election has one failure mode that is easy to miss and impossible to
 * recover from once missed. On Unix, `bind()` creates a filesystem entry that
 * `close()` is responsible for removing. A daemon killed with SIGKILL, reaped
 * by the OOM killer, or stopped with its container never runs that cleanup, so
 * the socket file survives with nothing listening behind it. From then on:
 *
 *   - a client `connect()` gets ECONNREFUSED and concludes "no daemon, spawn one"
 *   - the spawned daemon's `listen()` gets EADDRINUSE, because the path exists
 *   - the daemon dies, the client retries, and the cycle repeats — forever
 *
 * Nothing breaks the loop on its own: the stale file is never removed, so the
 * project's daemon is permanently unstartable until someone deletes it by hand.
 *
 * The recovery is a probe. EADDRINUSE alone cannot distinguish "a live owner
 * holds this endpoint" from "a dead owner left the file behind", but a connect
 * attempt can: it succeeds against a live owner and fails against a stale
 * entry. Only the second case may unlink and retry — unlinking a live owner's
 * socket would silently sever every connected client and elect a second writer
 * over the same SQLite database, which is the exact invariant the election
 * exists to protect.
 *
 * This module is that ladder, written once. It previously lived in five
 * hand-rolled copies at three levels of completeness, and the two daemons that
 * omitted the probe (kanban, codebase-index) were wedgeable by design. Callers
 * get an outcome to switch on rather than an exception to classify.
 */
import * as fsPromises from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';

import { assertUnixSocketPathWithinLimit } from './socket-path.js';

/** How long a liveness probe waits before calling the endpoint unreachable. */
const PROBE_TIMEOUT_MS = 500;

/**
 * Reclaim attempts before giving up. Each attempt is one unlink + re-listen,
 * so >1 only matters when daemons race: two contenders can both see a stale
 * endpoint, both unlink, and one binds between the other's unlink and listen.
 * Three attempts makes that race vanishingly unlikely without ever looping.
 */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Mode for the endpoint's parent directory — the cross-user ownership boundary. */
const ENDPOINT_DIR_MODE = 0o700;

/** Mode for the socket itself, once bound. */
const ENDPOINT_FILE_MODE = 0o600;

export type BindProjectEndpointOutcome =
  /** This process owns the endpoint. It is listening. */
  | { readonly outcome: 'bound'; readonly reclaimedStaleEndpoint: boolean }
  /**
   * A live daemon already owns this endpoint. Not an error: the caller lost a
   * startup race it did not need to win, and must exit 0 without touching
   * project state. Clients will reach the winner.
   */
  | { readonly outcome: 'already-owned' }
  /**
   * The endpoint could not be bound and could not be reclaimed. The caller
   * should report `error` and exit non-zero. This is the only outcome that
   * warrants operator attention.
   */
  | { readonly outcome: 'failed'; readonly error: Error };

export interface BindProjectEndpointOptions {
  /** A server that has NOT yet been asked to listen. */
  readonly server: net.Server;
  /** Endpoint to bind: a socket path, or a `\\.\pipe\...` name on Windows. */
  readonly endpoint: string;
  /** Service name, used only in error text (`kanban`, `sage`, ...). */
  readonly service: string;
  /** Override the reclaim attempt budget. Defaults to 3. */
  readonly maxAttempts?: number;
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

/**
 * True when something is accepting connections at `endpoint` right now.
 *
 * This is the only safe way to tell a live owner from a stale socket file, and
 * the answer decides whether reclaiming is allowed. Any failure — refused,
 * missing, timed out — reads as "not live": a daemon that cannot be reached
 * within the probe window cannot be serving clients either, and leaving the
 * project permanently unstartable is the worse outcome.
 */
export function isProjectEndpointLive(
  endpoint: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(live);
    };
    const probe = net.createConnection(endpoint);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    probe.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    probe.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Create the endpoint's parent directory with the mode that makes it an
 * ownership boundary.
 *
 * `0o700` is load-bearing on Unix: the socket name is derived from the project
 * path, so it is fully predictable, and a world-writable sticky-bit `/tmp`
 * would let another local user pre-bind it and receive this project's traffic.
 * The private directory is what makes the predictable name safe.
 *
 * Deliberately not exported: `bindProjectEndpoint` is the only supported way
 * to take an endpoint, and a caller that creates the directory itself is one
 * that skipped the liveness probe.
 */
async function ensureProjectEndpointDirectory(endpoint: string, service: string): Promise<void> {
  if (process.platform === 'win32') return;
  // Fail loudly and early on an over-long `sun_path`. Left to `bind()`, it
  // surfaces as EINVAL/ENAMETOOLONG inside a detached child whose stderr is
  // discarded, which reaches the operator as a bare connect timeout.
  assertUnixSocketPathWithinLimit(endpoint, service);
  await fsPromises.mkdir(path.dirname(endpoint), {
    recursive: true,
    mode: ENDPOINT_DIR_MODE,
  });
}

/** One `listen()` attempt. Resolves with the error instead of throwing it. */
function attemptListen(
  server: net.Server,
  endpoint: string,
): Promise<NodeJS.ErrnoException | null> {
  return new Promise<NodeJS.ErrnoException | null>((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      resolve(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(null);
    };
    // Both are `once`, and whichever fires first detaches the other, so the
    // server is left with no bind-phase handlers either way. The caller is
    // then free to attach its own permanent 'error' handler for runtime
    // faults without racing this one.
    server.once('error', onError);
    server.once('listening', onListening);
    // `listen()` can also throw synchronously (ERR_SERVER_ALREADY_LISTEN on a
    // reused server, an invalid endpoint). Inside a Promise executor that
    // becomes a rejection, which would break this module's contract — callers
    // switch on an outcome, they do not classify exceptions — and would leave
    // both handlers attached. Resolve with the error like every other failure.
    try {
      server.listen(endpoint);
    } catch (error) {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      resolve(error as NodeJS.ErrnoException);
    }
  });
}

/**
 * Bind `endpoint`, reclaiming it from a dead owner when — and only when — a
 * liveness probe proves no owner is there.
 *
 * On success the socket is chmod'ed to `0600`. That is belt-and-braces next to
 * the `0700` directory, and it is best-effort: a filesystem that rejects the
 * chmod has not invalidated the directory boundary, so a failure here is not
 * worth refusing to start over.
 */
export async function bindProjectEndpoint(
  options: BindProjectEndpointOptions,
): Promise<BindProjectEndpointOutcome> {
  const { server, endpoint, service } = options;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const isWindows = process.platform === 'win32';

  try {
    await ensureProjectEndpointDirectory(endpoint, service);
  } catch (error) {
    return {
      outcome: 'failed',
      error: isErrno(error) ? error : new Error(String(error)),
    };
  }

  let reclaimed = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const error = await attemptListen(server, endpoint);
    if (!error) {
      if (!isWindows) {
        await fsPromises.chmod(endpoint, ENDPOINT_FILE_MODE).catch(() => {
          // The 0700 parent directory still restricts access to this user.
        });
      }
      return { outcome: 'bound', reclaimedStaleEndpoint: reclaimed };
    }
    if (error.code !== 'EADDRINUSE') return { outcome: 'failed', error };

    // A Windows named pipe has no filesystem entry to go stale: EADDRINUSE
    // means a live process holds the pipe, full stop. There is nothing to
    // reclaim and probing would only add a race.
    if (isWindows) return { outcome: 'already-owned' };

    if (await isProjectEndpointLive(endpoint)) return { outcome: 'already-owned' };

    try {
      await fsPromises.rm(endpoint, { force: true });
      reclaimed = true;
    } catch (removeError) {
      // A competing contender may have removed it first, which is fine — the
      // next listen decides. Anything else (EPERM on a socket owned by another
      // user) is terminal and must not be retried into a spin.
      const code = isErrno(removeError) ? removeError.code : undefined;
      if (code !== 'ENOENT') {
        return {
          outcome: 'failed',
          error: new Error(
            `${service} could not reclaim its stale IPC endpoint at ${endpoint}: ` +
              `${isErrno(removeError) ? removeError.message : String(removeError)}`,
          ),
        };
      }
    }
  }

  return {
    outcome: 'failed',
    error: new Error(
      `${service} could not bind its IPC endpoint at ${endpoint} after ${maxAttempts} ` +
        `attempts: the endpoint is in use but no daemon answers on it. ` +
        `Remove the stale socket and retry.`,
    ),
  };
}
