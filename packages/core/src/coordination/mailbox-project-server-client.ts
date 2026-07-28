import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MailboxEvent } from './mailbox-events.js';
import { mailboxProjectServerEndpoint } from './mailbox-project-server-endpoint.js';
import {
  encodeMailboxProjectServerMessage,
  isMailboxProjectServerMessage,
  MAILBOX_PROJECT_SERVER_MAX_FRAME_CHARS,
  MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION,
  type MailboxProjectServerInfo,
  type MailboxProjectServerMessage,
  type MailboxProjectServerStatus,
  type MailboxServerOperationName,
  type MailboxServerOperations,
} from './mailbox-project-server-protocol.js';

const CONNECT_ATTEMPT_TIMEOUT_MS = 750;
const SERVER_START_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export type MailboxProjectServerConnectionStatus =
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'stopping'
  | 'unavailable';

export interface MailboxProjectServerConnectionState {
  status: MailboxProjectServerConnectionStatus;
  connected: boolean;
  projectDir: string;
  endpoint: string;
  pid?: number | undefined;
  lastError?: string | undefined;
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveProjectServerUrl(): URL | null {
  if (
    process.env['WRONGSTACK_MAILBOX_INLINE'] ||
    process.env['WRONGSTACK_MAILBOX_SERVER'] === '0'
  ) {
    return null;
  }
  for (const relative of [
    './mailbox-project-server.js',
    '../../dist/coordination/mailbox-project-server.js',
  ]) {
    try {
      const url = new URL(relative, import.meta.url);
      if (url.protocol === 'file:' && fs.existsSync(fileURLToPath(url))) return url;
    } catch {
      // Try the next supported build layout.
    }
  }
  return null;
}

export function isMailboxProjectServerAvailable(): boolean {
  return resolveProjectServerUrl() !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MailboxProjectServerConnection {
  readonly endpoint: string;
  private socket: net.Socket | null = null;
  private info: MailboxProjectServerInfo | null = null;
  private buffer = '';
  private connecting: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: unknown) => void) | null = null;
  private nextId = 1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(event: string, payload: unknown) => void>();
  private readonly mailboxEventListeners = new Set<(event: MailboxEvent) => void>();
  private readonly stateListeners = new Set<(state: MailboxProjectServerConnectionState) => void>();
  private state: MailboxProjectServerConnectionState;

  constructor(readonly projectDir: string) {
    this.projectDir = path.resolve(projectDir);
    this.endpoint = mailboxProjectServerEndpoint(this.projectDir);
    this.state = {
      status: isMailboxProjectServerAvailable() ? 'offline' : 'unavailable',
      connected: false,
      projectDir: this.projectDir,
      endpoint: this.endpoint,
    };
  }

  getState(): MailboxProjectServerConnectionState {
    return { ...this.state };
  }

