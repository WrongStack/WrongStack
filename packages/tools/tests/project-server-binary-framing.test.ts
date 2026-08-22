/**
 * Binary IPC framing for the codebase-index project server (P6/P2.4).
 *
 * The daemon now advertises `binarySupported` in its hello, sniffs each
 * inbound frame's first byte (magic 0x57 → length-prefixed MessagePack,
 * anything else → newline-delimited JSON), and mirrors the framing the
 * client used. Driven over the real socket because the finding is about what
 * crosses it. Skips without a build, like the sibling idle/auth-gate tests:
 * `dist/` is gitignored and the CI test job runs from source.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  encodeBinaryFrame,
  isBinaryFrame,
  MAX_INBOUND_BINARY_FRAME_BYTES,
} from '../src/codebase-index/binary-frame.js';
import { projectIndexServerEndpoint } from '../src/codebase-index/project-server-endpoint.js';
import type { ProjectIndexServerMetadata } from '../src/codebase-index/project-server-protocol.js';

const distServer = fileURLToPath(
  new URL('../dist/codebase-index/project-server.js', import.meta.url),
);
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const distReady = fsSync.existsSync(distServer) && fsSync.existsSync(coreDist);

const children: ChildProcess[] = [];
const roots: string[] = [];
const clients: TestClient[] = [];

/** One decoded frame plus the wire format it arrived in. */
interface Frame {
  binary: boolean;
  message: Record<string, unknown>;
}

/**
 * Raw-socket test client with the same per-frame sniffing the production
 * peers use, so both directions of every negotiated mode can be asserted.
 */
class TestClient {
  readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  readonly frames: Frame[] = [];
  private readonly closedWaiters: Array<() => void> = [];
  closed = false;

