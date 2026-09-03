import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from './endpoint.js';
import {
  encodeSessionCatalogMessage,
  SESSION_CATALOG_MAX_FRAME_CHARS,
  SESSION_CATALOG_PROTOCOL_VERSION,
  type SessionCatalogEvent,
  type SessionCatalogOperationName,
  type SessionCatalogOperations,
  type SessionCatalogServerInfo,
  type SessionCatalogServerMessage,
} from './protocol.js';

const CONNECT_TIMEOUT_MS = 750;
const START_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_PENDING_REQUESTS = 1_024;
const MAX_EVENT_LISTENERS = 64;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SessionCatalogProjectClientOptions {
  projectDir: string;
  projectRoot: string;
}

export type SessionCatalogDaemonAvailability =
  | { kind: 'available'; url: URL }
  | { kind: 'inline-requested' }
  | { kind: 'missing-build' };

function locateServer(moduleUrl: string, exists: (filePath: string) => boolean): URL | null {
  for (const candidate of [
    './project-server.js',
    '../session-catalog/project-server.js',
    './session-catalog/project-server.js',
    '../../dist/session-catalog/project-server.js',
  ]) {
    try {
      const url = new URL(candidate, moduleUrl);
      if (url.protocol === 'file:' && exists(fileURLToPath(url))) return url;
    } catch {
      /* next layout */
    }
  }
  return null;
}

export function resolveSessionCatalogDaemonAvailability(
  moduleUrl = import.meta.url,
  exists: (filePath: string) => boolean = fs.existsSync,
): SessionCatalogDaemonAvailability {
  if (
    process.env['WRONGSTACK_SESSION_CATALOG_INLINE'] ||
    process.env['WRONGSTACK_SESSION_CATALOG_SERVER'] === '0'
  )
    return { kind: 'inline-requested' };
  const url = locateServer(moduleUrl, exists);
  return url ? { kind: 'available', url } : { kind: 'missing-build' };
}

