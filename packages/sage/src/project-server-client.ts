import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { daemonSpawnArgs } from '@wrongstack/persistence';
import { closeDaemonLogFd, openDaemonLogFd } from './daemon-log.js';
import { SageServedByWrongMemoryError, sageServiceBackendFor } from './memory-service-registry.js';
import {
  AUTH_RETRY_DELAY_MS,
  AUTH_RETRY_MAX_ATTEMPTS,
  CONNECT_ATTEMPT_TIMEOUT_MS,
  cancellationError,
  delay,
  MAX_SERVER_WRITE_BUFFER_BYTES,
  type PendingRequest,
  type SageProjectServerCallOptions,
  type SageProjectServerConnectionOptions,
  type SageProjectServerConnectionState,
  type SageProjectServerConnectionStatus,
} from './project-server-client-contract.js';
import {
  connectWithElection,
  handleServerMessage,
  handleSocketClose,
  receiveData,
  type SageProjectServerConnectionInternals,
  type SageProjectServerOutboundMessage,
  sendRequest,
} from './project-server-client-io.js';
import {
  isSageProjectServerAvailable,
  readSageServerAuthToken,
  resolveProjectServerUrl,
} from './project-server-client-launch.js';
import {
  resolveProjectSageStorageRoot,
  sageProjectServerEndpoint,
  sageProjectServerLogPath,
} from './project-server-endpoint.js';
import {
  encodeSageProjectServerMessage,
  type SageProjectServerInfo,
  type SageProjectServerMessage,
  type SageRequestMetadata,
  type SageServerOperationName,
  type SageServerOperations,
} from './project-server-protocol.js';
import {
  SageStoreOwnedByWrongMemoryError,
  wrongMemoryOwnsStore,
} from './wrongmemory-owner-guard.js';

export {
  type SageProjectServerConnectionOptions,
  type SageProjectServerConnectionState,
  SageProjectServerNotRunningError,
} from './project-server-client-contract.js';
export { isSageProjectServerAvailable } from './project-server-client-launch.js';

export class SageProjectServerConnection {
  private socket: net.Socket | null = null;
  private info: SageProjectServerInfo | null = null;
  protected buffer = '';
  private connecting: Promise<void> | null = null;
  protected connectResolve: (() => void) | null = null;
  private connectReject: ((error: unknown) => void) | null = null;
  protected nextId = 1;
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
  /** Error reported by the live socket before it closed, if any. */
  protected closeCause: Error | null = null;
  private closeController = new AbortController(); // close() aborts, then replaces it
  /**
   * Bumped by every close(): an in-flight connect election captures it and
   * stops (no retry, no re-armed spawn) when it moves. Without this, a close()
   * landing mid-election was treated like any failed attempt — the loop kept
   * retrying, respawned the detached daemon, and a late hello flipped the
   * disposed connection back to 'connected' (round r1-20261024).
   */
  private connectEpoch = 0;

  private readonly spawnIfMissing: boolean;

