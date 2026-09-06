import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  sageProjectServerEndpoint,
  sageProjectServerMetadataPath,
} from './project-server-endpoint.js';
import {
  encodeSageProjectServerMessage,
  SAGE_PROJECT_SERVER_PROTOCOL_VERSION,
  type SageProjectServerInfo,
  type SageProjectServerMessage,
  type SageProjectServerMetadata,
  type SageRequestMetadata,
  type SageServerOperationName,
  type SageServerOperations,
} from './project-server-protocol.js';

const CONNECT_ATTEMPT_TIMEOUT_MS = 750;
const SERVER_START_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_FRAME_BUFFER_CHARS = 8 * 1024 * 1024;
/**
 * Pause between retries of a request refused with `UnauthorizedSageRequest`.
 * On cold spawn the daemon binds the socket before `store.initialize()` +
 * `writeMetadata()` finish, so the first request can arrive while
 * `server.json` does not exist yet. The token is invalidated in `onMessage`;
 * this delay gives the daemon time to write the file before
 * `currentAuthToken()` re-reads it.
 */
const AUTH_RETRY_DELAY_MS = 150;
/**
 * How many auth-refused retries `call()` attempts before surfacing the error.
 * `onMessage` invalidates the cached token on every `UnauthorizedSageRequest`,
 * so each retry re-reads `server.json`. Bounded rather than a single shot
 * because a true cold spawn — SQLite open + migrations on a cold disk — can
 * take well over one delay interval before `writeMetadata()` lands; ~2s total
 * covers realistic init while still failing fast when the daemon is genuinely
 * unreachable.
 */
const AUTH_RETRY_MAX_ATTEMPTS = 13;

type SageProjectServerConnectionStatus =
  | 'unavailable'
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'stopping';

export interface SageProjectServerConnectionState {
  status: SageProjectServerConnectionStatus;
  connected: boolean;
  projectRoot: string;
  storageDirectory?: string | undefined;
  endpoint: string;
  pid?: number | undefined;
  lastError?: string | undefined;
}

interface SageProjectServerCallOptions {
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  meta: SageRequestMetadata;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

function resolveProjectServerUrl(): URL | null {
  if (process.env['WRONGSTACK_SAGE_SERVER'] === '0') return null;
  try {
    const url = new URL('./project-server.js', import.meta.url);
    if (url.protocol === 'file:' && fs.existsSync(fileURLToPath(url))) return url;
  } catch {
    // The package may be running directly from TypeScript source.
  }
  return null;
}

export function isSageProjectServerAvailable(): boolean {
  return resolveProjectServerUrl() !== null;
}

/**
 * A sleep whose timer stays REF'd on purpose.
 *
 * Both callers (`connectWithElection`'s retry pause and the auth retry in
 * `request`) are awaited by boot code that has nothing else pending on the
 * loop: the previous socket is destroyed before the pause and the next one
 * does not exist yet. An unref'd timer there let Node decide the loop was
 * empty and exit 0 *in the middle of boot* — the WebUI process vanished
 * before printing its banner, and CI reported only "exited before it was
 * ready (code 0)". A pending promise must hold the process open; the hold is
 * bounded by the caller's own deadline (10s election, 3 auth retries).
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(cancellationError(signal!));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('SAGE request cancelled');
}

function remoteError(message: string, name?: string): Error {
  const error = new Error(message);
  if (name && name !== 'Error') error.name = name;
  return error;
}

export class SageProjectServerConnection {
  private socket: net.Socket | null = null;
  private info: SageProjectServerInfo | null = null;
  private buffer = '';
  private connecting: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: unknown) => void) | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<
    (event: string, payload: unknown, meta?: SageRequestMetadata | undefined) => void
  >();
  private readonly stateListeners = new Set<(state: SageProjectServerConnectionState) => void>();
  private state: SageProjectServerConnectionState;
  /**
   * WS-028: read from the daemon's owner-only `server.json`, never from the
   * `hello` frame. The daemon sends `hello` to every socket that connects, so
   * a token carried there was handed to exactly the caller it was meant to
   * refuse. Reading the file is the proof of same-user access the gate needs.
   */
  private authToken: string | undefined;

