/**
 * Socket-level I/O of `SageProjectServerConnection`, extracted as free
 * functions over the connection's private state: the connect/spawn election
 * loop, request framing + pending-call routing, inbound frame parsing and
 * message dispatch, and close handling.
 */
import type * as net from 'node:net';
import {
  OLDER_RELEASE_REPLACEMENT,
  replaceOlderDaemon,
  retireOlderDaemon,
  shouldReplaceOlderDaemon,
} from '@wrongstack/primitives';
import {
  CONNECT_ATTEMPT_TIMEOUT_MS,
  cancellationError,
  DEFAULT_CALL_TIMEOUT_MS,
  delay,
  MAX_FRAME_BUFFER_CHARS,
  type PendingRequest,
  remoteError,
  type SageProjectServerCallOptions,
  type SageProjectServerConnectionStatus,
  SageProjectServerNotRunningError,
  SERVER_START_TIMEOUT_MS,
  SPAWN_RETRY_CADENCE_MS,
} from './project-server-client-contract.js';
import {
  encodeSageProjectServerMessage,
  SAGE_PROJECT_SERVER_PROTOCOL_VERSION,
  type SageProjectServerInfo,
  type SageProjectServerMessage,
  type SageRequestMetadata,
  type SageServerOperationName,
} from './project-server-protocol.js';

/**
 * The private state and methods of `SageProjectServerConnection`, as seen by
 * the functions below. The class hands itself over through this structural
 * view; consumers still see these members as non-public.
 */
export interface SageProjectServerConnectionInternals {
  readonly projectRoot: string;
  readonly spawnIfMissing: boolean;
  socket: net.Socket | null;
  info: SageProjectServerInfo | null;
  buffer: string;
  connectResolve: (() => void) | null;
  connectReject: ((error: unknown) => void) | null;
  nextId: number;
  readonly pending: Map<number, PendingRequest>;
  readonly eventListeners: Set<
    (event: string, payload: unknown, meta?: SageRequestMetadata | undefined) => void
  >;
  authToken: string | undefined;
  closeCause: Error | null;
  /** Bumped by close(): elections capture it and stop when it moves. */
  connectEpoch: number;
  connectOnce(): Promise<void>;
  spawnDetachedServer(): void;
  currentAuthToken(): string | undefined;
  write(message: object): void;
  onMessage(message: SageProjectServerMessage): void;
  cleanupPending(entry: PendingRequest): void;
  rejectPending(error: unknown): void;
  transition(
    status: SageProjectServerConnectionStatus,
    options?: { pid?: number | undefined; error?: unknown },
  ): void;
}

/** Outbound frame accepted by {@link sendRequest}. */
export type SageProjectServerOutboundMessage =
  | {
      type: 'request';
      op: SageServerOperationName;
      args: unknown;
      meta: SageRequestMetadata;
    }
  | { type: 'shutdown'; reason?: string | undefined };

export async function connectWithElection(
  self: SageProjectServerConnectionInternals,
  spawnIfMissing: boolean,
): Promise<void> {
  const deadline =
    Date.now() + (spawnIfMissing ? SERVER_START_TIMEOUT_MS : CONNECT_ATTEMPT_TIMEOUT_MS);
  const epoch = self.connectEpoch;
  const closedError = (): Error => new Error('SAGE server client disconnected');
  let lastSpawnAt = 0;
  const olderAttempts = { count: 0 };
  let lastError: unknown = new Error('SAGE project server unavailable');
  while (Date.now() < deadline) {
    // close() while this election was running stops it: no retry, no re-armed
    // spawn, no post-close hello resurrection (round r1-20261024).
    if (self.connectEpoch !== epoch) throw closedError();
    try {
      await self.connectOnce();
      return;
    } catch (error) {
      lastError = error;
      // An older daemon was asked to stop: start this release's daemon at once.
      if (spawnIfMissing && (await replaceOlderDaemon(error, olderAttempts))) lastSpawnAt = 0;
    }
    // The close may also land between the attempt failing and the spawn/retry
    // decision below — re-check before either.
    if (self.connectEpoch !== epoch) throw closedError();
    if (!spawnIfMissing) {
      // Only the attach-only mode names the absence; `status()` and
      // `shutdown()` probe with `false` too and keep their own handling.
      if (!self.spawnIfMissing)
        throw new SageProjectServerNotRunningError(self.projectRoot, lastError);
      break;
    }
    // Re-arm the spawn on SPAWN_RETRY_CADENCE_MS. A single spawn attempt made
    // a silently dead daemon (crash before bind, spawn-level error) fatal for
    // the whole window: every remaining retry hit `connect ENOENT` against a
    // pipe nothing would ever create, and the caller saw that raw error after
    // SERVER_START_TIMEOUT_MS. The first spawn still fires immediately
    // because lastSpawnAt starts at 0.
    const now = Date.now();
    if (now - lastSpawnAt >= SPAWN_RETRY_CADENCE_MS) {
      // A synchronous throw from the spawn path — the resolver transiently
      // failing to stat the dist entrypoint under load — must not unwind
      // the whole retry window (mailbox sibling flake, observed 2026-09-15:
      // one miss surfaced "entrypoint is unavailable" straight through
      // call()). Degrade to "this tick spawned nothing"; lastSpawnAt stays
      // unset so the next tick retries immediately rather than waiting out
      // the cadence.
      try {
        self.spawnDetachedServer();
        lastSpawnAt = now;
      } catch {
        // Resolution failures are retryable by the loop below.
      }
    }
    await delay(75);
  }
  throw lastError;
}