  constructor(endpoint: string) {
    this.socket = net.createConnection(endpoint);
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('close', () => {
      this.closed = true;
      for (const waiter of this.closedWaiters.splice(0)) waiter();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      if (isBinaryFrame(this.buffer[0]!)) {
        if (this.buffer.length < 5) return;
        const len = this.buffer.readUInt32BE(1);
        if (this.buffer.length < 5 + len) return;
        const payload = this.buffer.subarray(5, 5 + len);
        this.buffer = this.buffer.subarray(5 + len);
        this.frames.push({
          binary: true,
          message: JSON.parse(JSON.stringify(decodeFrame(payload))) as Record<string, unknown>,
        });
        continue;
      }
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      this.frames.push({ binary: false, message: JSON.parse(line) as Record<string, unknown> });
    }
  }

  sendJson(message: object): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  sendBinary(message: object): void {
    this.socket.write(encodeBinaryFrame(message));
  }

  /** Split one binary frame across two writes to exercise reassembly. */
  sendBinarySplit(message: object, delayMs = 25): void {
    const frame = encodeBinaryFrame(message);
    this.socket.write(frame.subarray(0, 3));
    setTimeout(() => this.socket.write(frame.subarray(3)), delayMs);
  }

  waitFor(match: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        reject(new Error('timed out waiting for an index frame'));
      }, timeoutMs);
      const poll = setInterval(() => {
        const hit = this.frames.find(match);
        if (hit || this.closed) {
          clearInterval(poll);
          clearTimeout(timer);
          if (hit) resolve(hit);
          else reject(new Error('socket closed before the frame arrived'));
        }
      }, 10);
      poll.unref?.();
    });
  }

  waitForClose(timeoutMs = 10_000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
      this.closedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** Minimal MessagePack payload decode — reuse the production decoder. */
function decodeFrame(payload: Buffer): unknown {
  // Imported lazily to keep the import block tidy; it is on every path below.
  const { decodeBinaryFrame } = binaryFrameModule;
  return decodeBinaryFrame(payload);
}

// The production encode/decode module (source build) shares the wire format
// with the compiled daemon — the protocol handshake governs compatibility.
import * as binaryFrameModule from '../src/codebase-index/binary-frame.js';

let daemon: { endpoint: string; token: string } | undefined;

async function ensureDaemon(): Promise<{ endpoint: string; token: string }> {
  if (daemon) return daemon;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-framing-'));
  roots.push(root);
  const indexDir = path.join(root, '.index');
  const endpoint = projectIndexServerEndpoint(root, indexDir);
  children.push(
    spawn(process.execPath, [distServer, '--project-root', root, '--index-dir', indexDir], {
      stdio: 'ignore',
      windowsHide: true,
    }),
  );
  const metadataPath = path.join(indexDir, 'server.json');
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const metadata = JSON.parse(
        await fs.readFile(metadataPath, 'utf8'),
      ) as ProjectIndexServerMetadata;
      daemon = { endpoint, token: metadata.authToken };
      return daemon;
    } catch {
      if (Date.now() >= deadline) throw new Error('timed out waiting for the index daemon');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function clientFor(endpoint: string): TestClient {
  const client = new TestClient(endpoint);
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

afterAll(async () => {
  for (const child of children.splice(0)) child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const root of roots.splice(0)) {
    await fs
      .rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
      .catch(() => undefined);
  }
});

describe.skipIf(!distReady)('project-server binary IPC framing (built dist)', () => {
  it('advertises binarySupported in a JSON hello that carries no token', async () => {
    const { endpoint } = await ensureDaemon();
    const client = clientFor(endpoint);
    const hello = await client.waitFor((frame) => frame.message['type'] === 'hello');
    expect(hello.binary).toBe(false);
    expect(hello.message['binarySupported']).toBe(true);
    expect(hello.message['authToken']).toBeUndefined();
  });

  it('round-trips a JSON ping in JSON framing', async () => {
    const { endpoint, token } = await ensureDaemon();
    const client = clientFor(endpoint);
    await client.waitFor((frame) => frame.message['type'] === 'hello');
    client.sendJson({ type: 'ping', id: 1, authToken: token });
    const response = await client.waitFor(
      (frame) => frame.message['type'] === 'response' && frame.message['id'] === 1,
    );
    expect(response.binary).toBe(false);
    expect(response.message['ok']).toBe(true);
  });

  it('mirrors binary: a binary ping is answered in binary framing', async () => {
    const { endpoint, token } = await ensureDaemon();
    const client = clientFor(endpoint);
    await client.waitFor((frame) => frame.message['type'] === 'hello');
    client.sendBinary({ type: 'ping', id: 2, authToken: token });
    const response = await client.waitFor(
      (frame) => frame.message['type'] === 'response' && frame.message['id'] === 2,
    );
    expect(response.binary).toBe(true);
    expect(response.message['ok']).toBe(true);
  });

  it('mirrors per frame on one mixed connection (JSON ⇄ binary ⇄ JSON)', async () => {
    const { endpoint, token } = await ensureDaemon();
    const client = clientFor(endpoint);
    await client.waitFor((frame) => frame.message['type'] === 'hello');
    // JSON broadcast frames (hello, index-state) already preceded this — the
    // connection is deliberately mixed before the first binary write.
    client.sendJson({ type: 'ping', id: 10, authToken: token });
    client.sendBinary({ type: 'ping', id: 11, authToken: token });
    const json = await client.waitFor(
      (frame) => frame.message['type'] === 'response' && frame.message['id'] === 10,
    );
    const binary = await client.waitFor(
      (frame) => frame.message['type'] === 'response' && frame.message['id'] === 11,
    );
    expect(json.binary).toBe(false);
    expect(json.message['ok']).toBe(true);
    expect(binary.binary).toBe(true);
    expect(binary.message['ok']).toBe(true);
    // Flip back to JSON inbound on the same connection: the reader is
    // per-frame, so a JSON request after binary frames still parses. The
    // RESPONSE stays binary — outbound framing latches once the client has
    // sent binary, matching the production client (which never mixes its
    // outbound after opting in).
    client.sendJson({ type: 'ping', id: 12, authToken: token });
    const backToJson = await client.waitFor(
      (frame) => frame.message['type'] === 'response' && frame.message['id'] === 12,
    );
    expect(backToJson.binary).toBe(true);
    expect(backToJson.message['ok']).toBe(true);
  });

  it('reassembles a binary frame split across writes', async () => {
    const { endpoint, token } = await ensureDaemon();
    const client = clientFor(endpoint);
    await client.waitFor((frame) => frame.message['type'] === 'hello');
    client.sendBinarySplit({ type: 'ping', id: 20, authToken: token });
    const response = await client.waitFor(
      (frame) => frame.message['type'] === 'response' && frame.message['id'] === 20,
    );
    expect(response.binary).toBe(true);
    expect(response.message['ok']).toBe(true);
  });

  it('destroys the connection on an oversized inbound binary frame header', async () => {
    const { endpoint } = await ensureDaemon();
    const client = clientFor(endpoint);
    await client.waitFor((frame) => frame.message['type'] === 'hello');
    const header = Buffer.alloc(5);
    header[0] = 0x57;
    header.writeUInt32BE(MAX_INBOUND_BINARY_FRAME_BYTES + 1, 1);
    client.socket.write(header);
    await client.waitForClose();
  });

  it('destroys the connection on a non-MessagePack binary payload', async () => {
    const { endpoint } = await ensureDaemon();
    const client = clientFor(endpoint);
    await client.waitFor((frame) => frame.message['type'] === 'hello');
    // 0xC1 is a reserved, permanently-invalid MessagePack code. The length
    // prefix is a proper 4-byte big-endian 3 so the frame boundary is valid.
    const header = Buffer.alloc(5);
    header[0] = 0x57;
    header.writeUInt32BE(3, 1);
    client.socket.write(Buffer.concat([header, Buffer.from([0xc1, 0xc1, 0xc1])]));
    await client.waitForClose();
  });

  it('keeps the auth gate identical in binary framing', async () => {
    const { endpoint, token } = await ensureDaemon();
    const client = clientFor(endpoint);
    await client.waitFor((frame) => frame.message['type'] === 'hello');
    client.sendBinary({ type: 'ping', id: 30 });
    const refused = await client.waitFor(
      (frame) => frame.message['type'] === 'response' && frame.message['id'] === 30,
    );
    expect(refused.binary).toBe(true);
    expect(refused.message['ok']).toBe(false);
    expect(refused.message['errorName']).toBe('UnauthorizedIndexRequest');
    client.sendBinary({ type: 'ping', id: 31, authToken: token });
    const allowed = await client.waitFor(
      (frame) => frame.message['type'] === 'response' && frame.message['id'] === 31,
    );
    expect(allowed.binary).toBe(true);
    expect(allowed.message['ok']).toBe(true);
  });
});
