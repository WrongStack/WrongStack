import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { checkUnixSocketPath } from '@wrongstack/core/utils';
import { IndexTimeoutError, LockError } from './circuit-breaker.js';
import {
  encodeBinaryFrame,
  isBinaryFrame,
  decodeBinaryFrame,
} from './binary-frame.js';
import {
  PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
  projectIndexServerBuildId,
  projectIndexServerEndpoint,
  projectIndexServerMetadataPath,
} from './project-server-endpoint.js';
import {
  encodeProjectServerMessage,
  PROJECT_INDEX_SERVER_MAX_FRAME_CHARS,
  type ProjectIndexServerActivity,
  type ProjectIndexServerHealth,
  type ProjectIndexServerInfo,
  type ProjectServerMessage,
} from './project-server-protocol.js';
import type { OpName, OpShapes } from './worker-protocol.js';

const CONNECT_ATTEMPT_TIMEOUT_MS = 750;
const SERVER_START_TIMEOUT_MS = 10_000;
const SERVER_CONTROL_TIMEOUT_MS = 5_000;
const SERVER_HEALTH_TIMEOUT_MS = 3_000;
const SERVER_HEARTBEAT_INTERVAL_MS = 10_000;

class StaleProjectIndexServerError extends Error {
  override readonly name = 'StaleProjectIndexServerError';

