/**
 * Kanban Server Client — connect tools to the project server
 *
 * Resolves the project's endpoint, spawns the server detached if absent,
 * sends typed requests, and returns parsed responses. Production is
 * fail-closed: disabling the server never enables direct storage writes.
 *
 * Mirrors `packages/sage/src/project-server-client.ts`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeLifecycleIssues,
  KanbanLifecycleError,
  StaleWriteError,
} from '../manager/lifecycle-error.js';
import { kanbanProjectServerEndpoint } from './endpoint.js';
import {
  KANBAN_PROJECT_SERVER_METADATA_FILE,
  KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
  type KanbanHelloFrame,
  type KanbanRequest,
  type KanbanServerEvent,
  type KanbanServerMethod,
  type KanbanServerOperations,
} from './protocol.js';

const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** How long to keep retrying a connect after spawning a daemon. */
const SPAWN_CONNECT_DEADLINE_MS = 5_000;
const SPAWN_CONNECT_RETRY_MS = 50;
const HEARTBEAT_MS = 10_000;
const MAX_CACHED_CONNECTIONS = 8;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Per-process connection cache keyed by project root. Tools in the same
 * process share the connection — only one net.Socket per project.
 */
const connections = new Map<string, KanbanServerConnection>();

function trimConnectionCache(protectedConnection: KanbanServerConnection): void {
  if (connections.size <= MAX_CACHED_CONNECTIONS) return;
  for (const [cacheKey, connection] of connections) {
    if (connections.size <= MAX_CACHED_CONNECTIONS) break;
    if (connection === protectedConnection || !connection.isEvictable()) continue;
    connections.delete(cacheKey);
    connection.close('evicted from idle client cache');
  }
}

class KanbanServerConnection {
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private helloResolve!: (info: KanbanHelloFrame) => void;
  private helloReject!: (err: Error) => void;
  private helloPromise: Promise<KanbanHelloFrame>;
  private serverProcess: ChildProcess | null = null;
  private eventListeners = new Set<(ev: KanbanServerEvent) => void>();
  private disconnectListeners = new Set<() => void>();
  private destroyed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectPromise: Promise<KanbanHelloFrame> | null = null;
  private authToken: string | undefined;

  constructor(
    public readonly projectRoot: string,
    public readonly endpoint: string,
    private readonly cacheKey: string,
  ) {
    this.helloPromise = new Promise<KanbanHelloFrame>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    // `connectOnce()` hands `helloPromise` to the caller only on the success
    // path. When the connect fails, `connect()` still calls `helloReject` so a
    // late awaiter sees the real error — but on that path nobody has awaited it
    // yet, so the rejection is orphaned and surfaces as an unhandled rejection
    // that takes the whole process (or a test run) down. Attach an inert
    // handler at construction: awaiting `helloPromise` still rejects normally,
    // it just can never be unhandled.
    this.helloPromise.catch(() => undefined);
  }

  async connect(): Promise<KanbanHelloFrame> {
    if (this.destroyed) throw new Error('Connection closed');
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectOnce().catch((error) => {
      this.helloReject(error);
      throw error;
    });
    return this.connectPromise;
  }

  private async connectOnce(): Promise<KanbanHelloFrame> {
    // A restarted daemon mints a new token, so a cached one authenticates
    // nothing. Drop it and re-read on first use.
    this.authToken = undefined;
    await this.tryConnectExisting();
    if (this.socket) return this.helloPromise;
    await this.spawnServer();
    // Retry until a deadline instead of trusting one fixed sleep. Under load a
    // freshly spawned daemon needs longer than 100ms to bind, and a single
    // failed attempt used to bubble up as a connect error that callers answered
    // by spawning yet another daemon.
    const deadline = Date.now() + SPAWN_CONNECT_DEADLINE_MS;
    while (!this.socket && Date.now() < deadline) {
      await this.tryConnectExisting();
      if (this.socket) break;
      await new Promise((r) => setTimeout(r, SPAWN_CONNECT_RETRY_MS));
    }
    if (!this.socket)
      throw new Error(`Failed to connect to kanban project server at ${this.endpoint}`);
    return this.helloPromise;
  }

