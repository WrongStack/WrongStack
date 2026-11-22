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

/**
 * Header-block byte cap. LSP header blocks are two short lines; anything past
 * this without a blank-line terminator is a stream that is not speaking LSP.
 */
const MAX_HEADER_BYTES = 64 * 1024;
/** Body byte cap — a Content-Length above this is treated as malformed. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

export class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly events = new EventEmitter();
  /**
   * Transport-close handlers live apart from `events`: that emitter is keyed by
   * server-chosen method names, so a server message whose method was `close`
   * ran every close handler (a ready server went `failed`) while the transport
   * was still open.
   */
  private readonly closeHandlers = new Set<() => void>();
  /**
   * Receive state is a two-phase machine instead of one growing buffer.
   *
   * The old shape — `buffer = Buffer.concat([buffer, chunk])` per 'data'
   * event until the full message arrived — is quadratic in the message size:
   * a 16 MiB response (workspace symbols on a large repository) delivered in
   * 64 KiB reads re-copies the accumulated buffer every read, ~2 GiB of
   * copying for that one message, on the hot path of every LSP round trip.
   *
   * Headers still accumulate by concat, because the `\r\n\r\n` terminator can
   * straddle a chunk boundary — but a header block is bounded by
   * `MAX_HEADER_BYTES`, so that concat is trivially cheap. The body's length
   * is known from Content-Length before its first byte arrives, so body
   * chunks are held in an array and joined exactly once, at the boundary.
   */
  private headerBuffer: Buffer = EMPTY;
  private bodyParts: Buffer[] = [];
  private bodyReceived = 0;
  /** Expected body byte count; -1 while parsing headers. */
  private bodyExpected = -1;
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
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    const id = this.allocateRequestId();
    const request: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    const response = new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write(request);
    });
    try {
      return await promiseWithTimeout(response, timeoutMs, signal);
    } catch (err) {
      this.pending.delete(id);
      if (signal.aborted || (err instanceof LSPError && err.code === LSPErrorCode.RequestTimeout)) {
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
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
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
    this.headerBuffer = EMPTY;
    this.bodyParts = [];
    this.bodyReceived = 0;
    this.bodyExpected = -1;
    this.failAll(err);
    const closeHandlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const handler of closeHandlers) handler();
    this.events.removeAllListeners();
  }

  private onData(chunk: Buffer): void {
    let rest = chunk;
    while (rest.length > 0 && !this.closed) {
      if (this.bodyExpected >= 0) {
        // Body phase: hold chunks, join once when the known length is in.
        const take = Math.min(rest.length, this.bodyExpected - this.bodyReceived);
        this.bodyParts.push(rest.subarray(0, take));
        this.bodyReceived += take;
        rest = rest.subarray(take);
        if (this.bodyReceived < this.bodyExpected) return;
        const body = Buffer.concat(this.bodyParts, this.bodyExpected).toString('utf8');
        this.bodyParts = [];
        this.bodyReceived = 0;
        this.bodyExpected = -1;
        this.dispatchBody(body);
        continue;
      }
      // Header phase. MAX_HEADER_BYTES bounds the header BLOCK — a stream
      // that produces this much without a blank-line terminator is not
      // speaking LSP, so it is closed rather than buffered. It must not be
      // checked against the whole chunk: that also counts the body bytes
      // after the terminator, so a header straddling a read boundary followed
      // by a full 64 KiB pipe read closed a healthy connection.
      this.headerBuffer =
        this.headerBuffer.length === 0 ? rest : Buffer.concat([this.headerBuffer, rest]);
      rest = EMPTY;
      for (;;) {
        const sep = this.headerBuffer.indexOf('\r\n\r\n');
        if (sep > MAX_HEADER_BYTES || (sep === -1 && this.headerBuffer.length > MAX_HEADER_BYTES)) {
          this.close();
          return;
        }
        if (sep === -1) break;
        const header = this.headerBuffer.subarray(0, sep).toString('ascii');
        const after = this.headerBuffer.subarray(sep + 4);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          this.headerBuffer = after;
          continue;
        }
        const length = Number(match[1]);
        // Reject NaN, negative, or absurd lengths. Without this a
        // Content-Length: abc slips past as NaN and permanently stalls
        // the message parser.
        if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
          this.headerBuffer = after;
          continue;
        }
        if (length === 0) {
          // Zero-length body: dispatch immediately (JSON.parse('') is
          // swallowed like any other malformed body) and keep scanning.
          this.headerBuffer = after;
          this.dispatchBody('');
          continue;
        }
        this.bodyExpected = length;
        this.bodyReceived = 0;
        this.bodyParts = [];
        this.headerBuffer = EMPTY;
        // Whatever followed the header block is body bytes — feed it back
        // through the outer loop's body phase.
        rest = after;
        break;
      }
    }
  }

  private dispatchBody(body: string): void {
    try {
      this.handleMessage(JSON.parse(body) as JsonRpcMessage);
    } catch {
      // Malformed server output should not take down the agent.
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      // Client request IDs are numeric; coercion can settle an unrelated call.
      if (typeof msg.id !== 'number' || !Number.isSafeInteger(msg.id)) return;
      const id = msg.id;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (msg.error)
        pending.reject(new LSPError(LSPErrorCode.ProtocolError, msg.error.message, msg.error));
      else pending.resolve(msg.result);
      return;
    }
    // A message carrying BOTH an id and a method is a server-initiated
    // request, and the server blocks until it is answered. Ignoring these
    // deadlocks servers that register capabilities during `initialized` —
    // TypeScript 7's native server stalls every subsequent request.
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this.events.emit(msg.method, msg.params);
      this.answerServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method) this.events.emit(msg.method, msg.params);
  }

  /**
   * Minimal but protocol-correct replies to the requests servers actually
   * make of a client. Anything we do not implement gets MethodNotFound, which
   * is a valid answer and unblocks the server just as well as a result would.
   */
  private answerServerRequest(id: number | string, method: string, params: unknown): void {
    /* v8 ignore next -- defensive: closing detaches the stdout listener that feeds this. */
    if (this.closed) return;
    switch (method) {
      // We accept every dynamic registration: the capabilities we care about
      // are declared statically, and refusing here makes servers retry.
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
        this.write({ jsonrpc: '2.0', id, result: null });
        return;
      case 'workspace/configuration': {
        // One entry per requested item; null means "no setting configured".
        const items = (params as { items?: unknown[] } | undefined)?.items;
        const count = Array.isArray(items) ? items.length : 0;
        this.write({ jsonrpc: '2.0', id, result: new Array<null>(count).fill(null) });
        return;
      }
      case 'workspace/applyEdit':
        // Edits arrive through the rename tool, which applies them itself. A
        // server-pushed edit is declined rather than silently dropped.
        this.write({
          jsonrpc: '2.0',
          id,
          result: { applied: false, failureReason: 'client does not apply server-pushed edits' },
        });
        return;
      default:
        this.write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not implemented by client: ${method}` },
        });
    }
  }

  private write(message: JsonRpcMessage): void {
    const body = JSON.stringify(message);
    const bytes = Buffer.byteLength(body, 'utf8');
    this.stdin.write(`Content-Length: ${bytes}\r\n\r\n${body}`, 'utf8');
  }

  private assertOpen(): void {
    if (this.closed) throw new LSPError(LSPErrorCode.ProtocolError, 'LSP connection is closed');
  }

  private allocateRequestId(): number {
    // JSON numbers cannot distinguish integers beyond MAX_SAFE_INTEGER. Wrap
    // before that boundary and skip any IDs still owned by in-flight calls.
    // At most pending.size + 1 probes are needed because there is always one
    // more candidate than occupied IDs in that prefix of the ID space.
    for (let attempts = 0; attempts <= this.pending.size; attempts++) {
      const id = Number.isSafeInteger(this.nextId) && this.nextId > 0 ? this.nextId : 1;
      this.nextId = id === Number.MAX_SAFE_INTEGER ? 1 : id + 1;
      if (!this.pending.has(id)) return id;
    }
    /* v8 ignore next -- exhausting the safe-integer ID space is not operationally reachable. */
    throw new LSPError(LSPErrorCode.ProtocolError, 'No LSP request IDs available');
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