  constructor(
    message: string,
    readonly pid: number,
  ) {
    super(message);
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

export interface ProjectServerCallOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

export interface ProjectIndexServerShutdownResult {
  stopped: boolean;
  pid?: number | undefined;
  reason?: string | undefined;
}

export type ProjectIndexServerConnectionStatus =
  | 'unavailable'
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'unresponsive'
  | 'error'
  | 'stopping';

export interface ProjectIndexServerClientHealth {
  status: 'healthy' | 'degraded' | 'unresponsive';
  checkedAt: number;
  lastHealthyAt: number | null;
  latencyMs: number | null;
  missedHeartbeats: number;
  server?: ProjectIndexServerHealth | undefined;
}

export interface ProjectIndexServerConnectionState {
  status: ProjectIndexServerConnectionStatus;
  connected: boolean;
  projectRoot?: string | undefined;
  indexDir?: string | undefined;
  endpoint?: string | undefined;
  pid?: number | undefined;
  lastError?: string | undefined;
  activity?: ProjectIndexServerActivity | undefined;
  health?: ProjectIndexServerClientHealth | undefined;
}

type ProjectIndexServerConnectionListener = (state: ProjectIndexServerConnectionState) => void;

const connectionStates = new Map<string, ProjectIndexServerConnectionState>();
const connectionStateListeners = new Set<ProjectIndexServerConnectionListener>();
let latestConnectionState: ProjectIndexServerConnectionState = {
  status: 'offline',
  connected: false,
};

/**
 * Why the index daemon is or is not usable.
 *
 * A bare `null` cannot distinguish "the operator asked for in-process mode"
 * from "the built server is missing", so callers that degrade on `null` treat a
 * broken build as a supported mode. For the index that means every process
 * quietly builds its own FTS5 database instead of sharing the project's one
 * owner — same data, N copies, none of them authoritative.
 */
export type ProjectIndexDaemonAvailability =
  | { readonly kind: 'available'; readonly url: URL }
  /** `WRONGSTACK_INDEX_INLINE` / `WRONGSTACK_INDEX_SERVER=0` was set. */
  | { readonly kind: 'inline-requested' }
  /** No server entry point exists in any known output layout. */
  | { readonly kind: 'missing-build' }
  /**
   * The derived socket path cannot be bound on this platform (over the
   * `sun_path` byte limit — seen on macOS whose per-user TMPDIR is ~48 bytes).
   * A daemon spawned onto this endpoint dies silently (`stdio: 'ignore'`), so
   * callers must degrade explicitly instead of entering the connect loop.
   */
  | {
      readonly kind: 'endpoint-invalid';
      readonly endpoint: string;
      readonly byteLength: number;
      readonly maxBytes: number;
    };

export function resolveProjectIndexDaemonAvailability(
  projectRoot?: string,
  indexDir?: string,
): ProjectIndexDaemonAvailability {
  if (process.env['WRONGSTACK_INDEX_INLINE'] || process.env['WRONGSTACK_INDEX_SERVER'] === '0') {
    return { kind: 'inline-requested' };
  }
  let builtUrl: URL | null = null;
  for (const rel of ['./project-server.js', './codebase-index/project-server.js']) {
    try {
      const url = new URL(rel, import.meta.url);
      if (url.protocol === 'file:' && fs.existsSync(fileURLToPath(url))) {
        builtUrl = url;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (builtUrl === null) return { kind: 'missing-build' };
  // Validate the endpoint OUTSIDE the build-probing try/catch. A throw here
  // (today: never; tomorrow: `assertUnixSocketPathWithinLimit` or a future
  // platform guard) must surface as a real availability kind, not be silently
  // swallowed and misreported as `missing-build`. Callers rely on the
  // `endpoint-invalid` branch to reject loudly instead of falling through to
  // an in-process index that would silently strip every connected client of
  // the shared per-project daemon.
  if (projectRoot !== undefined) {
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
    const check = checkUnixSocketPath(endpoint);
    if (!check.ok) {
      return {
        kind: 'endpoint-invalid',
        endpoint,
        byteLength: check.byteLength,
        maxBytes: check.maxBytes,
      };
    }
  }
  return { kind: 'available', url: builtUrl };
}

function resolveProjectServerUrl(): URL | null {
  const availability = resolveProjectIndexDaemonAvailability();
  return availability.kind === 'available' ? availability.url : null;
}

export function projectIndexServerExpectedBuildId(): string | null {
  const override = process.env['WRONGSTACK_INDEX_SERVER_BUILD_ID']?.trim();
  if (override) return override;
  const url = resolveProjectServerUrl();
  return url ? projectIndexServerBuildId(url) : null;
}

export function isProjectIndexServerAvailable(): boolean {
  return resolveProjectServerUrl() !== null;
}

function publishConnectionState(endpoint: string, state: ProjectIndexServerConnectionState): void {
  connectionStates.set(endpoint, state);
  latestConnectionState = state;
  for (const listener of connectionStateListeners) listener(state);
}

export function getProjectIndexServerConnectionState(
  projectRoot?: string,
  indexDir?: string,
): ProjectIndexServerConnectionState {
  if (projectRoot) {
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
    const existing = connectionStates.get(endpoint);
    if (existing) return existing;
    if (!isProjectIndexServerAvailable()) {
      return { status: 'unavailable', connected: false };
    }
    return {
      status: 'offline',
      connected: false,
      projectRoot,
      indexDir,
      endpoint,
    };
  }
  if (latestConnectionState.endpoint) return latestConnectionState;
  if (!isProjectIndexServerAvailable()) return { status: 'unavailable', connected: false };
  return latestConnectionState;
}

export function onProjectIndexServerConnectionStateChange(
  listener: ProjectIndexServerConnectionListener,
): () => void {
  connectionStateListeners.add(listener);
  return () => connectionStateListeners.delete(listener);
}

function remoteError(message: string, name?: string): Error {
  if (name === 'LockError') return new LockError(message);
  if (name === 'IndexTimeoutError') return new IndexTimeoutError(message);
  const error = new Error(message);
  if (name && name !== 'Error') error.name = name;
  return error;
}

function isProjectIndexServerHealth(value: unknown): value is ProjectIndexServerHealth {
  if (!value || typeof value !== 'object') return false;
  const health = value as Partial<ProjectIndexServerHealth>;
  const memory =
    health.memory && typeof health.memory === 'object'
      ? (health.memory as Partial<ProjectIndexServerHealth['memory']>)
      : undefined;
  const activity =
    health.activity && typeof health.activity === 'object'
      ? (health.activity as Partial<ProjectIndexServerActivity>)
      : undefined;
  return (
    typeof health.checkedAt === 'number' &&
    typeof health.uptimeMs === 'number' &&
    typeof memory?.rss === 'number' &&
    typeof memory.heapUsed === 'number' &&
    typeof memory.heapTotal === 'number' &&
    typeof memory.external === 'number' &&
    typeof health.clients === 'number' &&
    typeof health.activeRequests === 'number' &&
    typeof health.activeWrites === 'number' &&
    typeof health.queuedWrites === 'number' &&
    typeof health.pendingExternalFiles === 'number' &&
    typeof health.watchingExternal === 'boolean' &&
    typeof activity?.indexing === 'boolean' &&
    typeof activity.currentFile === 'number' &&
    typeof activity.totalFiles === 'number' &&
    typeof activity.generation === 'number'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Indexing cancelled');
}

class ProjectServerConnection {
  private socket: net.Socket | null = null;
  private buffer = '';
  /** P6: binary frame buffer — accumulates raw bytes when in binary mode. */
  private binaryBuffer: Buffer[] = [];
  /** P6: StringDecoder for safe UTF-8 multibyte handling in JSON mode. */
  private textDecoder: StringDecoder | null = null;
  /** P6: true once the server advertises binary support and client accepts. */
  private useBinary = false;
  private info: ProjectIndexServerInfo | null = null;
  private activity: ProjectIndexServerActivity | null = null;
  private health: ProjectIndexServerClientHealth | null = null;
  private healthCheck: Promise<ProjectIndexServerClientHealth> | null = null;
  private connecting: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: unknown) => void) | null = null;
  private nextId = 1;
  /** WS-027: read from the owner-only metadata file — see currentAuthToken. */
  private authToken: string | undefined;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    readonly projectRoot: string,
    readonly indexDir: string | undefined,
    readonly endpoint: string,
  ) {
    this.transition('offline');
  }

  private transition(
    status: ProjectIndexServerConnectionStatus,
    options: { pid?: number | undefined; error?: unknown } = {},
  ): void {
    const previous = connectionStates.get(this.endpoint);
    const pid = options.pid ?? (status === 'connected' ? this.info?.pid : undefined);
    const lastError =
      options.error === undefined
        ? status === 'error' || status === 'degraded' || status === 'unresponsive'
          ? previous?.lastError
          : undefined
        : options.error instanceof Error
          ? options.error.message
          : String(options.error);
    publishConnectionState(this.endpoint, {
      status,
      connected: status === 'connected' || status === 'degraded' || status === 'unresponsive',
      projectRoot: this.projectRoot,
      indexDir: this.indexDir,
      endpoint: this.endpoint,
      pid,
      lastError,
      ...(this.activity ? { activity: this.activity } : {}),
      ...(this.health ? { health: this.health } : {}),
    });
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.info !== null;
  }

  /** Safe LRU candidate: no request, connect, or health probe is in flight. */
  isEvictable(): boolean {
    return this.pending.size === 0 && this.connecting === null && this.healthCheck === null;
  }

  async checkHealth(
    spawnIfMissing = false,
    timeoutMs = SERVER_HEALTH_TIMEOUT_MS,
  ): Promise<ProjectIndexServerClientHealth> {
    await this.ensureConnected(spawnIfMissing);
    if (this.healthCheck) return this.healthCheck;
    const startedAt = Date.now();
    this.healthCheck = this.request<ProjectIndexServerHealth>({ type: 'ping' }, { timeoutMs })
      .then((server) => {
        const now = Date.now();
        this.health = {
          status: 'healthy',
          checkedAt: now,
          lastHealthyAt: now,
          latencyMs: Math.max(0, now - startedAt),
          missedHeartbeats: 0,
          ...(isProjectIndexServerHealth(server) ? { server } : {}),
        };
        this.transition('connected', { pid: this.info?.pid });
        return this.health;
      })
      .catch((error) => {
        if (!this.isConnected()) throw error;
        if ((this.health?.lastHealthyAt ?? 0) > startedAt) return this.health!;
        const missedHeartbeats = (this.health?.missedHeartbeats ?? 0) + 1;
        const status = missedHeartbeats >= 3 ? 'unresponsive' : 'degraded';
        this.health = {
          status,
          checkedAt: Date.now(),
          lastHealthyAt: this.health?.lastHealthyAt ?? null,
          latencyMs: null,
          missedHeartbeats,
          ...(this.health?.server ? { server: this.health.server } : {}),
        };
        this.transition(status, { pid: this.info?.pid, error });
        return this.health;
      })
      .finally(() => {
        this.healthCheck = null;
      });
    return this.healthCheck;
  }

  private markResponsive(): void {
    const now = Date.now();
    this.health = {
      status: 'healthy',
      checkedAt: now,
      lastHealthyAt: now,
      latencyMs: this.health?.latencyMs ?? null,
      missedHeartbeats: 0,
      ...(this.health?.server ? { server: this.health.server } : {}),
    };
  }

  async call<O extends OpName>(
    op: O,
    args: OpShapes[O]['args'],
    options: ProjectServerCallOptions,
  ): Promise<OpShapes[O]['result']> {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    await this.ensureConnected(true);
    // Connection establishment can take up to ten seconds while electing and
    // spawning a server. Do not enqueue work after the caller cancelled during
    // that interval.
    if (options.signal?.aborted) throw cancellationError(options.signal);
    return this.request<OpShapes[O]['result']>({ type: 'request', op, args }, options);
  }

  async shutdownRemote(reason?: string): Promise<ProjectIndexServerShutdownResult> {
    try {
      await this.ensureConnected(false);
    } catch {
      return { stopped: false, reason: 'not-running' };
    }
    const pid = this.info?.pid;
    try {
      this.transition('stopping', { pid });
      await this.request<{ stopping: boolean }>(
        { type: 'shutdown', reason },
        { timeoutMs: SERVER_CONTROL_TIMEOUT_MS },
      );
      return { stopped: true, pid };
    } catch (error) {
      const forceKilled = this.forceKillKnownServer();
      return {
        stopped: forceKilled,
        pid,
        reason: forceKilled
          ? `force-killed after graceful shutdown failed: ${error instanceof Error ? error.message : String(error)}`
          : error instanceof Error
            ? error.message
            : String(error),
      };
    } finally {
      this.close();
    }
  }

  async configure(watchExternal: boolean, debounceMs: number): Promise<void> {
    await this.ensureConnected(true);
    const startedAt = Date.now();
    const result = await this.request<{ watching: boolean; health?: unknown }>(
      { type: 'configure', watchExternal, debounceMs },
      { timeoutMs: SERVER_CONTROL_TIMEOUT_MS },
    );
    if (isProjectIndexServerHealth(result.health)) {
      const now = Date.now();
      this.health = {
        status: 'healthy',
        checkedAt: now,
        lastHealthyAt: now,
        latencyMs: Math.max(0, now - startedAt),
        missedHeartbeats: 0,
        server: result.health,
      };
      this.transition('connected', { pid: this.info?.pid });
    }
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.info = null;
    this.activity = null;
    this.health = null;
    this.useBinary = false;
    this.binaryBuffer = [];
    this.connectReject?.(new Error('codebase-index client disconnected'));
    this.connectResolve = null;
    this.connectReject = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectPending(new Error('codebase-index client disconnected'));
    this.transition('offline');
    maybeStopHeartbeatLoop();
  }

  /**
   * WS-027: the per-process token, read from the daemon's owner-only metadata
   * file — never from the `hello` frame, which the daemon sends to every
   * socket that connects (the mistake WS-028 found in the SAGE daemon).
   *
   * Read lazily and re-read while unknown: the daemon starts listening before
   * it writes metadata (endpoint ownership has to be won first), and a
   * respawned daemon mints a new token, so a cached wrong one would be sticky.
   */
  private currentAuthToken(): string | undefined {
    if (this.authToken === undefined) {
      try {
        const raw = fs.readFileSync(
          projectIndexServerMetadataPath(this.projectRoot, this.indexDir),
          'utf8',
        );
        const parsed = JSON.parse(raw) as { authToken?: unknown };
        if (typeof parsed.authToken === 'string' && parsed.authToken.length > 0) {
          this.authToken = parsed.authToken;
        }
      } catch {
        // Left undefined; the daemon answers with a clear
        // `UnauthorizedIndexRequest`, which beats a connect that silently
        // succeeds and then fails every call.
      }
    }
    return this.authToken;
  }

  private request<T>(
    message:
      | { type: 'request'; op: OpName; args: OpShapes[OpName]['args'] }
      | {
          type: 'shutdown';
          reason?: string | undefined;
        }
      | { type: 'configure'; watchExternal: boolean; debounceMs: number }
      | { type: 'ping' },
    options: ProjectServerCallOptions,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('codebase-index server connection is not available'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        this.write({ type: 'cancel', id });
        const error = new IndexTimeoutError(
          `Index ${message.type === 'request' ? message.op : message.type} exceeded its ${options.timeoutMs}ms watchdog timeout`,
        );
        this.cleanupPending(entry);
        entry.reject(error);
      }, options.timeoutMs);
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
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        signal,
        onAbort,
        onProgress: options.onProgress,
      });
      if (signal && onAbort) {
        signal.addEventListener('abort', onAbort, { once: true });
        // AbortSignal does not replay an abort event to listeners attached
        // after it fired. Close the narrow setup race before writing.
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      this.write({ ...message, id, authToken: this.currentAuthToken() });
    });
  }

  private async ensureConnected(spawnIfMissing: boolean): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.info) return;
    if (this.connecting) return this.connecting;
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
    let staleAttempts = 0;
    let lastError: unknown = new Error('codebase-index server unavailable');
    while (Date.now() < deadline) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof StaleProjectIndexServerError) {
          staleAttempts++;
          if (!spawnIfMissing) break;
          if (staleAttempts >= 3) this.forceKillServer(error.pid);
          spawned = false;
          await delay(100);
          continue;
        }
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

  private connectOnce(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    // A respawned daemon mints a new token; a cached one authenticates
    // nothing. Drop it and re-read on first use.
    this.authToken = undefined;
    this.info = null;
    this.activity = null;
    this.health = null;
    this.buffer = '';
    // P6: reset binary mode state on reconnect — the server re-negotiates
    // via the hello frame, so stale binaryBuffer/useBinary from the prior
    // connection must not leak into the new one.
    this.binaryBuffer = [];
    this.useBinary = false;
    this.textDecoder = null;

    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint);
      this.socket = socket;
      // P6: no setEncoding — raw Buffer chunks needed for binary frame support
      const timer = setTimeout(() => {
        reject(new Error('codebase-index server handshake timed out'));
        socket.destroy();
      }, CONNECT_ATTEMPT_TIMEOUT_MS);
      timer.unref?.();

      const finishResolve = () => {
        clearTimeout(timer);
        this.connectResolve = null;
        this.connectReject = null;
        resolve();
      };
      const finishReject = (error: unknown) => {
        clearTimeout(timer);
        this.connectResolve = null;
        this.connectReject = null;
        reject(error);
      };
      this.connectResolve = finishResolve;
      this.connectReject = finishReject;

      socket.on('data', (chunk: Buffer) => this.onData(socket, chunk));
      socket.on('error', (error) => {
        if (!this.info) finishReject(error);
      });
      socket.on('close', () => this.onClose(socket));
    });
  }

  private onData(socket: net.Socket, chunk: Buffer): void {
    if (socket !== this.socket) return;

    // P6: Only parse binary frames when this socket has negotiated binary mode
    // (after seeing binarySupported in the hello frame). Pre-negotiation chunks
    // are always JSON text — a byte 0x57 ('W') is just an ASCII character.
    if (this.useBinary) {
      this.onBinaryData(socket, chunk);
      return;
    }

    // JSON mode: use StringDecoder to safely handle multibyte UTF-8 chars
    // that may be split across chunk boundaries (doc comments, non-ASCII names).
    if (!this.textDecoder) this.textDecoder = new StringDecoder('utf8');
    this.buffer += this.textDecoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        if (this.buffer.length > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
          socket.destroy(new Error('codebase-index server response exceeds the IPC limit'));
        }
        return;
      }
      if (newline > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
        socket.destroy(new Error('codebase-index server response exceeds the IPC limit'));
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: ProjectServerMessage;
      try {
        message = JSON.parse(line) as ProjectServerMessage;
      } catch {
        socket.destroy(new Error('invalid codebase-index server response'));
        return;
      }
      this.onMessage(message);
    }
  }

  /**
   * P6: Parse binary frames from the raw buffer.
   *
   * Each frame is: [1 byte magic 0x57] [4 bytes uint32 BE length] [payload].
   * The magic byte distinguishes binary from JSON — a JSON frame's first byte
   * is `{` (0x7B), so there is no ambiguity even in a mixed-mode buffer.
   */
  private onBinaryData(socket: net.Socket, chunk: Buffer): void {
    this.binaryBuffer.push(chunk);
    const all = Buffer.concat(this.binaryBuffer);
    let offset = 0;

    while (offset + 5 <= all.length) {
      if (!isBinaryFrame(all[offset]!)) {
        // Not a binary frame — could be leftover JSON. Fall back to text path
        // and reset useBinary so subsequent chunks parse as text, not binary.
        this.useBinary = false;
        this.buffer += all.subarray(offset).toString('utf8');
        this.binaryBuffer = [];
        return;
      }
      const frameLen = all.readUInt32BE(offset + 1);
      // P6: Reject implausible frame lengths — a malicious or buggy server
      // could claim a 4 GiB payload and hang the client waiting for it.
      // 256 MB is far above any legitimate IPC response.
      if (frameLen > 256 * 1024 * 1024) {
        socket.destroy();
        this.transition('offline', { error: 'binary frame length exceeds 256MB limit' });
        return;
      }
      const totalLen = 5 + frameLen;
      if (offset + totalLen > all.length) break; // incomplete frame, wait for more data

      const payload = all.subarray(offset + 5, offset + 5 + frameLen);
      try {
        const message = decodeBinaryFrame(payload) as ProjectServerMessage;
        this.onMessage(message);
      } catch {
        socket.destroy(new Error('invalid binary codebase-index server response'));
        return;
      }
      offset += totalLen;
    }

    // Keep the remainder for the next chunk.
    this.binaryBuffer = offset < all.length ? [all.subarray(offset)] : [];
  }

  private onMessage(message: ProjectServerMessage): void {
    if (message.type === 'hello') {
      if (message.protocolVersion !== PROJECT_INDEX_SERVER_PROTOCOL_VERSION) {
        this.rejectStaleServer(
          message,
          `codebase-index protocol mismatch: client=${PROJECT_INDEX_SERVER_PROTOCOL_VERSION}, server=${message.protocolVersion}`,
        );
        return;
      }
      const expectedBuildId = projectIndexServerExpectedBuildId();
      if (expectedBuildId && message.buildId !== expectedBuildId) {
        this.rejectStaleServer(
          message,
          `codebase-index build mismatch: client=${expectedBuildId}, server=${message.buildId ?? 'legacy'}`,
        );
        return;
      }
      this.info = message;
      this.markResponsive();
      // P6: If the server supports binary framing, switch this socket to binary
      // mode. The next write() call sends binary frames; the server detects the
      // magic byte and switches its read path.
      if (message.binarySupported) this.useBinary = true;
      this.transition('connected', { pid: message.pid });
      ensureHeartbeatLoop();
      this.connectResolve?.();
      return;
    }
    if (message.type === 'index-state') {
      this.activity = message.state;
      this.markResponsive();
      this.transition('connected', { pid: this.info?.pid });
      return;
    }

    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.markResponsive();
    const status = connectionStates.get(this.endpoint)?.status;
    if (status === 'degraded' || status === 'unresponsive') {
      this.transition('connected', { pid: this.info?.pid });
    }
    if (message.type === 'progress') {
      entry.onProgress?.(message.current, message.total);
      return;
    }
    this.pending.delete(message.id);
    this.cleanupPending(entry);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(remoteError(message.error, message.errorName));
  }

  private onClose(socket: net.Socket): void {
    if (socket !== this.socket) return;
    const wasConnected = this.info !== null;
    this.socket = null;
    this.info = null;
    this.activity = null;
    this.health = null;
    const error = new Error('codebase-index server connection closed');
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    this.rejectPending(error);
    if (wasConnected) this.transition('error', { error });
    maybeStopHeartbeatLoop();
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
    if (!socket || socket.destroyed) return;
    if (this.useBinary) {
      socket.write(encodeBinaryFrame(message));
    } else {
      socket.write(encodeProjectServerMessage(message));
    }
  }

  private rejectStaleServer(message: ProjectIndexServerInfo, reason: string): void {
    const socket = this.socket;
    if (socket && !socket.destroyed) {
      socket.write(
        encodeProjectServerMessage({
          type: 'shutdown',
          id: 0,
          reason: 'stale-build-replacement',
        }),
      );
      const timer = setTimeout(() => socket.destroy(), 25);
      timer.unref?.();
    }
    this.connectReject?.(new StaleProjectIndexServerError(reason, message.pid));
  }

  private spawnDetachedServer(): void {
    const url = resolveProjectServerUrl();
    if (!url) throw new Error('built codebase-index project server is unavailable');
    // Unix-domain socket files survive an unclean process death. We only reach
    // this branch after a direct connection attempt failed, so an existing
    // path is stale rather than a live server endpoint.
    if (process.platform !== 'win32') {
      try {
        fs.rmSync(this.endpoint, { force: true });
      } catch {
        /* bind/connect race will elect the winner */
      }
    }
    const args = [fileURLToPath(url), '--project-root', this.projectRoot];
    if (this.indexDir) args.push('--index-dir', this.indexDir);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  }

  private forceKillKnownServer(): boolean {
    const pid = this.info?.pid;
    return pid ? this.forceKillServer(pid) : false;
  }

  private forceKillServer(pid: number): boolean {
    if (pid === process.pid) return false;
    try {
      process.kill(pid);
      const metadataPath = projectIndexServerMetadataPath(this.projectRoot, this.indexDir);
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { pid?: number };
        if (metadata.pid === pid) fs.rmSync(metadataPath, { force: true });
      } catch {
        /* absent or already replaced */
      }
      return true;
    } catch {
      return false;
    }
  }
}