  private async tryConnectExisting(): Promise<void> {
    if (this.socket) return;
    const sock = net.createConnection(this.endpoint);
    sock.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('connect-timeout'));
      }, CONNECT_TIMEOUT_MS);
      timer.unref?.();
      sock.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    }).catch(() => {
      sock.destroy();
      // Connection refused → no server running; caller will spawn one
    });
    if (sock.destroyed) return;
    this.socket = sock;
    sock.on('data', (chunk: string) => this.onData(chunk));
    sock.on('close', () => this.onClose('disconnected'));
    sock.on('error', () => this.onClose('error'));
  }

  private async spawnServer(): Promise<void> {
    try {
      const url = new URL('./project-server.js', import.meta.url);
      if (url.protocol !== 'file:') return;
      const scriptPath = fileURLToPath(url);
      if (!fs.existsSync(scriptPath)) return;
      const args = [scriptPath, '--project-root', this.projectRoot];
      this.serverProcess = spawn(process.execPath, args, {
        detached: true,
        // 'ignore' rather than 'pipe': piping kept two handles open in THIS
        // process for a daemon we immediately unref, and nothing reads them.
        stdio: 'ignore',
        env: process.env,
        windowsHide: true,
      });
      this.serverProcess.unref?.();
    } catch {
      // In test runners or non-file URL contexts, ignore spawn error gracefully
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Check the cap on append, not inside the frame loop. A peer that never
    // sends a newline never enters the loop, so the in-loop check could not
    // fire and the buffer grew without limit. Matches the correct placement in
    // tools' project-server-client and sage's project-server.
    if (this.buffer.length > MAX_FRAME_CHARS) {
      this.buffer = '';
      this.socket?.destroy(new Error('Frame buffer exceeded maximum size'));
      return;
    }
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; [k: string]: unknown };
        if (parsed.type === 'hello') {
          if (parsed.protocolVersion !== KANBAN_PROJECT_SERVER_PROTOCOL_VERSION) {
            const error = new Error(
              `Kanban protocol mismatch: client=${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}, server=${String(parsed.protocolVersion)}`,
            );
            this.helloReject(error);
            this.socket?.destroy(error);
            return;
          }
          this.helloResolve(parsed as unknown as KanbanHelloFrame);
          this.startHeartbeat();
          continue;
        }
        if (parsed.type === 'event') {
          for (const listener of this.eventListeners) {
            try {
              listener(parsed as unknown as KanbanServerEvent);
            } catch {
              // One bad listener must not break the others — mirrors the
              // disconnect-listener isolation in onClose() and the server-side
              // emitter in event-emitter.ts.
            }
          }
          continue;
        }
        if (typeof parsed.id === 'number') {
          const pending = this.pending.get(parsed.id);
          if (pending) {
            this.pending.delete(parsed.id);
            clearTimeout(pending.timer);
            if ('ok' in parsed) {
              pending.resolve((parsed as { result?: unknown }).result);
            } else {
              const errPayload = (parsed as { error?: { code?: unknown; message?: unknown } })
                .error;
              const message = errPayload?.message;
              const code = errPayload?.code;
              const original = typeof message === 'string' ? message : 'request failed';
              // Reconstruct the typed error across the IPC boundary so callers
              // can recover the structured validation issues instead of the
              // JSON-encoded message they would otherwise have to re-parse.
              const error =
                code === 'LIFECYCLE'
                  ? new KanbanLifecycleError(
                      original,
                      decodeLifecycleIssues({ message: original } as Error),
                    )
                  : // Optimistic-locking retries all read `instanceof
                    // StaleWriteError`. Reconstructing it here means a caller
                    // writes the same check whether the mutation was local or
                    // went through the daemon; `error.code === 'STALE_WRITE'`
                    // keeps working for anything already written that way.
                    code === 'STALE_WRITE'
                    ? new StaleWriteError(original)
                    : new Error(original);
              if (typeof code === 'string') (error as { code?: string }).code = code;
              pending.reject(error);
            }
          }
        }
      } catch {
        // Drop malformed frames silently — server should never emit JSON errors as events
      }
    }
  }

  private onClose(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.socket = null;
    const err = new Error(`Kanban server ${this.endpoint}: ${reason}`);
    this.helloReject(err);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    if (connections.get(this.cacheKey) === this) connections.delete(this.cacheKey);
    for (const listener of this.disconnectListeners) {
      try {
        listener();
      } catch {
        // Connection lifecycle observers are isolated from one another.
      }
    }
    this.disconnectListeners.clear();
    this.eventListeners.clear();
  }

  /**
   * An idle cached connection can be recreated on the next request. Never
   * evict a connection with an in-flight request or a live event subscriber.
   */
  isEvictable(): boolean {
    return (
      this.pending.size === 0 &&
      this.eventListeners.size === 0 &&
      this.disconnectListeners.size === 0
    );
  }

  close(reason = 'client closed'): void {
    if (this.destroyed) return;
    const socket = this.socket;
    this.onClose(reason);
    if (socket && !socket.destroyed) socket.destroy();
    this.buffer = '';
    this.serverProcess = null;
  }

  /**
   * WS-027: the per-process token, read from the daemon's owner-only
   * `server.json` — never from the `hello` frame, which the daemon sends to
   * every socket that connects (the mistake WS-028 found in SAGE).
   *
   * Read lazily and re-read while still unknown: a daemon that idles out and
   * respawns mints a new token, and a cached wrong one would be sticky.
   */
  private currentAuthToken(): string | undefined {
    if (this.authToken === undefined) {
      try {
        const raw = fs.readFileSync(
          path.join(this.projectRoot, '.wrongstack', KANBAN_PROJECT_SERVER_METADATA_FILE),
          'utf8',
        );
        const parsed = JSON.parse(raw) as { authToken?: unknown };
        if (typeof parsed.authToken === 'string' && parsed.authToken.length > 0) {
          this.authToken = parsed.authToken;
        }
      } catch {
        // Left undefined; the daemon answers with a clear UNAUTHORIZED, which
        // beats a connect that silently succeeds and then fails every call.
      }
    }
    return this.authToken;
  }

  async request<M extends KanbanServerMethod>(
    method: M,
    params: KanbanServerOperations[M]['args'],
    opts: { timeoutMs?: number } = {},
  ): Promise<KanbanServerOperations[M]['result']> {
    if (this.destroyed) throw new Error('Connection closed');
    await this.helloPromise;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (result) => resolve(result as KanbanServerOperations[M]['result']),
        reject,
        timer,
      });
      const frame: KanbanRequest<M> = { id, method, params, authToken: this.currentAuthToken() };
      this.socket!.write(JSON.stringify(frame) + '\n');
    });
  }

  subscribe(listener: (ev: KanbanServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Observe terminal socket loss. Event subscribers use this to attach to the
   * replacement project-server connection after daemon restart.
   */
  onDisconnect(listener: () => void): () => void {
    if (this.destroyed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.request('ping', {}).catch(() => {
        this.socket?.destroy();
      });
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }
}

/**
 * Resolve (and lazily spawn) the connection to the kanban project server
 * for the given project root. Returns null only when explicitly disabled;
 * production storage callers treat that as an error rather than falling back.
 */
export async function getKanbanServerConnection(
  projectRoot: string,
): Promise<KanbanServerConnection | null> {
  if (process.env['WRONGSTACK_KANBAN_SERVER'] === '0') return null;
  const cacheKey = canonicalRoot(projectRoot);
  let conn = connections.get(cacheKey);
  if (!conn) {
    const endpoint = kanbanProjectServerEndpoint(projectRoot);
    conn = new KanbanServerConnection(projectRoot, endpoint, cacheKey);
    connections.set(cacheKey, conn);
  } else {
    // Map insertion order is the LRU order.
    connections.delete(cacheKey);
    connections.set(cacheKey, conn);
  }
  try {
    await conn.connect();
  } catch (err) {
    if (connections.get(cacheKey) === conn) connections.delete(cacheKey);
    conn.close('connection failed');
    throw err;
  }
  trimConnectionCache(conn);
  return conn;
}

/** Disconnect this process from every Kanban server without stopping daemons. */
export function closeKanbanServerConnections(): void {
  const cached = [...connections.values()];
  connections.clear();
  for (const connection of cached) connection.close();
}

export async function isKanbanServerAvailable(projectRoot: string): Promise<boolean> {
  if (process.env['WRONGSTACK_KANBAN_SERVER'] === '0') return false;
  const endpoint = kanbanProjectServerEndpoint(projectRoot);
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 500);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export type { KanbanServerEvent, KanbanServerMethod, KanbanServerOperations } from './protocol.js';
export { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from './protocol.js';

function canonicalRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
