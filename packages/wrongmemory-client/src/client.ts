// Vendored from WrongMemory (https://github.com/WrongStack/wrongmemory) commit 71d0bf0,
// file packages/client-ts/src/client.ts. Do not edit here; update upstream and re-vendor.
/**
 * WrongMemory IPC client for Bun/Node: Windows named pipe, newline-delimited
 * JSON, authentication handshake, sequential request/response.
 *
 * Anti-squatting: Node cannot query the pipe server's OS identity (the Rust
 * client checks the server SID). Instead, before any credential is sent,
 * the client sends a random nonce and requires the daemon to return
 * HMAC-SHA256(hostToken, "wrongmemory-server-proof-v1:" + nonce). Only the
 * real daemon holds the owner-private host token, so a pipe name squatted
 * by another account never receives a host token or grant secret.
 */

import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  type AuthResponse,
  type Credential,
  type Hello,
  MAX_AUTH_FRAME_BYTES,
  MAX_FRAME_BYTES,
  METHODS,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  type Response,
} from './contracts.js';
import { loadDiscovery, readGrantSecret, resolveDataRoot } from './discovery.js';
import { WrongMemoryError } from './errors.js';
import { encodeFrame, FrameDecoder } from './framing.js';

export const CLIENT_VERSION = '0.1.0';

export interface ConnectOptions {
  /** Data root (default: WRONGMEMORY_HOME or ~/.wrongmemory). */
  dataRoot?: string;
  /** Attributed label; never proof of identity. */
  clientName?: string;
  /** Use a scoped grant instead of the owner-private host credential. */
  grantId?: string;
  /** Per-call deadline in ms (default 5000). */
  timeoutMs?: number;
  /** Start `wrongmemoryd` when no daemon is reachable. */
  start?: boolean;
  /** Path to `wrongmemoryd(.exe)`; required with `start` unless it sits next to `process.execPath`. */
  daemonPath?: string;
  /** Readiness wait for `start` in ms (default 10000). */
  startTimeoutMs?: number;
}

export interface CallOptions {
  projectId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
}

type Waiter = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