  onStateChange(listener: (state: MailboxProjectServerConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: (event: string, payload: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onMailboxEvent(listener: (event: MailboxEvent) => void): () => void {
    this.mailboxEventListeners.add(listener);
    return () => this.mailboxEventListeners.delete(listener);
  }

  async connect(): Promise<void> {
    await this.ensureConnected(true);
  }

  async status(): Promise<MailboxProjectServerStatus> {
    return this.call('ping', {}, { timeoutMs: 3_000 });
  }

  async call<O extends MailboxServerOperationName>(
    op: O,
    args: MailboxServerOperations[O]['args'],
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<MailboxServerOperations[O]['result']> {
    await this.ensureConnected(true);
    return this.request<MailboxServerOperations[O]['result']>(
      { type: 'request', op, args },
      options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );
  }

  async shutdown(reason?: string): Promise<{ stopped: boolean; pid?: number; reason?: string }> {
    try {
      await this.ensureConnected(false);
    } catch {
      return { stopped: false, reason: 'offline' };
    }
    const pid = this.info?.pid;
    const result = await this.request<{ stopped: boolean; pid?: number; reason?: string }>(
      { type: 'shutdown', reason },
      5_000,
    );
    return { ...result, ...(pid !== undefined && result.pid === undefined ? { pid } : {}) };
  }

  close(): void {
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    this.info = null;
    socket?.destroy();
    this.rejectPending(new Error('Mailbox project server connection closed'));
    this.transition('offline');
  }

  private transition(status: MailboxProjectServerConnectionStatus, error?: unknown): void {
    this.state = {
      status,
      connected: status === 'connected',
      projectDir: this.projectDir,
      endpoint: this.endpoint,
      ...(status === 'connected' && this.info ? { pid: this.info.pid } : {}),
      ...(error !== undefined
        ? { lastError: error instanceof Error ? error.message : String(error) }
        : {}),
    };
    for (const listener of [...this.stateListeners]) listener({ ...this.state });
  }

  private async ensureConnected(spawnIfMissing: boolean): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.info) return;
    if (this.connecting) return this.connecting;
    if (!isMailboxProjectServerAvailable()) {
      this.transition('unavailable');
      throw new Error(
        'Built mailbox project server is unavailable. Build @wrongstack/core; direct file fallback is intentionally disabled.',
      );
    }
    this.transition('connecting');
    this.connecting = this.connectWithElection(spawnIfMissing)
      .catch((error) => {
        this.transition('error', error);
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
    let lastError: unknown = new Error('Mailbox project server unavailable');
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

  private connectOnce(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.info = null;
    this.buffer = '';
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint);
      this.socket = socket;
      socket.setEncoding('utf8');
      const timer = setTimeout(() => {
        this.connectReject?.(new Error('Mailbox project server handshake timed out'));
        socket.destroy();
      }, CONNECT_ATTEMPT_TIMEOUT_MS);
      timer.unref?.();
      this.connectResolve = () => {
        clearTimeout(timer);
        this.connectResolve = null;
        this.connectReject = null;
        this.startHeartbeat();
        this.transition('connected');
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
      | { type: 'request'; op: MailboxServerOperationName; args: unknown }
      | { type: 'shutdown'; reason?: string | undefined },
    timeoutMs: number,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('Mailbox project server connection is unavailable'));
    }
    const id = this.nextId++;
    const encoded = encodeMailboxProjectServerMessage({ ...message, id });
    if (encoded.length > MAILBOX_PROJECT_SERVER_MAX_FRAME_CHARS) {
      return Promise.reject(new Error('Mailbox project server request exceeded frame limit'));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error(`Mailbox ${message.type} exceeded its ${timeoutMs}ms timeout`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encoded);
    });
  }

  private onData(socket: net.Socket, chunk: string): void {
    if (socket !== this.socket) return;
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        if (this.buffer.length > MAILBOX_PROJECT_SERVER_MAX_FRAME_CHARS) {
          socket.destroy(new Error('Mailbox project server response exceeded frame limit'));
        }
        return;
      }
      if (newline > MAILBOX_PROJECT_SERVER_MAX_FRAME_CHARS) {
        socket.destroy(new Error('Mailbox project server response exceeded frame limit'));
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        socket.destroy(new Error('Invalid mailbox project server response'));
        return;
      }
      if (!isMailboxProjectServerMessage(parsed)) {
        socket.destroy(new Error('Invalid mailbox project server response'));
        return;
      }
      this.onMessage(parsed);
    }
  }

  private onMessage(message: MailboxProjectServerMessage): void {
    if (message.type === 'hello') {
      if (message.protocolVersion !== MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION) {
        this.connectReject?.(
          new Error(
            `Mailbox protocol mismatch: client=${MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION}, server=${message.protocolVersion}`,
          ),
        );
        this.socket?.destroy();
        return;
      }
      if (normalizePath(message.projectDir) !== normalizePath(this.projectDir)) {
        this.connectReject?.(new Error('Mailbox project server identity mismatch'));
        this.socket?.destroy();
        return;
      }
      this.info = message;
      this.connectResolve?.();
      return;
    }
    if (message.type === 'event') {
      for (const listener of [...this.eventListeners]) listener(message.event, message.payload);
      return;
    }
    if (message.type === 'mailbox-event') {
      for (const listener of [...this.mailboxEventListeners]) listener(message.event);
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
    this.stopHeartbeat();
    const error = new Error('Mailbox project server connection closed');
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    this.rejectPending(error);
    this.transition('offline');
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const configured = Number(process.env['WRONGSTACK_MAILBOX_CLIENT_HEARTBEAT_MS']);
    const intervalMs =
      Number.isFinite(configured) && configured >= 50 ? configured : DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (socket && !socket.destroyed) {
        socket.write(encodeMailboxProjectServerMessage({ type: 'heartbeat' }));
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private spawnDetachedServer(): void {
    const url = resolveProjectServerUrl();
    if (!url) throw new Error('Mailbox project server entrypoint is unavailable');
    // The mailbox may be the first project-scoped service touched during a
    // lightweight TUI/WebUI launch. Ensure the spawn cwd exists before the
    // detached owner is created; the owner remains the only SQLite opener.
    fs.mkdirSync(this.projectDir, { recursive: true });
    const child = spawn(process.execPath, [fileURLToPath(url), '--project-dir', this.projectDir], {
      cwd: this.projectDir,
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  }
}
