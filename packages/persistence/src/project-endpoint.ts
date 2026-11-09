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

import { withFileLock } from './atomic-write.js';
import { assertUnixSocketPathWithinLimit } from './socket-path.js';

/**
 * Test seam. The `node:fs/promises` members are deliberately left undefined
 * and resolved at call time (`fsOp` below): reading them at module load makes
 * every suite that partially mocks `node:fs/promises` fail on *import* of this
 * module, and this module is reachable from the package index.
 */
export const _projectEndpointOps = {
  platform: process.platform,
  mkdir: undefined as typeof fsPromises.mkdir | undefined,
  chmod: undefined as typeof fsPromises.chmod | undefined,
  stat: undefined as typeof fsPromises.stat | undefined,
  rm: undefined as typeof fsPromises.rm | undefined,
  createConnection: net.createConnection,
};

/**
 * Real implementation behind a test-overridable op, resolved at CALL time.
 *
 * Two constraints meet here. Indexing a namespace import with a variable
 * (`fsPromises[name]`) defeats bundler analysis, so the access has to name its
 * members literally. But hoisting those members into a module-level map reads
 * them at IMPORT time, which breaks every test that partially mocks
 * `node:fs/promises`: the mock has no `mkdir` yet when this module loads, and
 * the whole package fails to import. The switch satisfies both — literal member
 * names, read only when the op is actually needed.
 */
function fsFallback(name: 'mkdir' | 'chmod' | 'stat' | 'rm'): unknown {
  switch (name) {
    case 'mkdir':
      return fsPromises.mkdir;
    case 'chmod':
      return fsPromises.chmod;
    case 'stat':
      return fsPromises.stat;
    default:
      return fsPromises.rm;
  }
}

function fsOp<K extends 'mkdir' | 'chmod' | 'stat' | 'rm'>(
  name: K,
): NonNullable<(typeof _projectEndpointOps)[K]> {
  return (_projectEndpointOps[name] ?? fsFallback(name)) as NonNullable<
    (typeof _projectEndpointOps)[K]
  >;
}

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
 * False means liveness was not confirmed. Reclaiming needs stronger evidence:
 * only missing/refused connections prove absence; permission/resource errors
 * and timeouts leave ownership unknown.
 */
export async function isProjectEndpointLive(
  endpoint: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return (await probeProjectEndpoint(endpoint, timeoutMs)) === 'live';
}

type EndpointProbeState = 'live' | 'absent' | 'unknown';

function failedProbeState(error: unknown): EndpointProbeState {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' ? 'absent' : 'unknown';
}

