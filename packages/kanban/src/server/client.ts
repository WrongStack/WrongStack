/**
 * Kanban Server Client — connect tools to the project server
 *
 * Resolves the project's endpoint, spawns the server detached if absent,
 * sends typed requests, and returns parsed responses. Falls back to the
 * direct file-backed storage functions if `WRONGSTACK_KANBAN_SERVER=0`.
 *
 * Mirrors `packages/sage/src/project-server-client.ts`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as net from 'node:net';

import {
  type KanbanRequest,
  type KanbanResponse,
  type KanbanHelloFrame,
  type KanbanServerMethod,
  type KanbanServerOperations,
  type KanbanServerEvent,
} from './protocol.js';
import { kanbanProjectServerEndpoint } from './project-server.js';

const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** How long to keep retrying a connect after spawning a daemon. */
const SPAWN_CONNECT_DEADLINE_MS = 5_000;
const SPAWN_CONNECT_RETRY_MS = 50;

interface PendingRequest {
  resolve: (r: KanbanResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Per-process connection cache keyed by project root. Tools in the same
 * process share the connection — only one net.Socket per project.
 */
const connections = new Map<string, KanbanServerConnection>();

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
  private destroyed = false;

  constructor(public readonly projectRoot: string, public readonly endpoint: string) {
    this.helloPromise = new Promise<KanbanHelloFrame>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
  }

  async connect(): Promise<KanbanHelloFrame> {
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
    if (!this.socket) throw new Error(`Failed to connect to kanban project server at ${this.endpoint}`);
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
    const url = new URL('./project-server.js', import.meta.url);
    const args = [fileURLToPath(url), '--project-root', this.projectRoot];
    this.serverProcess = spawn(process.execPath, args, {
      detached: true,
      // 'ignore' rather than 'pipe': piping kept two handles open in THIS
      // process for a daemon we immediately unref, and nothing reads them.
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    this.serverProcess.unref?.();
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
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; [k: string]: unknown };
        if (parsed.type === 'hello') {
          this.helloResolve(parsed as unknown as KanbanHelloFrame);
          return;
        }
        if (parsed.type === 'event') {
          for (const listener of this.eventListeners) listener(parsed as unknown as KanbanServerEvent);
          return;
        }
        if (typeof parsed.id === 'number') {
          const pending = this.pending.get(parsed.id);
          if (pending) {
            this.pending.delete(parsed.id);
            clearTimeout(pending.timer);
            if ('ok' in parsed) pending.resolve(parsed as unknown as KanbanResponse);
            else pending.reject(new Error((parsed as any).error?.message ?? 'request failed'));
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
    this.socket = null;
    const err = new Error(`Kanban server ${this.endpoint}: ${reason}`);
    this.helloReject(err);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    connections.delete(this.projectRoot);
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
      this.pending.set(id, { resolve: resolve as any, reject, timer });
      const frame: KanbanRequest<M> = { id, method, params };
      this.socket!.write(JSON.stringify(frame) + '\n');
    });
  }

  subscribe(listener: (ev: KanbanServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
}

/**
 * Resolve (and lazily spawn) the connection to the kanban project server
 * for the given project root. Returns null if the server is disabled via
 * `WRONGSTACK_KANBAN_SERVER=0`.
 */
export async function getKanbanServerConnection(projectRoot: string): Promise<KanbanServerConnection | null> {
  if (process.env['WRONGSTACK_KANBAN_SERVER'] === '0') return null;
  let conn = connections.get(projectRoot);
  if (!conn) {
    const endpoint = kanbanProjectServerEndpoint(projectRoot);
    conn = new KanbanServerConnection(projectRoot, endpoint);
    connections.set(projectRoot, conn);
    try {
      await conn.connect();
    } catch (err) {
      connections.delete(projectRoot);
      throw err;
    }
  }
  return conn;
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

export { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from './protocol.js';
export type { KanbanServerMethod, KanbanServerOperations, KanbanServerEvent } from './protocol.js';