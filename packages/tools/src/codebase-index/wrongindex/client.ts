/**
 * Minimal client for the WrongIndex daemon (protocol 1.x).
 *
 * Transport: a Windows named pipe (a Unix socket elsewhere) named in
 * `<dataRoot>/runtime/endpoint.json`. Framing: a 32-bit unsigned
 * little-endian byte length, then that many bytes of UTF-8 JSON; at most
 * 8 MiB per frame. The first frame authenticates with the token in
 * `<dataRoot>/runtime/token` (owner-private); the token never leaves this
 * module and is never logged.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { buildChildEnv } from '../../_env.js';

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const BASELINE_PROFILE_ID = 'wrongstack-index-v5-baseline';

export interface WrongIndexErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
}

/** A typed refusal from the daemon (`error.code` is its ErrorCode). */
export class WrongIndexRemoteError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(body: WrongIndexErrorBody) {
    super(`WrongIndex: ${body.message} (${body.code})`);
    this.name = 'WrongIndexRemoteError';
    this.code = body.code;
    this.retryable = body.retryable === true;
  }
}

/** The daemon is not running or cannot be reached. */
export class WrongIndexUnavailableError extends Error {
  constructor(message: string) {
    super(`WrongIndex service unavailable: ${message}`);
    this.name = 'WrongIndexUnavailableError';
  }
}

export interface WrongIndexHello {
  daemonInstanceId: string;
  daemonVersion: string;
  protocolMajor: number;
  protocolMinor: number;
  capabilities: string[];
}

/** `WRONGINDEX_HOME`, else `~/.wrongindex` (the daemon's own rule). */
export function wrongIndexDataRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const env = process.env['WRONGINDEX_HOME'];
  if (env) return path.resolve(env);
  return path.join(os.homedir(), '.wrongindex');
}

interface Discovery {
  endpoint: string;
  token: string;
  clientBridge?: string;
}

function discover(dataRoot: string): Discovery {
  const runtime = path.join(dataRoot, 'runtime');
  let info: { endpoint?: unknown; clientBridge?: unknown };
  let token: string;
  try {
    info = JSON.parse(fs.readFileSync(path.join(runtime, 'endpoint.json'), 'utf8'));
    token = fs.readFileSync(path.join(runtime, 'token'), 'utf8').trim();
  } catch (err) {
    throw new WrongIndexUnavailableError(
      `no discovery metadata in ${runtime} (${(err as Error).message})`,
    );
  }
  if (typeof info.endpoint !== 'string' || !info.endpoint || !token) {
    throw new WrongIndexUnavailableError(`invalid discovery metadata in ${runtime}`);
  }
  return {
    endpoint: info.endpoint,
    token,
    ...(typeof info.clientBridge === 'string' ? { clientBridge: info.clientBridge } : {}),
  };
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`WrongIndex frame of ${body.length} bytes exceeds ${MAX_FRAME_BYTES}`);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Accumulates socket bytes and yields complete frames. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`WrongIndex frame of ${len} bytes exceeds ${MAX_FRAME_BYTES}`);
      }
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8')));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

interface Waiter {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/**
 * One authenticated connection. Calls are strictly sequential (the daemon
 * answers in order on a connection); concurrent callers queue.
 */
export class WrongIndexClient {
  private readonly socket: Duplex;
  private readonly dispose: () => void;
  private readonly requestTimeoutMs: number;
  private pendingCalls = 0;
  private readonly reader = new FrameReader();
  private readonly waiters: Waiter[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private closed = false;
  private closeReason: Error | null = null;
  hello!: WrongIndexHello;

  private constructor(socket: Duplex, dispose: () => void, requestTimeoutMs: number) {
    this.socket = socket;
    this.dispose = dispose;
    this.requestTimeoutMs = requestTimeoutMs;
    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = this.reader.push(chunk);
      } catch (err) {
        this.fail(err as Error);
        return;
      }
      for (const f of frames) this.waiters.shift()?.resolve(f);
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new WrongIndexUnavailableError('connection closed')));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private fail(err: Error): void {
    if (!this.closed) {
      this.closed = true;
      this.closeReason = err;
      this.socket.destroy();
      this.dispose();
    }
    for (const w of this.waiters.splice(0)) w.reject(this.closeReason ?? err);
  }