function probeProjectEndpoint(
  endpoint: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<EndpointProbeState> {
  const safeTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : PROBE_TIMEOUT_MS;
  return new Promise<EndpointProbeState>((resolve) => {
    let settled = false;
    let probe: net.Socket;
    try {
      probe = _projectEndpointOps.createConnection(endpoint);
    } catch (error) {
      return resolve(failedProbeState(error));
    }
    const finish = (state: EndpointProbeState): void => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish('unknown'), safeTimeoutMs);
    timer.unref?.();
    probe.once('connect', () => {
      clearTimeout(timer);
      finish('live');
    });
    probe.once('error', (error) => {
      clearTimeout(timer);
      finish(failedProbeState(error));
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
  // Fail loudly and early on an empty endpoint or over-long `sun_path`. Left to
  // `bind()`, an empty endpoint on Windows/Unix coerces to TCP port 0, and an
  // over-long Unix socket path surfaces as EINVAL/ENAMETOOLONG.
  assertUnixSocketPathWithinLimit(endpoint, service, _projectEndpointOps.platform);
  if (_projectEndpointOps.platform === 'win32') return;
  const dir = path.dirname(endpoint);
  await fsOp('mkdir')(dir, {
    recursive: true,
    mode: ENDPOINT_DIR_MODE,
  });
  // G1 (DIP-002/DIP-003): the mkdir above is a no-op when the directory
  // already exists, and a no-op is exactly what a squatter wants — the
  // directory keeps the wider mode it had when *they* created it. Force
  // the 0o700 chmod and verify ownership before letting `bind()` take
  // the predictable name from inside it. A mis-owned directory means
  // another local user can see and impersonate the IPC channel; refuse
  // to start, do not silently exit into a squatter.
  await fsOp('chmod')(dir, ENDPOINT_DIR_MODE).catch(() => {
    // Filesystems that reject chmod (e.g. FAT mounts) still keep the
    // ownership check as the second line of defence below.
  });
  const st = await fsOp('stat')(dir);
  const myUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (myUid !== undefined && st.uid !== myUid) {
    throw new Error(
      `project endpoint directory ${dir} is owned by uid ${st.uid}, expected ${myUid} (G1: refuse to bind inside a squatted IPC dir)`,
    );
  }
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
  const maxAttempts =
    typeof options.maxAttempts === 'number' && Number.isFinite(options.maxAttempts)
      ? Math.max(1, Math.trunc(options.maxAttempts))
      : DEFAULT_MAX_ATTEMPTS;
  const isWindows = _projectEndpointOps.platform === 'win32';

  try {
    await ensureProjectEndpointDirectory(endpoint, service);
  } catch (error) {
    return {
      outcome: 'failed',
      error: isErrno(error) ? error : new Error(String(error)),
    };
  }

  const runElection = async (): Promise<BindProjectEndpointOutcome> => {
    let reclaimed = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const error = await attemptListen(server, endpoint);
      if (!error) {
        if (!isWindows) {
          await fsOp('chmod')(endpoint, ENDPOINT_FILE_MODE).catch(() => {
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

      const owner = await probeProjectEndpoint(endpoint);
      if (owner === 'live') return { outcome: 'already-owned' };
      if (owner === 'unknown') {
        return {
          outcome: 'failed',
          error: new Error(
            `${service} could not verify that its IPC endpoint at ${endpoint} is stale; refusing to reclaim an endpoint with unknown ownership.`,
          ),
        };
      }

      try {
        await fsOp('rm')(endpoint, { force: true });
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
  };

  if (isWindows) return runElection();

  // The liveness probe and stale unlink are one election step. Without a
  // cross-process critical section, contender A can bind after contender B's
  // probe but before B's unlink; B would then remove A's live socket and both
  // callers could report `bound`. The lock is released immediately after the
  // server starts listening, so later contenders observe the live endpoint.
  try {
    return await withFileLock(endpoint, runElection);
  } catch (error) {
    return {
      outcome: 'failed',
      error: new Error(
        `${service} could not serialize its IPC endpoint election at ${endpoint}: ` +
          `${isErrno(error) ? error.message : String(error)}`,
      ),
    };
  }
}

/**
 * Puts a daemon's own metadata file back when another writer replaced it.
 *
 * A project's metadata file (`server.json`: pid, endpoint, the auth token)
 * has one path per project, but the endpoint name is versioned: when it
 * changes between releases (1.0.27 mixed a per-user secret into every name),
 * a process of the old release and one of the new elect DIFFERENT endpoints —
 * two live daemons — and both write the same file. Whichever wrote last owns
 * the token every client reads, so every client of the other daemon is
 * refused, and stays refused after the writer exits: a daemon wrote its file
 * once, at startup.
 *
 * A refused token is the signal. `reassert()` reads the file and rewrites it
 * only when it no longer names this daemon (pid AND endpoint), so a rejection
 * caused by a caller that simply guessed costs one read. Calls are coalesced;
 * it never throws. Clients that re-read the file on a refusal then recover on
 * their next attempt.
 */
export interface ProjectMetadataReasserter {
  /** Start guarding. Call once the daemon's first metadata write has landed. */
  enable(): void;
  /** Stop guarding (the daemon is stopping and removes its file). */
  disable(): void;
  /** Rewrite the file when it names another daemon, is missing or unreadable. */
  reassert(): Promise<void>;
}

export function createProjectMetadataReasserter(options: {
  readonly metadataPath: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly authToken?: string;
  readonly write: () => Promise<void>;
}): ProjectMetadataReasserter {
  let enabled = false;
  let inFlight: Promise<void> | null = null;
  let rerun = false;
  const namesThisDaemon = async (): Promise<boolean> => {
    try {
      const current = JSON.parse(await fsPromises.readFile(options.metadataPath, 'utf8')) as {
        pid?: unknown;
        endpoint?: unknown;
        authToken?: unknown;
      };
      if (
        typeof current !== 'object' ||
        current === null ||
        current.pid !== options.pid ||
        current.endpoint !== options.endpoint
      ) {
        return false;
      }
      if (
        'authToken' in current &&
        (typeof current.authToken !== 'string' || current.authToken.trim().length === 0)
      ) {
        return false;
      }
      if (options.authToken !== undefined && current.authToken !== options.authToken) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  return {
    enable: () => {
      enabled = true;
    },
    disable: () => {
      enabled = false;
      rerun = false;
    },
    reassert: () => {
      if (!enabled) return Promise.resolve();
      if (inFlight) {
        rerun = true;
        return inFlight;
      }
      inFlight = (async () => {
        try {
          do {
            rerun = false;
            try {
              if (!(await namesThisDaemon()) && enabled) await options.write();
            } catch {
              // Best effort: coalesced rerun or the next refused request tries again.
            }
          } while (rerun && enabled);
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}

/**
 * Retries a project-daemon request the daemon refused for its auth token.
 *
 * The client must forget its cached token when a refusal arrives, so each
 * attempt re-reads the metadata file: a daemon that just started has not
 * written it yet, one of another release may have overwritten it, and the
 * owner puts it back on the first refusal (`createProjectMetadataReasserter`).
 * A refused request never ran, so resending it is safe. The budget (~2 s) is
 * the one the SAGE and Mailbox clients already use.
 */
export async function retryWhileUnauthorized<T>(
  attempt: () => Promise<T>,
  isUnauthorized: (error: unknown) => boolean,
  options: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<T> {
  const retries =
    typeof options.attempts === 'number' && Number.isFinite(options.attempts)
      ? Math.max(0, Math.trunc(options.attempts))
      : 13;
  const delayMs =
    typeof options.delayMs === 'number' && Number.isFinite(options.delayMs)
      ? Math.max(0, Math.trunc(options.delayMs))
      : 150;
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (retry >= retries || !isUnauthorized(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