  constructor(
    readonly projectRoot: string,
    readonly directory?: string | undefined,
  ) {
    this.state = {
      status: isSageProjectServerAvailable() ? 'offline' : 'unavailable',
      connected: false,
      projectRoot,
      storageDirectory: directory,
      endpoint: sageProjectServerEndpoint(projectRoot, directory),
    };
  }

  getState(): SageProjectServerConnectionState {
    return { ...this.state };
  }

  onStateChange(listener: (state: SageProjectServerConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(
    listener: (event: string, payload: unknown, meta?: SageRequestMetadata | undefined) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async connect(): Promise<void> {
    await this.ensureConnected(true);
  }

  /** Inspect an existing project server without starting one. */
  async status(): Promise<SageServerOperations['ping']['result'] | null> {
    try {
      await this.ensureConnected(false);
      return await this.request(
        {
          type: 'request',
          op: 'ping',
          args: {},
          meta: { clientId: `sage-status-${process.pid}` },
        },
        { timeoutMs: 2_000, meta: { clientId: `sage-status-${process.pid}` } },
      );
    } catch {
      this.close();
      return null;
    }
  }

  async call<O extends SageServerOperationName>(
    op: O,
    args: SageServerOperations[O]['args'],
    options: SageProjectServerCallOptions,
  ): Promise<SageServerOperations[O]['result']> {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    await this.ensureConnected(true);
    if (options.signal?.aborted) throw cancellationError(options.signal);
    let lastError: unknown;
    // Cold-spawn / daemon-restart race: the daemon accepts connections (and
    // sends `hello`) before `store.initialize()` + `writeMetadata()` finish,
    // so an early request goes out with a missing or stale token and is
    // refused with `UnauthorizedSageRequest`. `onMessage` invalidates the
    // cached token on every refusal, so each retry re-reads `server.json`
    // via `currentAuthToken()`. Retry on a bounded budget rather than once so
    // a slow cold-start init still recovers instead of wedging the caller
    // (e.g. `RemoteSageMemoryPort.initialize()`'s first `ping`).
    for (let attempt = 0; attempt <= AUTH_RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.request<SageServerOperations[O]['result']>(
          { type: 'request', op, args, meta: options.meta },
          options,
        );
      } catch (error) {
        lastError = error;
        const retriable =
          error instanceof Error &&
          error.name === 'UnauthorizedSageRequest' &&
          attempt < AUTH_RETRY_MAX_ATTEMPTS;
        if (!retriable) throw error;
        await delay(AUTH_RETRY_DELAY_MS, options.signal);
        if (options.signal?.aborted) throw cancellationError(options.signal);
      }
    }
    // Unreachable: the loop returns on success and throws on the final
    // refusal (attempt === AUTH_RETRY_MAX_ATTEMPTS). Kept for type safety.
    throw lastError;
  }

  async shutdown(reason?: string): Promise<{ stopped: boolean; pid?: number; reason?: string }> {
    try {
      await this.ensureConnected(false);
    } catch {
      return { stopped: false, reason: 'not-running' };
    }
    const pid = this.info?.pid;
    try {
      this.transition('stopping', { pid });
      await this.request(
        { type: 'shutdown', reason },
        {
          timeoutMs: 5_000,
          meta: { clientId: 'sage-control' },
        },
      );
      return { stopped: true, ...(pid === undefined ? {} : { pid }) };
    } catch (error) {
      return {
        stopped: false,
        ...(pid === undefined ? {} : { pid }),
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.close();
    }
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.info = null;
    this.connectReject?.(new Error('SAGE server client disconnected'));
    this.connectResolve = null;
    this.connectReject = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectPending(new Error('SAGE server client disconnected'));
    this.transition(isSageProjectServerAvailable() ? 'offline' : 'unavailable');
  }

  private transition(
    status: SageProjectServerConnectionStatus,
    options: { pid?: number | undefined; error?: unknown } = {},
  ): void {
    const lastError =
      options.error === undefined
        ? status === 'error'
          ? this.state.lastError
          : undefined
        : options.error instanceof Error
          ? options.error.message
          : String(options.error);
    this.state = {
      status,
      connected: status === 'connected',
      projectRoot: this.projectRoot,
      storageDirectory: this.directory,
      endpoint: this.state.endpoint,
      pid: options.pid ?? (status === 'connected' ? this.info?.pid : undefined),
      lastError,
    };
    for (const listener of this.stateListeners) listener({ ...this.state });
  }

  private async ensureConnected(spawnIfMissing: boolean): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.info) return;
    if (this.connecting) return this.connecting;
    if (!isSageProjectServerAvailable()) {
      this.transition('unavailable', {
        error:
          'Built SAGE project server is unavailable. Build @wrongstack/sage or use WRONGSTACK_SAGE_INLINE=1 for explicit recovery mode.',
      });
      throw new Error(this.state.lastError);
    }
    this.transition('connecting');
    this.connecting = this.connectWithElection(spawnIfMissing)
      .catch((error) => {
        this.transition('error', { error });
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async connectWithElection(spawnIfMissing: boolean): Promise<void> {
    const deadline =
      Date.now() + (spawnIfMissing ? SERVER_START_TIMEOUT_MS : CONNECT_ATTEMPT_TIMEOUT_MS);
    let spawned = false;
    let lastError: unknown = new Error('SAGE project server unavailable');
    while (Date.now() < deadline) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error;
      }
      if (!spawnIfMissing) break;
      if (!spawned) {
        this.spawnDetachedServer();
        spawned = true;
      }
      await delay(75);
    }
    throw lastError;
  }

  /**
   * The auth token, read lazily from the daemon's owner-only `server.json`
   * and re-read while still unknown.
   *
   * WS-028: the token comes from the file, never from the `hello` frame —
   * reading it is the proof of same-user access the gate requires. Failure to
   * read it is not fatal here; the request is then refused with
   * `UnauthorizedSageRequest`, a far clearer signal than a connect that
   * silently succeeds and then fails every call.
   *
   * The daemon starts listening before `writeMetadata()` runs (ownership of
   * the endpoint has to be won first, and clobbering another daemon's
   * `server.json` to win it would be worse), so a client that connects in that
   * window sees no file yet. Re-reading on each stamp until one is found costs
   * a single small `readFileSync` and closes the window without reordering the
   * daemon's startup.
   */
  private currentAuthToken(): string | undefined {
    if (this.authToken === undefined) this.authToken = this.readAuthToken();
    return this.authToken;
  }

  private readAuthToken(): string | undefined {
    try {
      const raw = fs.readFileSync(
        sageProjectServerMetadataPath(this.projectRoot, this.directory),
        'utf8',
      );
      const parsed = JSON.parse(raw) as Partial<SageProjectServerMetadata>;
      return typeof parsed.authToken === 'string' && parsed.authToken.length > 0
        ? parsed.authToken
        : undefined;
    } catch {
      return undefined;
    }
  }

  private connectOnce(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.info = null;
    this.buffer = '';
    this.authToken = this.readAuthToken();
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.state.endpoint);
      this.socket = socket;
      socket.setEncoding('utf8');
      const timer = setTimeout(() => {
        reject(new Error('SAGE project server handshake timed out'));
        socket.destroy();
      }, CONNECT_ATTEMPT_TIMEOUT_MS);
      timer.unref?.();

      this.connectResolve = () => {
        clearTimeout(timer);
        this.connectResolve = null;
        this.connectReject = null;
        resolve();
      };
      this.connectReject = (error) => {
        clearTimeout(timer);
        this.connectResolve = null;
        this.connectReject = null;
        reject(error);
      };

      socket.on('data', (chunk: string) => this.onData(socket, chunk));
      socket.on('error', (error) => {
        if (!this.info) this.connectReject?.(error);
      });
      socket.on('close', () => this.onClose(socket));
    });
  }

  private request<T>(
    message:
      | {
          type: 'request';
          op: SageServerOperationName;
          args: unknown;
          meta: SageRequestMetadata;
        }
      | { type: 'shutdown'; reason?: string | undefined },
    options: SageProjectServerCallOptions,
  ): Promise<T> {
    const socket = this.socket;
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
    const id = this.nextId;
    this.nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
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
              authToken: this.currentAuthToken(),
              ...(message.meta.sessionId !== undefined
                ? { sessionId: message.meta.sessionId }
                : {}),
              ...(message.meta.traceId !== undefined ? { traceId: message.meta.traceId } : {}),
            },
            id,
          }
        : {
            ...message,
            id,
            ...(message.type === 'shutdown' ? { authToken: this.currentAuthToken() } : {}),
          };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        this.write({ type: 'cancel', id });
        this.cleanupPending(entry);
        entry.reject(
          new Error(
            `SAGE ${message.type === 'request' ? message.op : message.type} exceeded its ${options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS}ms timeout`,
          ),
        );
      }, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
      timer.unref?.();
      const signal = options.signal;
      const onAbort = signal
        ? () => {
            const entry = this.pending.get(id);
            if (!entry) return;
            this.pending.delete(id);
            this.write({ type: 'cancel', id });
            this.cleanupPending(entry);
            entry.reject(cancellationError(signal));
          }
        : undefined;
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      if (signal && onAbort) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      this.write(outbound);
    });
  }

  private onData(socket: net.Socket, chunk: string): void {
    if (socket !== this.socket) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_FRAME_BUFFER_CHARS) {
      socket.destroy(new Error('SAGE server frame exceeded maximum size'));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: SageProjectServerMessage;
      try {
        message = JSON.parse(line) as SageProjectServerMessage;
      } catch {
        socket.destroy(new Error('Invalid SAGE project server response'));
        return;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: SageProjectServerMessage): void {
    if (message.type === 'hello') {
      if (message.protocolVersion !== SAGE_PROJECT_SERVER_PROTOCOL_VERSION) {
        this.connectReject?.(
          new Error(
            `SAGE protocol mismatch: client=${SAGE_PROJECT_SERVER_PROTOCOL_VERSION}, server=${message.protocolVersion}`,
          ),
        );
        this.socket?.destroy();
        return;
      }
      this.info = message;
      this.transition('connected', { pid: message.pid });
      this.connectResolve?.();
      return;
    }
    if (message.type === 'event') {
      for (const listener of this.eventListeners) {
        listener(message.event, message.payload, message.meta);
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    this.cleanupPending(entry);
    if (message.ok) entry.resolve(message.result);
    else {
      // On auth failure, invalidate the cached token so the next request
      // re-reads server.json. This handles two race windows:
      // 1. Cold spawn: daemon is listening but hasn't written server.json yet
      // 2. Daemon restart: token changed while the client held a stale copy
      if (message.errorName === 'UnauthorizedSageRequest') {
        this.authToken = undefined;
      }
      entry.reject(remoteError(message.error, message.errorName));
    }
  }

  private onClose(socket: net.Socket): void {
    if (socket !== this.socket) return;
    const wasConnected = this.info !== null;
    this.socket = null;
    this.info = null;
    const error = new Error('SAGE project server connection closed');
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    this.rejectPending(error);
    this.transition(wasConnected ? 'error' : 'offline', wasConnected ? { error } : {});
  }

  private cleanupPending(entry: PendingRequest): void {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  }

  private rejectPending(error: unknown): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      this.cleanupPending(entry);
      entry.reject(error);
    }
  }

  private write(message: object): void {
    const socket = this.socket;
    if (socket && !socket.destroyed) socket.write(encodeSageProjectServerMessage(message));
  }

  private spawnDetachedServer(): void {
    const url = resolveProjectServerUrl();
    if (!url) throw new Error('Built SAGE project server is unavailable');
    const args = [fileURLToPath(url), '--project-root', this.projectRoot];
    if (this.directory) args.push('--directory', this.directory);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  }
}