export function sendRequest<T>(
  self: SageProjectServerConnectionInternals,
  message: SageProjectServerOutboundMessage,
  options: SageProjectServerCallOptions,
): Promise<T> {
  const socket = self.socket;
  if (!socket || socket.destroyed) {
    return Promise.reject(new Error('SAGE server connection is not available'));
  }
  // Wrap before Number.MAX_SAFE_INTEGER: float64 cannot represent 2^53 + 1,
  // so an unchecked `++` saturates there and every later request would emit
  // the previous wire id — `pending.set` would then overwrite the earlier
  // request's routing entry and deliver responses to the wrong caller. A
  // wrapped id can only collide with an in-flight request if 2^53 requests
  // are outstanding simultaneously, which the per-request timeout makes
  // impossible.
  const id = self.nextId;
  self.nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
  // Auth stamp: every outbound `request` — and `shutdown` (WS-028) —
  // carries the authToken read from the daemon's owner-only `server.json`.
  // The server-side gate enforces equality; a wrong or missing token causes
  // an `UnauthorizedSageRequest` response. `clientId` is left to the server-assigned per-connection
  // nonce (see `project-server.ts` `net.createServer`), so the client
  // just forwards whatever value the caller passed in `meta.clientId`.
  const outbound =
    message.type === 'request'
      ? {
          ...message,
          meta: {
            clientId: message.meta.clientId,
            authToken: self.currentAuthToken(),
            ...(message.meta.sessionId !== undefined ? { sessionId: message.meta.sessionId } : {}),
            ...(message.meta.traceId !== undefined ? { traceId: message.meta.traceId } : {}),
          },
          id,
        }
      : {
          ...message,
          id,
          ...(message.type === 'shutdown' ? { authToken: self.currentAuthToken() } : {}),
        };
  return new Promise<T>((resolve, reject) => {
    const rejectRequest = (error: unknown, notifyServer = false): void => {
      const entry = self.pending.get(id);
      if (!entry) return;
      self.pending.delete(id);
      self.cleanupPending(entry);
      if (notifyServer) {
        try {
          self.write({ type: 'cancel', id });
        } catch {
          // Cancellation is best-effort on the wire. A failed notification
          // must not prevent local cleanup or leave the caller unsettled.
        }
      }
      entry.reject(error);
    };
    const timer = setTimeout(() => {
      rejectRequest(
        new Error(
          `SAGE ${message.type === 'request' ? message.op : message.type} exceeded its ${options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS}ms timeout`,
        ),
        true,
      );
    }, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    timer.unref?.();
    const signal = options.signal;
    const onAbort = signal
      ? () => {
          rejectRequest(cancellationError(signal), true);
        }
      : undefined;
    self.pending.set(id, { resolve, reject, timer, signal, onAbort });
    if (signal && onAbort) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }
    try {
      self.write(outbound);
    } catch (error) {
      rejectRequest(error);
    }
  });
}

