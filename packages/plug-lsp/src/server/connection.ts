import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { LSPError, LSPErrorCode } from '../types.js';
import { promiseWithTimeout } from '../utils/timeout.js';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null | undefined;
  method?: string | undefined;
  params?: unknown | undefined;
  result?: unknown | undefined;
  error?: { code: number | undefined; message: string; data?: unknown | undefined };
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: unknown): void;
}

export class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly events = new EventEmitter();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly onStdoutData = (chunk: Buffer): void => this.onData(chunk);
  private readonly onStdoutClose = (): void => this.close();
  private readonly onStdoutError = (err: unknown): void => this.closeWithError(err);
  private readonly onStdinError = (err: unknown): void => this.closeWithError(err);

  constructor(
    private readonly stdin: Writable,
    private readonly stdout: Readable,
  ) {
    stdout.on('data', this.onStdoutData);
    stdout.on('close', this.onStdoutClose);
    stdout.on('error', this.onStdoutError);
    // Without an stdin 'error' listener, a write to a server that just died
    // (EPIPE, before stdout 'close' fires) emits an unhandled stream error and
    // crashes the host. Treat it like any other transport failure.
    stdin.on('error', this.onStdinError);
  }

  async sendRequest<R>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<R> {
    this.assertOpen();
    const id = this.nextId++;
    const request: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    const response = new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write(request);
    });
    try {
      return await promiseWithTimeout(response, timeoutMs, signal);
    } catch (err) {
      this.pending.delete(id);
      if (signal.aborted) {
        try {
          this.sendNotification('$/cancelRequest', { id });
        } catch {
          // ignore cancellation write failure
        }
      }
      throw normalizeError(err);
    }
  }

  sendNotification(method: string, params: unknown): void {
    this.assertOpen();
    this.write({ jsonrpc: '2.0', method, params });
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    this.events.on(method, handler);
    return () => this.events.off(method, handler);
  }

  onClose(handler: () => void): () => void {
    this.events.on('close', handler);
    return () => this.events.off('close', handler);
  }

  close(): void {
    this.closeWithError(new LSPError(LSPErrorCode.ProtocolError, 'LSP connection closed'));
  }

  private closeWithError(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.off('data', this.onStdoutData);
    this.stdout.off('close', this.onStdoutClose);
    this.stdout.off('error', this.onStdoutError);
    this.stdin.off('error', this.onStdinError);
    this.buffer = Buffer.alloc(0);
    this.failAll(err);
    this.events.emit('close');
    this.events.removeAllListeners();
  }

  private onData(chunk: Buffer): void {
    // Cap the receive buffer so a misbehaving server that floods data
    // without proper Content-Length headers can't exhaust memory.
    const MAX_BUFFER = 16 * 1024 * 1024; // 16 MiB
    if (this.buffer.length + chunk.length > MAX_BUFFER) {
      this.close();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const sep = this.buffer.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const header = this.buffer.subarray(0, sep).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(sep + 4);
        continue;
      }
      const length = Number(match[1]);
      // Reject NaN, negative, or absurd lengths. Without this a
      // Content-Length: abc slips past as NaN and permanently stalls
      // the message parser.
      if (!Number.isFinite(length) || length < 0 || length > MAX_BUFFER) {
        this.buffer = this.buffer.subarray(sep + 4);
        continue;
      }
      const total = sep + 4 + length;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(sep + 4, total).toString('utf8');
      this.buffer = this.buffer.subarray(total);
      try {
        this.handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Malformed server output should not take down the agent.
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const id = Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (msg.error)
        pending.reject(new LSPError(LSPErrorCode.ProtocolError, msg.error.message, msg.error));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) this.events.emit(msg.method, msg.params);
  }

  private write(message: JsonRpcMessage): void {
    const body = JSON.stringify(message);
    const bytes = Buffer.byteLength(body, 'utf8');
    this.stdin.write(`Content-Length: ${bytes}\r\n\r\n${body}`, 'utf8');
  }

  private assertOpen(): void {
    if (this.closed) throw new LSPError(LSPErrorCode.ProtocolError, 'LSP connection is closed');
  }

  private failAll(err: unknown): void {
    for (const pending of this.pending.values()) pending.reject(normalizeError(err));
    this.pending.clear();
  }
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  /* v8 ignore next -- Node stream errors are Error objects; retained for protocol safety. */
  return new LSPError(LSPErrorCode.ProtocolError, String(err));
}
