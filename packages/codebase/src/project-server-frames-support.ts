import * as fs from 'node:fs';
import * as net from 'node:net';
import { retryWhileUnauthorized } from '@wrongstack/persistence';
import { encodeBinaryFrame } from './binary-frame.js';
import { IndexTimeoutError } from './circuit-breaker.js';
import { recordIpcPending } from './perf-metrics.js';
import {
  CONNECT_ATTEMPT_TIMEOUT_MS,
  cancellationError,
  connectionStates,
  delay,
  isProjectIndexServerAvailable,
  isProjectIndexServerHealth,
  type PendingRequest,
  type ProjectIndexServerClientHealth,
  type ProjectIndexServerConnectionStatus,
  type ProjectIndexServerShutdownResult,
  type ProjectServerCallOptions,
  publishConnectionState,
  SERVER_CONTROL_TIMEOUT_MS,
  SERVER_HEALTH_TIMEOUT_MS,
  SERVER_HEARTBEAT_INTERVAL_MS,
  SERVER_START_TIMEOUT_MS,
  StaleProjectIndexServerError,
  setLatestConnectionState,
} from './project-server-client-state.js';
import {
  formatProjectIndexServerCloseError,
  projectIndexServerMetadataPath,
  projectIndexServerStderrPath,
  readProjectIndexServerStderrTail,
} from './project-server-endpoint.js';
import type { ProjectServerFramesHost } from './project-server-frames.js';
import {
  onData as onDataFromHost,
  onMessage as onMessageFromHost,
} from './project-server-frames.js';
import {
  forceKillKnownServer as delegateForceKillKnownServer,
  forceKillServer as delegateForceKillServer,
  spawnDetachedServer as delegateSpawnDetachedServer,
  type ProjectServerLaunchHost,
} from './project-server-launch.js';
import {
  encodeProjectServerMessage,
  type ProjectIndexServerActivity,
  type ProjectIndexServerHealth,
  type ProjectIndexServerInfo,
  type ProjectServerMessage,
} from './project-server-protocol.js';
import type { OpName, OpShapes } from './worker-protocol.js';

/**
 * Minimum spacing between detached-server spawn attempts inside one
 * `connectWithElection` window. The first spawn still fires immediately;
 * re-arming is cadence-bounded so a dead first daemon is recovered without
 * flooding the machine with losing candidates (the endpoint bind plus the
 * buildId handshake IS the election, so an extra spawn that cannot win exits
 * without side effects). Mirrors the mailbox/SAGE clients' fix for the same
 * single-shot-spawn defect.
 */
export const SPAWN_RETRY_CADENCE_MS = 750;

export class ProjectServerConnection {
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
  /** The module heartbeat loop, exposed to the frame reader through its host. */
  private readonly ensureHeartbeatLoop = ensureHeartbeatLoop;

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
    return retryWhileUnauthorized(
      () => this.request<OpShapes[O]['result']>({ type: 'request', op, args }, options),
      (error) =>
        error instanceof Error &&
        error.name === 'UnauthorizedIndexRequest' &&
        !options.signal?.aborted,
    );
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
      recordIpcPending(this.pending.size);
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
    let lastSpawnAt = 0;
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
          // A stale build is known-dead: force an immediate re-spawn on the
          // next tick instead of waiting out the cadence.
          lastSpawnAt = 0;
          await delay(100);
          continue;
        }
      }
      if (!spawnIfMissing) break;
      const now = Date.now();
      if (now - lastSpawnAt >= SPAWN_RETRY_CADENCE_MS) {
        // A synchronous throw from the spawn path — the resolver transiently
        // failing to stat the dist entrypoint under load — must not unwind
        // the whole retry window (mailbox sibling flake, observed 2026-09-15).
        // Degrade to "this tick spawned nothing"; lastSpawnAt stays unset so
        // the next tick retries immediately. Cadence-bounded re-arming also
        // recovers a dead first daemon, which the old single-shot `spawned`
        // flag made fatal.
        try {
          this.spawnDetachedServer();
          lastSpawnAt = now;
        } catch {
          // Resolution failures are retryable by the loop below.
        }
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
    onDataFromHost.call(this.projectServerFramesHost(), socket, chunk);
  }

  private onMessage(message: ProjectServerMessage): void {
    onMessageFromHost.call(this.projectServerFramesHost(), message);
  }

  /**
   * Why the connection closed, as far as the daemon left evidence.
   *
   * A closed socket has two very different causes — an orderly shutdown, and
   * the daemon dying — and they were reported identically. If the daemon
   * wrote anything to stderr, that text is the difference between a failure
   * someone can act on and one that reads as a flake.
   */
  private closeReason(): string {
    return formatProjectIndexServerCloseError(
      readProjectIndexServerStderrTail(
        projectIndexServerStderrPath(this.projectRoot, this.indexDir),
      ),
    );
  }

  private onClose(socket: net.Socket): void {
    if (socket !== this.socket) return;
    const wasConnected = this.info !== null;
    this.socket = null;
    this.info = null;
    this.activity = null;
    this.health = null;
    const error = new Error(this.closeReason());
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
    delegateSpawnDetachedServer(this.projectServerLaunchHost());
  }

  private forceKillKnownServer(): boolean {
    return delegateForceKillKnownServer(this.projectServerLaunchHost());
  }

  private forceKillServer(pid: number): boolean {
    return delegateForceKillServer(this.projectServerLaunchHost(), pid);
  }

  private projectServerLaunchHost(): ProjectServerLaunchHost {
    const self = this;
    return {
      get endpoint() {
        return self.endpoint;
      },
      get projectRoot() {
        return self.projectRoot;
      },
      get indexDir() {
        return self.indexDir;
      },
      get info() {
        return self.info;
      },
      forceKillServer: (...args) => this.forceKillServer(...args),
    };
  }

  private projectServerFramesHost(): ProjectServerFramesHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      ensureHeartbeatLoop: this.ensureHeartbeatLoop,
      socket: this.socket,
      readBuffer: this.readBuffer,
      useBinary: this.useBinary,
      transition: this.transition,
      onMessage: this.onMessage,
      rejectStaleServer: this.rejectStaleServer,
      info: this.info,
      markResponsive: this.markResponsive,
      connectResolve: this.connectResolve,
      activity: this.activity,
      pending: this.pending,
      endpoint: this.endpoint,
      cleanupPending: this.cleanupPending,
      authToken: this.authToken,
    } satisfies ProjectServerFramesHost);
    return this as unknown as ProjectServerFramesHost;
  }
}

export const connections = new Map<string, ProjectServerConnection>();

export let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

export function ensureHeartbeatLoop(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const connection of connections.values()) {
      if (connection.isConnected()) void connection.checkHealth(false).catch(() => {});
    }
  }, SERVER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

export function maybeStopHeartbeatLoop(): void {
  if (!heartbeatTimer) return;
  if ([...connections.values()].some((connection) => connection.isConnected())) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
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
