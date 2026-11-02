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
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

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
}

function discover(dataRoot: string): Discovery {
  const runtime = path.join(dataRoot, 'runtime');
  let info: { endpoint?: unknown };
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
  return { endpoint: info.endpoint, token };
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
  private readonly socket: net.Socket;
  private readonly reader = new FrameReader();
  private readonly waiters: Waiter[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private closed = false;
  private closeReason: Error | null = null;
  hello!: WrongIndexHello;

  private constructor(socket: net.Socket) {
    this.socket = socket;
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
    }
    for (const w of this.waiters.splice(0)) w.reject(this.closeReason ?? err);
  }

  private nextFrame(): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeReason ?? new Error('closed'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  static async connect(
    opts: {
      dataRoot?: string | undefined;
      clientName?: string | undefined;
      timeoutMs?: number | undefined;
    } = {},
  ): Promise<WrongIndexClient> {
    const { endpoint, token } = discover(wrongIndexDataRoot(opts.dataRoot));
    const socket = await new Promise<net.Socket>((resolve, reject) => {
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
    socket.unref();
    const client = new WrongIndexClient(socket);
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
    const auth = (await reply) as {
      status?: string;
      hello?: WrongIndexHello;
      error?: WrongIndexErrorBody;
    };
    if (auth.status !== 'ok' || !auth.hello) {
      client.close();
      throw new WrongIndexRemoteError(
        auth.error ?? { code: 'PROTOCOL', message: 'unexpected handshake reply' },
      );
    }
    if (auth.hello.protocolMajor !== PROTOCOL_MAJOR) {
      client.close();
      throw new WrongIndexRemoteError({
        code: 'INCOMPATIBLE_PROTOCOL',
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
  ): Promise<T> {
    const run = async (): Promise<T> => {
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
    return next;
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}