export class WrongMemoryClient {
  private readonly decoder = new FrameDecoder(MAX_FRAME_BYTES);
  private readonly frames: unknown[] = [];
  private waiter: Waiter | undefined;
  private failure: Error | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private hello_: Hello | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    socket.on('data', (data: Buffer) => {
      try {
        for (const f of this.decoder.push(data)) this.frames.push(f);
      } catch (e) {
        this.fail(e as Error);
        return;
      }
      this.flush();
    });
    socket.on('error', (e) => this.fail(new WrongMemoryError('TRANSPORT', e.message)));
    socket.on('close', () =>
      this.fail(
        new WrongMemoryError(
          'TRANSPORT',
          this.decoder.pending > 0 ? 'connection closed mid-frame' : 'connection closed',
        ),
      ),
    );
  }

  /** Discover, (optionally start,) connect, and authenticate. */
  static async connect(opts: ConnectOptions = {}): Promise<WrongMemoryClient> {
    const root = resolveDataRoot(opts.dataRoot);
    try {
      return await WrongMemoryClient.connectOnce(root, opts);
    } catch (e) {
      if (!opts.start || !(e instanceof WrongMemoryError) || e.code !== 'UNAVAILABLE') throw e;
      if (opts.grantId && e.message.includes('credential')) throw e;
      await startDaemon(root, opts);
      return WrongMemoryClient.connectOnce(root, opts);
    }
  }

  private static async connectOnce(root: string, opts: ConnectOptions): Promise<WrongMemoryClient> {
    const discovery = loadDiscovery(root);
    const credential: Credential = opts.grantId
      ? { kind: 'grant', grantId: opts.grantId, secret: readGrantSecret(root, opts.grantId) }
      : { kind: 'host', token: discovery.token };
    const socket = await openPipe(discovery.info.endpoint, opts.timeoutMs ?? 5000);
    const client = new WrongMemoryClient(socket, opts.timeoutMs ?? 5000);
    const auth = {
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      credential,
      clientName: opts.clientName ?? 'wrongmemory-client-ts',
      clientVersion: CLIENT_VERSION,
    };
    try {
      const nonce = randomBytes(32).toString('hex');
      client.socket.write(encodeFrame({ type: 'challenge', nonce }, MAX_AUTH_FRAME_BYTES));
      const proofReply = (await client.next(client.timeoutMs)) as { proof?: unknown };
      const expected = Buffer.from(
        createHmac('sha256', discovery.token)
          .update(`wrongmemory-server-proof-v1:${nonce}`)
          .digest('hex'),
      );
      const got = Buffer.from(typeof proofReply?.proof === 'string' ? proofReply.proof : '');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        throw new WrongMemoryError(
          'UNAVAILABLE',
          `${discovery.info.endpoint} did not prove it is this user's WrongMemory daemon; no credential sent`,
        );
      }
      client.socket.write(encodeFrame(auth, MAX_AUTH_FRAME_BYTES));
      const reply = (await client.next(client.timeoutMs)) as AuthResponse;
      if (reply.status === 'error') throw WrongMemoryError.fromBody(reply.error);
      client.hello_ = reply.hello;
      return client;
    } catch (e) {
      client.close();
      throw e;
    }
  }

  get hello(): Hello {
    if (!this.hello_) throw new WrongMemoryError('PROTOCOL', 'not authenticated');
    return this.hello_;
  }

  /** Send one request; calls are serialized on this connection. */
  call<T = unknown>(method: string, params: unknown = {}, opts: CallOptions = {}): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.failure) throw this.failure;
      const requestId = `r${this.nextId++}`;
      const req: Record<string, unknown> = { protocol: PROTOCOL_MAJOR, requestId, method, params };
      if (opts.projectId !== undefined) req.projectId = opts.projectId;
      if (opts.idempotencyKey !== undefined) req.idempotencyKey = opts.idempotencyKey;
      this.socket.write(encodeFrame(req));
      const resp = (await this.next(opts.timeoutMs ?? this.timeoutMs)) as Response;
      if (resp.requestId !== requestId) {
        const err = new WrongMemoryError(
          'PROTOCOL',
          `response id ${resp.requestId} does not match request ${requestId}`,
        );
        this.fail(err);
        throw err;
      }
      if (resp.error) throw WrongMemoryError.fromBody(resp.error);
      return (resp.result ?? null) as T;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  health() {
    return this.call(METHODS.DAEMON_HEALTH);
  }

  close(): void {
    this.failure ??= new WrongMemoryError('TRANSPORT', 'client closed');
    this.socket.destroy();
  }

  private next(timeoutMs: number): Promise<unknown> {
    if (this.frames.length > 0) return Promise.resolve(this.frames.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        // A late reply would desynchronize request/response pairing, and a
        // timed-out mutation may still commit: drop the connection and let
        // the caller retry with the same idempotency key.
        const err = new WrongMemoryError('DEADLINE_EXCEEDED', `no response within ${timeoutMs} ms`, true);
        this.fail(err);
        reject(err);
      }, timeoutMs);
      this.waiter = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  private flush(): void {
    if (this.waiter && this.frames.length > 0) {
      const w = this.waiter;
      this.waiter = undefined;
      w.resolve(this.frames.shift());
    }
  }

  private fail(e: Error): void {
    this.failure ??= e;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w.reject(this.failure);
    }
    if (!this.socket.destroyed) this.socket.destroy();
  }
}

function openPipe(endpoint: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new WrongMemoryError('UNAVAILABLE', `cannot open ${endpoint}: timeout`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(new WrongMemoryError('UNAVAILABLE', `cannot open ${endpoint}: ${e.message}`));
    });
  });
}

function defaultDaemonPath(): string {
  const exe = process.platform === 'win32' ? 'wrongmemoryd.exe' : 'wrongmemoryd';
  return join(dirname(process.execPath), exe);
}

/** Start the daemon detached (no inherited stdio) and wait until it accepts a host connection. */
export async function startDaemon(root: string, opts: ConnectOptions = {}): Promise<void> {
  const exe = opts.daemonPath ?? defaultDaemonPath();
  if (!existsSync(exe)) {
    throw new WrongMemoryError('UNAVAILABLE', `daemon executable not found: ${exe}`);
  }
  const child = spawn(exe, ['--data-root', root], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + (opts.startTimeoutMs ?? 10_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const probe = await WrongMemoryClient.connect({
        dataRoot: root,
        clientName: 'wrongmemory-start-probe',
        timeoutMs: 2000,
      });
      probe.close();
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new WrongMemoryError(
    'UNAVAILABLE',
    `daemon did not become ready: ${last instanceof Error ? last.message : String(last)}`,
  );
}