const connections = new Map<string, ProjectServerConnection>();
const MAX_CACHED_CONNECTIONS = 8;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function forgetConnection(endpoint: string, connection: ProjectServerConnection): void {
  if (connections.get(endpoint) === connection) connections.delete(endpoint);
  connection.close();
  connectionStates.delete(endpoint);
  if (latestConnectionState.endpoint !== endpoint) return;
  latestConnectionState =
    [...connectionStates.values()].at(-1) ??
    ({
      status: isProjectIndexServerAvailable() ? 'offline' : 'unavailable',
      connected: false,
    } satisfies ProjectIndexServerConnectionState);
}

function trimConnectionCache(protectedConnection: ProjectServerConnection): void {
  if (connections.size <= MAX_CACHED_CONNECTIONS) return;
  for (const [endpoint, connection] of connections) {
    if (connections.size <= MAX_CACHED_CONNECTIONS) break;
    if (connection === protectedConnection || !connection.isEvictable()) continue;
    forgetConnection(endpoint, connection);
  }
}

function ensureHeartbeatLoop(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const connection of connections.values()) {
      if (connection.isConnected()) void connection.checkHealth(false).catch(() => {});
    }
  }, SERVER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

function maybeStopHeartbeatLoop(): void {
  if (!heartbeatTimer) return;
  if ([...connections.values()].some((connection) => connection.isConnected())) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function connectionFor(projectRoot: string, indexDir?: string): ProjectServerConnection {
  const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
  let connection = connections.get(endpoint);
  if (!connection) {
    connection = new ProjectServerConnection(projectRoot, indexDir, endpoint);
    connections.set(endpoint, connection);
  } else {
    connections.delete(endpoint);
    connections.set(endpoint, connection);
  }
  trimConnectionCache(connection);
  return connection;
}

export function callProjectIndexServer<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  options: ProjectServerCallOptions,
): Promise<OpShapes[O]['result']> {
  return connectionFor(args.projectRoot, args.indexDir).call(op, args, options);
}