  private nextFrame(): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeReason ?? new Error('closed'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async bounded<T>(
    work: Promise<T>,
    ms: number,
    signal?: AbortSignal,
    onSettleEarly?: (error: WrongIndexRemoteError) => void,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const settleEarly = (
      error: WrongIndexRemoteError,
      reject: (reason?: unknown) => void,
    ): void => {
      reject(error);
      if (onSettleEarly) {
        onSettleEarly(error);
      } else {
        this.fail(new WrongIndexUnavailableError(error.message));
      }
    };
    const timeout = new Promise<never>((_, reject) => {
      onAbort = () => {
        // Replies are sequential on this stream. If already dispatched,
        // invalidate the stream so a late reply cannot satisfy the next caller.
        settleEarly(
          new WrongIndexRemoteError({
            code: 'CANCELED',
            message: 'IPC wait was canceled',
          }),
          reject,
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timer = setTimeout(() => {
        settleEarly(
          new WrongIndexRemoteError({
            code: 'DEADLINE_EXCEEDED',
            message: 'IPC operation timed out',
          }),
          reject,
        );
      }, ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  static async connect(
    opts: {
      dataRoot?: string | undefined;
      clientName?: string | undefined;
      timeoutMs?: number | undefined;
      requestTimeoutMs?: number | undefined;
    } = {},
  ): Promise<WrongIndexClient> {
    const root = wrongIndexDataRoot(opts.dataRoot);
    const { endpoint, token, clientBridge } = discover(root);
    let dispose = () => {};
    let socket: Duplex;
    if (process.platform === 'win32') {
      // The native bridge verifies the SID of the *connected* server before
      // forwarding any byte. Never fall back to an unverified JS pipe.
      if (
        !clientBridge ||
        !path.isAbsolute(clientBridge) ||
        clientBridge.startsWith('\\\\') ||
        path.basename(clientBridge).toLowerCase() !== 'wrongindexd.exe'
      ) {
        throw new WrongIndexRemoteError({
          code: 'PROTOCOL_UNSUPPORTED',
          message:
            'Install the matching WrongIndex daemon build: this adapter requires verified IPC bridge support',
        });
      }
      const child = spawn(clientBridge, ['--ipc-bridge', '--data-root', root], {
        env: buildChildEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      socket = new Duplex({
        read() {
          child.stdout.resume();
        },
        write(chunk, encoding, callback) {
          child.stdin.write(chunk, encoding, callback);
        },
        final(callback) {
          child.stdin.end(callback);
        },
        destroy(error, callback) {
          child.kill();
          callback(error);
        },
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (!socket.push(chunk)) child.stdout.pause();
      });
      child.stdout.on('end', () => socket.push(null));
      child.stdout.on('error', (error) => socket.destroy(error));
      child.stdin.on('error', (error) => socket.destroy(error));
      dispose = () => {
        child.kill();
      };
      child.on('error', () =>
        socket.destroy(new WrongIndexUnavailableError('native IPC bridge could not start')),
      );
      child.on('exit', () =>
        socket.destroy(new WrongIndexUnavailableError('native IPC bridge closed')),
      );
      child.unref();
    } else {
      socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(endpoint);
        const timer = setTimeout(() => {
          s.destroy();
          reject(new WrongIndexUnavailableError(`connecting to ${endpoint} timed out`));
        }, opts.timeoutMs ?? 5_000);
        timer.unref?.();
        s.once('connect', () => {
          clearTimeout(timer);
          resolve(s);
        });
        s.once('error', (err) => {
          clearTimeout(timer);
          reject(new WrongIndexUnavailableError(`${endpoint}: ${err.message}`));
        });
      });
      (socket as net.Socket).unref();
    }
    const client = new WrongIndexClient(socket, dispose, opts.requestTimeoutMs ?? 30_000);
    const reply = client.nextFrame();
    socket.write(
      encodeFrame({
        protocolMajor: PROTOCOL_MAJOR,
        protocolMinor: PROTOCOL_MINOR,
        token,
        clientName: opts.clientName ?? 'wrongstack',
        clientVersion: '1',
        supportedProfileIds: [BASELINE_PROFILE_ID],
      }),
    );
    const auth = (await client.bounded(reply, opts.timeoutMs ?? 5_000)) as {
      status?: string;
      hello?: WrongIndexHello;
      error?: WrongIndexErrorBody;
    };
    if (auth.status !== 'ok' || !auth.hello) {
      client.close();
      // A service finishing its last job before it stops holds its endpoint
      // but takes no new session: for this client it is not running (as a
      // closed endpoint was before), so callers may use the local engine
      // where the service does not hold the index.
      if (auth.error?.code === 'SHUTTING_DOWN') {
        throw new WrongIndexUnavailableError(auth.error.message);
      }
      throw new WrongIndexRemoteError(
        auth.error ?? { code: 'PROTOCOL_UNSUPPORTED', message: 'unexpected handshake reply' },
      );
    }
    if (auth.hello.protocolMajor !== PROTOCOL_MAJOR) {
      client.close();
      throw new WrongIndexRemoteError({
        code: 'PROTOCOL_UNSUPPORTED',
        message: `daemon speaks protocol ${auth.hello.protocolMajor}, this client ${PROTOCOL_MAJOR}`,
      });
    }
    client.hello = auth.hello;
    return client;
  }

  /** One request; resolves with `result`, rejects with a typed error. */
  call<T = unknown>(
    method: string,
    projectId: string | null,
    params: unknown = {},
    idempotencyKey?: string,
    options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    if (this.pendingCalls >= 128)
      return Promise.reject(
        new WrongIndexRemoteError({ code: 'QUEUE_SATURATED', message: 'IPC client queue is full' }),
      );
    this.pendingCalls++;
    let dispatched = false;
    let abortedBeforeDispatch: Error | null = null;
    const run = async (): Promise<T> => {
      if (abortedBeforeDispatch) throw abortedBeforeDispatch;
      // The connection may have gone away while this request was queued.
      if (this.closed)
        throw this.closeReason ?? new WrongIndexUnavailableError('connection closed');
      dispatched = true;
      const requestId = `r${this.nextId++}`;
      const reply = this.nextFrame();
      this.socket.write(
        encodeFrame({
          protocol: PROTOCOL_MAJOR,
          requestId,
          method,
          ...(projectId ? { projectId } : {}),
          params,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      );
      const resp = (await reply) as {
        requestId?: string;
        result?: T;
        error?: WrongIndexErrorBody;
      };
      if (resp.requestId !== requestId) {
        this.fail(new Error(`WrongIndex response ${resp.requestId} does not match ${requestId}`));
        throw this.closeReason;
      }
      if (resp.error) throw new WrongIndexRemoteError(resp.error);
      return resp.result as T;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return this.bounded(
      next,
      options.timeoutMs ?? this.requestTimeoutMs,
      options.signal,
      (error) => {
        if (dispatched) {
          this.fail(new WrongIndexUnavailableError(error.message));
        } else {
          abortedBeforeDispatch = error;
        }
      },
    ).finally(() => {
      this.pendingCalls--;
    });
  }

  close(): void {
    this.fail(new WrongIndexUnavailableError('connection closed'));
  }
}
