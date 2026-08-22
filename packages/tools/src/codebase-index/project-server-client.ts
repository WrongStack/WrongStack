import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  isBinaryFrame,
  MAX_BINARY_FRAME_BYTES,
} from './binary-frame.js';
import { IndexTimeoutError } from './circuit-breaker.js';
import {
  CONNECT_ATTEMPT_TIMEOUT_MS,
  cancellationError,
  connectionStates,
  delay,
  getProjectIndexServerConnectionState,
  isProjectIndexServerAvailable,
  isProjectIndexServerHealth,
  latestConnectionState,
  onProjectIndexServerConnectionStateChange,
  type PendingRequest,
  type ProjectIndexDaemonAvailability,
  type ProjectIndexServerClientHealth,
  type ProjectIndexServerConnectionState,
  type ProjectIndexServerConnectionStatus,
  type ProjectIndexServerShutdownResult,
  type ProjectServerCallOptions,
  projectIndexServerExpectedBuildId,
  publishConnectionState,
  remoteError,
  resolveProjectIndexDaemonAvailability,
  resolveProjectServerUrl,
  SERVER_CONTROL_TIMEOUT_MS,
  SERVER_HEALTH_TIMEOUT_MS,
  SERVER_HEARTBEAT_INTERVAL_MS,
  SERVER_START_TIMEOUT_MS,
  StaleProjectIndexServerError,
  setLatestConnectionState,
} from './project-server-client-state.js';
import {
  PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
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

export {
  getProjectIndexServerConnectionState,
  isProjectIndexServerAvailable,
  onProjectIndexServerConnectionStateChange,
  type ProjectIndexDaemonAvailability,
  type ProjectIndexServerClientHealth,
  type ProjectIndexServerConnectionState,
  type ProjectIndexServerConnectionStatus,
  type ProjectIndexServerShutdownResult,
  type ProjectServerCallOptions,
  projectIndexServerExpectedBuildId,
  resolveProjectIndexDaemonAvailability,
};

class ProjectServerConnection {
  private socket: net.Socket | null = null;
  /**
   * Raw inbound bytes for the unified per-frame reader. Frames are sniffed
   * individually — JSON text (newline-terminated) or binary (magic 0x57) —
   * instead of latching a read mode, so a JSON broadcast between binary
   * frames cannot desynchronize the reader.
   */
  private readBuffer: Buffer = Buffer.alloc(0);
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

  async configure(
    watchExternal: boolean,
    debounceMs: number,
    coalesceWindowMs?: number,
  ): Promise<void> {
    await this.ensureConnected(true);
    const startedAt = Date.now();
    const result = await this.request<{ watching: boolean; health?: unknown }>(
      { type: 'configure', watchExternal, debounceMs, coalesceWindowMs },
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
    this.readBuffer = Buffer.alloc(0);
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
      | {
          type: 'configure';
          watchExternal: boolean;
          debounceMs: number;
          coalesceWindowMs?: number | undefined;
        }
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
    // Reset frame state on reconnect — the server re-negotiates via the
    // hello frame, so stale useBinary/readBuffer from the prior connection
    // must not leak into the new one.
    this.readBuffer = Buffer.alloc(0);
    this.useBinary = false;

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

  /**
   * Unified per-frame reader. Each frame is sniffed by its first byte:
   * `0x57` ('W') → length-prefixed MessagePack binary, anything else →
   * newline-delimited JSON text. Sniffing per frame (instead of latching a
   * mode) is what makes mixed streams work: the server may interleave a JSON
   * `index-state` broadcast between binary responses, and an old JSON-only
   * server stays readable while `useBinary` is armed.
   *
   * Multibyte UTF-8 in JSON frames is safe: raw `0x0a` only occurs as the
   * JSON delimiter (inside JSON strings `\n` is escaped), so a complete line
   * is always complete UTF-8.
   */
  private onData(socket: net.Socket, chunk: Buffer): void {
    if (socket !== this.socket) return;
    this.readBuffer =
      this.readBuffer.length === 0 ? chunk : Buffer.concat([this.readBuffer, chunk]);
    while (true) {
      if (this.readBuffer.length === 0) return;
      if (this.useBinary && isBinaryFrame(this.readBuffer[0]!)) {
        if (this.readBuffer.length < 5) return; // header not fully received yet
        const frameLen = this.readBuffer.readUInt32BE(1);
        // Reject implausible frame lengths — a malicious or buggy server
        // could claim a 4 GiB payload and hang the client waiting for it.
        if (frameLen > MAX_BINARY_FRAME_BYTES) {
          socket.destroy();
          this.transition('offline', { error: 'binary frame length exceeds the IPC limit' });
          return;
        }
        if (this.readBuffer.length < 5 + frameLen) return; // payload incomplete
        const payload = this.readBuffer.subarray(5, 5 + frameLen);
        this.readBuffer = this.readBuffer.subarray(5 + frameLen);
        let message: ProjectServerMessage;
        try {
          message = decodeBinaryFrame(payload) as ProjectServerMessage;
        } catch {
          socket.destroy(new Error('invalid binary codebase-index server response'));
          return;
        }
        this.onMessage(message);
        continue;
      }
      const newline = this.readBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.readBuffer.length > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
          socket.destroy(new Error('codebase-index server response exceeds the IPC limit'));
        }
        return;
      }
      if (newline > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
        socket.destroy(new Error('codebase-index server response exceeds the IPC limit'));
        return;
      }
      const line = this.readBuffer.subarray(0, newline).toString('utf8');
      this.readBuffer = this.readBuffer.subarray(newline + 1);
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
      // P6: binary framing is opt-in (WRONGSTACK_INDEX_BINARY=1). The server
      // advertises the capability, but benchmarks (2026-08, Windows named
      // pipe, 100-result search) show MessagePack round-trips ~1.9× slower
      // than NDJSON — V8's native JSON beats the pure-JS msgpack codec — for
      // only 8.3% wire savings. Default traffic stays NDJSON; the env var
      // flips this socket to binary on the next write.
      if (message.binarySupported && binaryFramingEnabled()) this.useBinary = true;
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

/**
 * Binary IPC framing is opt-in: `WRONGSTACK_INDEX_BINARY=1` makes the client
 * adopt MessagePack frames when the server advertises `binarySupported`.
 * Default is NDJSON — see the hello handler for the benchmark rationale.
 */
function binaryFramingEnabled(): boolean {
  const flag = process.env['WRONGSTACK_INDEX_BINARY'];
  return flag === '1' || flag === 'true';
}

function forgetConnection(endpoint: string, connection: ProjectServerConnection): void {
  if (connections.get(endpoint) === connection) connections.delete(endpoint);
  connection.close();
  connectionStates.delete(endpoint);
  if (latestConnectionState.endpoint !== endpoint) return;
  setLatestConnectionState(
    [...connectionStates.values()].at(-1) ??
      ({
        status: isProjectIndexServerAvailable() ? 'offline' : 'unavailable',
        connected: false,
      } satisfies ProjectIndexServerConnectionState),
  );
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
  coalesceWindowMs?: number | undefined;
}): Promise<void> {
  return connectionFor(options.projectRoot, options.indexDir).configure(
    options.watchExternal,
    options.debounceMs,
    options.coalesceWindowMs,
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
  setLatestConnectionState({
    status: isProjectIndexServerAvailable() ? 'offline' : 'unavailable',
    connected: false,
  });
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}