export function ensureProjectIndexServer(options: {
  projectRoot: string;
  indexDir?: string | undefined;
  watchExternal: boolean;
  debounceMs: number;
}): Promise<void> {
  return connectionFor(options.projectRoot, options.indexDir).configure(
    options.watchExternal,
    options.debounceMs,
  );
}

export function checkProjectIndexServerHealth(
  projectRoot: string,
  indexDir?: string,
  options: { timeoutMs?: number | undefined } = {},
): Promise<ProjectIndexServerClientHealth> {
  return connectionFor(projectRoot, indexDir).checkHealth(
    false,
    options.timeoutMs ?? SERVER_HEALTH_TIMEOUT_MS,
  );
}

export async function shutdownProjectIndexServer(
  projectRoot: string,
  indexDir?: string,
  reason?: string,
): Promise<ProjectIndexServerShutdownResult> {
  const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
  const connection = connectionFor(projectRoot, indexDir);
  try {
    return await connection.shutdownRemote(reason);
  } finally {
    connection.close();
    connections.delete(endpoint);
    connectionStates.delete(endpoint);
  }
}

/** Disconnect this process from every project server without stopping them. */
export function closeProjectIndexServerClients(): void {
  for (const connection of connections.values()) connection.close();
  connections.clear();
  connectionStates.clear();
  latestConnectionState = {
    status: isProjectIndexServerAvailable() ? 'offline' : 'unavailable',
    connected: false,
  };
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}