export function resolveSessionCatalogProjectServerUrl(
  moduleUrl = import.meta.url,
  exists: (filePath: string) => boolean = fs.existsSync,
): URL | null {
  const availability = resolveSessionCatalogDaemonAvailability(moduleUrl, exists);
  return availability.kind === 'available' ? availability.url : null;
}

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SessionCatalogProjectClient {
  readonly endpoint: string;
  private socket: net.Socket | null = null;
  private info: SessionCatalogServerInfo | null = null;
  private buffer = '';
  private connecting: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: unknown) => void) | null = null;
  private authToken: string | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(event: SessionCatalogEvent) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private explicitlyClosed = false;

  constructor(readonly options: SessionCatalogProjectClientOptions) {
    this.endpoint = sessionCatalogProjectServerEndpoint(options.projectDir);
  }

  async call<O extends SessionCatalogOperationName>(
    op: O,
    args: SessionCatalogOperations[O]['args'],
    options: { timeoutMs?: number } = {},
  ): Promise<SessionCatalogOperations[O]['result']> {
    await this.ensureConnected(true);
    return this.request({ type: 'request', op, args }, options.timeoutMs ?? CALL_TIMEOUT_MS);
  }

  /**
   * Call an already-running project daemon without starting one.
   *
   * Cross-project discovery must use this path: observing another project is
   * never sufficient authority to wake that project's IPC owner.
   */
  async callExisting<O extends SessionCatalogOperationName>(
    op: O,
    args: SessionCatalogOperations[O]['args'],
    options: { timeoutMs?: number } = {},
  ): Promise<SessionCatalogOperations[O]['result']> {
    await this.ensureConnected(false);
    return this.request({ type: 'request', op, args }, options.timeoutMs ?? CALL_TIMEOUT_MS);
  }

  ping(): Promise<SessionCatalogOperations['ping']['result']> {
    return this.call('ping', {}, { timeoutMs: 3_000 });
  }

  async subscribe(listener: (event: SessionCatalogEvent) => void): Promise<() => Promise<void>> {
    if (!this.eventListeners.has(listener) && this.eventListeners.size >= MAX_EVENT_LISTENERS) {
      throw new Error(`Session Catalog listener limit reached (${MAX_EVENT_LISTENERS})`);
    }
    this.explicitlyClosed = false;
    this.eventListeners.add(listener);
    try {
      await this.call('subscribe', {});
    } catch (error) {
      this.eventListeners.delete(listener);
      throw error;
    }
    return async () => {
      this.eventListeners.delete(listener);
      if (this.eventListeners.size === 0)
        await this.callExisting('unsubscribe', {}).catch(() => undefined);
    };
  }

  async shutdown(reason?: string): Promise<{ stopped: boolean; pid?: number }> {
    try {
      await this.ensureConnected(false);
    } catch {
      return { stopped: false };
    }
    const result: { stopped: boolean; pid?: number } = await this.request<{
      stopped: boolean;
      pid?: number;
    }>({ type: 'shutdown', ...(reason !== undefined ? { reason } : {}) }, 5_000).catch(
      (): { stopped: boolean; pid?: number } => ({ stopped: false }),
    );
    if (result.stopped) {
      const metadataPath = sessionCatalogProjectServerMetadataPath(this.options.projectDir);
      const deadline = Date.now() + 5_000;
      while (fs.existsSync(metadataPath) && Date.now() < deadline) await delay(20);
      if (result.pid && result.pid !== process.pid) {
        while (Date.now() < deadline) {
          try {
            process.kill(result.pid, 0);
            await delay(20);
          } catch {
            break;
          }
        }
      }
    }
    return result;
  }

  async close(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    this.info = null;
    if (socket && !socket.destroyed)
      await new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.end();
      });
  }

  private async ensureConnected(spawnIfMissing: boolean): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.info) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithElection(spawnIfMissing).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectWithElection(spawnIfMissing: boolean): Promise<void> {
    const deadline = Date.now() + (spawnIfMissing ? START_TIMEOUT_MS : CONNECT_TIMEOUT_MS);
    let spawned = false;
    let lastError: unknown = new Error('Session Catalog project server unavailable');
    while (Date.now() < deadline) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error;
      }
      if (!spawnIfMissing) break;
      if (!spawned) {
        try {
          this.spawnDetached();
          spawned = true;
        } catch (error) {
          // A concurrent workspace rebuild can transiently remove the built
          // project-server artifact; this deadline loop exists to absorb
          // exactly that window, so record the failure and retry the spawn
          // once the artifact re-emerges instead of letting the throw bypass
          // the loop (hq-mailbox-mutation flake, bug-hunt round 18).
          lastError = error;
        }
      }
      await delay(75);
    }
    throw lastError;
  }

  private connectOnce(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.info = null;
    this.authToken = undefined;
    this.buffer = '';
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint);
      this.socket = socket;
      socket.setEncoding('utf8');
      const timer = setTimeout(() => {
        reject(new Error('Session Catalog handshake timed out'));
        socket.destroy();
      }, CONNECT_TIMEOUT_MS);
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

  private currentAuthToken(): string | undefined {
    if (this.authToken === undefined) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(sessionCatalogProjectServerMetadataPath(this.options.projectDir), 'utf8'),
        ) as { authToken?: unknown };
        if (typeof parsed.authToken === 'string' && parsed.authToken)
          this.authToken = parsed.authToken;
      } catch {
        /* daemon returns explicit unauthorized response */
      }
    }
    return this.authToken;
  }

  private request<T>(
    message:
      | { type: 'request'; op: SessionCatalogOperationName; args: unknown }
      | { type: 'shutdown'; reason?: string },
    timeoutMs: number,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error('Session Catalog connection is unavailable'));
    const id = this.nextId++;
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new Error(`Session Catalog pending request limit reached (${MAX_PENDING_REQUESTS})`),
      );
    }
    const encoded = encodeSessionCatalogMessage({
      ...message,
      id,
      authToken: this.currentAuthToken(),
    });
    if (encoded.length > SESSION_CATALOG_MAX_FRAME_CHARS)
      return Promise.reject(new Error('Session Catalog request exceeded frame limit'));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(
          new Error(
            `Session Catalog ${message.type === 'request' ? message.op : message.type} timed out`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encoded);
    });
  }

  private onData(socket: net.Socket, chunk: string): void {
    if (socket !== this.socket) return;
    this.buffer += chunk;
    if (this.buffer.length > SESSION_CATALOG_MAX_FRAME_CHARS) {
      socket.destroy(new Error('Session Catalog response exceeded frame limit'));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line) as SessionCatalogServerMessage);
      } catch {
        socket.destroy(new Error('Invalid Session Catalog response'));
        return;
      }
    }
  }

  private onMessage(message: SessionCatalogServerMessage): void {
    if (message.type === 'hello') {
      if (message.protocolVersion !== SESSION_CATALOG_PROTOCOL_VERSION) {
        this.connectReject?.(
          new Error(
            `Session Catalog protocol mismatch: client=${SESSION_CATALOG_PROTOCOL_VERSION}, server=${message.protocolVersion}`,
          ),
        );
        this.socket?.destroy();
        return;
      }
      if (
        normalize(message.projectDir) !== normalize(this.options.projectDir) ||
        normalize(message.projectRoot) !== normalize(this.options.projectRoot)
      ) {
        this.connectReject?.(new Error('Session Catalog project identity mismatch'));
        this.socket?.destroy();
        return;
      }
      this.info = message;
      this.connectResolve?.();
      return;
    }
    if (message.type === 'event') {
      for (const listener of this.eventListeners) {
        try {
          listener(message.event);
        } catch {
          /* observer isolation */
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error);
      if (message.errorName) error.name = message.errorName;
      pending.reject(error);
    }
  }

  private onClose(socket: net.Socket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.info = null;
    this.authToken = undefined;
    const error = new Error('Session Catalog connection closed');
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.scheduleSubscriptionReconnect();
  }

  private scheduleSubscriptionReconnect(): void {
    if (this.explicitlyClosed || this.eventListeners.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.call('subscribe', {}).catch(() => this.scheduleSubscriptionReconnect());
    }, 250);
    this.reconnectTimer.unref?.();
  }

  private spawnDetached(): void {
    const url = resolveSessionCatalogProjectServerUrl();
    if (!url) throw new Error('Built Session Catalog project server is unavailable');
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(url),
        '--project-dir',
        this.options.projectDir,
        '--project-root',
        this.options.projectRoot,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true, env: process.env },
    );
    child.unref();
  }
}