  constructor(
    readonly projectRoot: string,
    readonly directory?: string | undefined,
    options: SageProjectServerConnectionOptions = {},
  ) {
    this.spawnIfMissing = options.spawnIfMissing !== false;
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
    await this.ensureConnected(this.spawnIfMissing);
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
    const closed = this.closeController.signal; // read before any await; close() swaps it
    await this.ensureConnected(this.spawnIfMissing);
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
        const wake = options.signal ? AbortSignal.any([options.signal, closed]) : closed;
        await delay(AUTH_RETRY_DELAY_MS, wake);
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
    this.connectEpoch++;
    const socket = this.socket;
    this.socket = null;
    this.info = null;
    this.connectReject?.(new Error('SAGE server client disconnected'));
    this.connectResolve = null;
    this.connectReject = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectPending(new Error('SAGE server client disconnected'));
    this.closeController.abort(new Error('SAGE server client disconnected'));
    this.closeController = new AbortController();
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
    const epoch = this.connectEpoch;
    this.connecting = this.connectWithElection(spawnIfMissing)
      .catch((error) => {
        // The election died because close() ran mid-election: close() already
        // set the truthful terminal state ('offline'/'unavailable'). Painting
        // 'error' over it would report an intentional teardown as a failure.
        if (epoch === this.connectEpoch) this.transition('error', { error });
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  /**
   * This connection as the structural view its extracted I/O takes (see
   * project-server-client-io.ts). Members read only through it are
   * `protected` rather than `private` so `noUnusedLocals` sees them as used.
   */
  private internals(): SageProjectServerConnectionInternals {
    return this as unknown as SageProjectServerConnectionInternals;
  }

  private async connectWithElection(spawnIfMissing: boolean): Promise<void> {
    // A server spawned for a store WrongMemory owns exits at startup with
    // SageStoreOwnedByWrongMemoryError, which only reaches its log file: the
    // election would respawn it until it gives up with a bare pipe ENOENT.
    // Refuse before spawning, and name the cause if the owner appeared
    // mid-election.
    if (spawnIfMissing && sageServiceBackendFor(this.projectRoot)?.backend === 'wrongmemory') {
      throw new SageServedByWrongMemoryError(this.projectRoot);
    }
    const storeDir = resolveProjectSageStorageRoot(this.projectRoot, this.directory);
    if (spawnIfMissing && wrongMemoryOwnsStore(storeDir)) {
      throw new SageStoreOwnedByWrongMemoryError(storeDir);
    }
    try {
      return await connectWithElection(this.internals(), spawnIfMissing);
    } catch (error) {
      if (wrongMemoryOwnsStore(storeDir)) throw new SageStoreOwnedByWrongMemoryError(storeDir);
      throw error;
    }
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
  protected currentAuthToken(): string | undefined {
    if (this.authToken === undefined) this.authToken = this.readAuthToken();
    return this.authToken;
  }

  private readAuthToken(): string | undefined {
    return readSageServerAuthToken(this.projectRoot, this.directory);
  }

  protected connectOnce(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.info = null;
    this.buffer = '';
    this.closeCause = null;
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
        else if (socket === this.socket) this.closeCause = error;
      });
      socket.on('close', () => this.onClose(socket));
    });
  }

  private request<T>(
    message: SageProjectServerOutboundMessage,
    options: SageProjectServerCallOptions,
  ): Promise<T> {
    return sendRequest<T>(this.internals(), message, options);
  }

  private onData(socket: net.Socket, chunk: string): void {
    receiveData(this.internals(), socket, chunk);
  }

  protected onMessage(message: SageProjectServerMessage): void {
    handleServerMessage(this.internals(), message);
  }

  private onClose(socket: net.Socket): void {
    handleSocketClose(this.internals(), socket);
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

  protected write(message: object): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    // The boolean return of socket.write is deliberately ignored: this cap is
    // the backstop, and per-write drain awaiting would serialize callers
    // behind slow I/O. Mirror of the server's writeEncoded — keep the two
    // thresholds in sync.
    const encoded = encodeSageProjectServerMessage(message);
    const encodedBytes = Buffer.byteLength(encoded, 'utf8');
    if (
      encodedBytes > MAX_SERVER_WRITE_BUFFER_BYTES ||
      socket.writableLength + encodedBytes > MAX_SERVER_WRITE_BUFFER_BYTES
    ) {
      socket.destroy(new Error('SAGE server fell too far behind on reads'));
      return;
    }
    socket.write(encoded);
  }

  protected spawnDetachedServer(): void {
    const url = resolveProjectServerUrl();
    if (!url) throw new Error('Built SAGE project server is unavailable');
    const args = ['--project-root', this.projectRoot];
    if (this.directory) args.push('--directory', this.directory);
    // Persist the daemon's stderr instead of discarding it. A crash AFTER the
    // bind — e.g. SQLITE_IOERR_SHMOPEN when the store is the Windows side's
    // live WAL database reached through a 9p/drvfs mount — previously
    // vanished completely, leaving a tombstone socket and a generic
    // ECONNREFUSED. Best-effort: an unusable sink falls back to 'ignore' and
    // must never block spawning.
    const logFd = openDaemonLogFd(
      sageProjectServerLogPath(this.projectRoot, this.directory),
      `${new Date().toISOString()} spawn endpoint=${this.state.endpoint} project=${this.projectRoot} pid=${process.pid}\n`,
    );
    const child = spawn(process.execPath, daemonSpawnArgs(url, args), {
      detached: true,
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
      windowsHide: true,
      env: process.env,
    });
    // Nothing else consumes lifecycle events; without a listener a
    // spawn-level 'error' (e.g. a transient EMFILE under load) would crash
    // this process instead of failing the connect. The cadence-bounded
    // re-spawn in connectWithElection owns recovery, so the events only need
    // to be safely observable — and to release the parent's copy of the log
    // fd, which the kernel dups into the child at spawn time either way.
    child.once('spawn', () => closeDaemonLogFd(logFd));
    child.on('error', () => closeDaemonLogFd(logFd));
    child.unref();
  }
}