export function receiveData(
  self: SageProjectServerConnectionInternals,
  socket: net.Socket,
  chunk: string,
): void {
  if (socket !== self.socket) return;
  // The buffered prefix was already scanned and holds no newline; search
  // only the new chunk. Rescanning the whole buffer — and re-slicing it per
  // line — was quadratic in frame size: a multi-megabyte frame arriving in
  // 64KB chunks was scanned from its first byte on every chunk. The search
  // must run on `chunk` itself: `indexOf` on `buffer + chunk` (even from an
  // offset) flattens the concatenation, an O(buffer) copy per chunk.
  let newline = chunk.indexOf('\n');
  if (newline < 0) {
    self.buffer += chunk;
  }
  let start = 0;
  while (newline >= 0) {
    const line = start === 0 ? self.buffer + chunk.slice(0, newline) : chunk.slice(start, newline);
    start = newline + 1;
    if (line) {
      let message: SageProjectServerMessage;
      try {
        message = JSON.parse(line) as SageProjectServerMessage;
      } catch {
        socket.destroy(new Error('Invalid SAGE project server response'));
        return;
      }
      self.onMessage(message);
      // A handler may have torn this socket down (protocol mismatch).
      if (socket !== self.socket || socket.destroyed) return;
    }
    newline = chunk.indexOf('\n', start);
  }
  if (start > 0) self.buffer = chunk.slice(start);
  // Bound the one frame still being assembled, not the complete frames the
  // chunk happened to carry alongside it.
  if (self.buffer.length > MAX_FRAME_BUFFER_CHARS) {
    socket.destroy(
      new Error(
        `SAGE server frame exceeded maximum size (${MAX_FRAME_BUFFER_CHARS} chars); page large results`,
      ),
    );
  }
}

export function handleServerMessage(
  self: SageProjectServerConnectionInternals,
  message: SageProjectServerMessage,
): void {
  if (message.type === 'hello') {
    if (message.protocolVersion !== SAGE_PROJECT_SERVER_PROTOCOL_VERSION) {
      self.connectReject?.(
        new Error(
          `SAGE protocol mismatch: client=${SAGE_PROJECT_SERVER_PROTOCOL_VERSION}, server=${message.protocolVersion}`,
        ),
      );
      self.socket?.destroy();
      return;
    }
    // A hello for a handshake nobody waits on anymore — close() ran
    // mid-election, or this attempt already failed — must not resurrect a
    // torn-down connection. The socket is dead or being destroyed; drop it.
    if (!self.connectResolve) return;
    if (shouldReplaceOlderDaemon(message.runtimeVersion)) {
      const shutdown = (): string => {
        const id = self.nextId;
        self.nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
        return encodeSageProjectServerMessage({
          type: 'shutdown',
          id,
          reason: OLDER_RELEASE_REPLACEMENT,
          authToken: self.currentAuthToken(),
        });
      };
      self.connectReject?.(
        retireOlderDaemon(self.socket, shutdown, message, 'SAGE project server'),
      );
      return;
    }
    self.info = message;
    self.transition('connected', { pid: message.pid });
    self.connectResolve?.();
    return;
  }
  if (message.type === 'event') {
    for (const listener of self.eventListeners) {
      listener(message.event, message.payload, message.meta);
    }
    return;
  }
  const entry = self.pending.get(message.id);
  if (!entry) return;
  self.pending.delete(message.id);
  self.cleanupPending(entry);
  if (message.ok) entry.resolve(message.result);
  else {
    // On auth failure, invalidate the cached token so the next request
    // re-reads server.json. This handles two race windows:
    // 1. Cold spawn: daemon is listening but hasn't written server.json yet
    // 2. Daemon restart: token changed while the client held a stale copy
    if (message.errorName === 'UnauthorizedSageRequest') {
      self.authToken = undefined;
    }
    entry.reject(remoteError(message.error, message.errorName));
  }
}

export function handleSocketClose(
  self: SageProjectServerConnectionInternals,
  socket: net.Socket,
): void {
  if (socket !== self.socket) return;
  const wasConnected = self.info !== null;
  self.socket = null;
  self.info = null;
  // Carry the socket error that caused the close (e.g. the frame-size guard
  // in onData). Without it every rejected caller saw only a generic
  // "connection closed" that pointed at the daemon instead of the payload.
  const cause = self.closeCause;
  self.closeCause = null;
  const error = new Error(
    cause
      ? `SAGE project server connection closed: ${cause.message}`
      : 'SAGE project server connection closed',
  );
  self.connectReject?.(error);
  self.connectResolve = null;
  self.connectReject = null;
  self.rejectPending(error);
  self.transition(wasConnected ? 'error' : 'offline', wasConnected ? { error } : {});
}
