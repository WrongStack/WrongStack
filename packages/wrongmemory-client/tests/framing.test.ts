// Ported from WrongMemory packages/client-ts/test/framing.test.ts @ 50a9d9f (bun:test -> vitest).
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  encodeFrame,
  FrameDecoder,
  isWrongMemoryError,
  WrongMemoryClient,
  WrongMemoryError,
} from '../src/index.js';

function startStubDaemon(
  onClient: (socket: Socket, token: string) => void,
): Promise<{ root: string; server: Server; cleanup: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), 'wm-client-test-'));
  const runtimeDir = join(root, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\wm-client-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      : join(runtimeDir, 'wm.sock');

  writeFileSync(join(runtimeDir, 'token'), token, 'utf8');
  writeFileSync(
    join(runtimeDir, 'endpoint.json'),
    JSON.stringify({
      pid: process.pid,
      endpoint,
      protocolMajor: 1,
      protocolMinor: 0,
      startedAtMs: Date.now(),
    }),
    'utf8',
  );

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onClient(socket, token);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      resolve({
        root,
        server,
        cleanup: async () => {
          for (const s of sockets) s.destroy();
          await new Promise<void>((r) => server.close(() => r()));
          rmSync(root, { recursive: true, force: true });
        },
      });
    });
  });
}

function wireHandshake(
  socket: Socket,
  token: string,
  onAuthenticatedFrame: (msg: Record<string, unknown>, socket: Socket) => void,
): void {
  let step = 0;
  let buf = '';
  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (step === 0) {
        step = 1;
        const nonce = String(msg.nonce ?? '');
        const proof = createHmac('sha256', token)
          .update(`wrongmemory-server-proof-v1:${nonce}`)
          .digest('hex');
        socket.write(`${JSON.stringify({ proof })}\n`);
      } else if (step === 1) {
        step = 2;
        socket.write(
          `${JSON.stringify({
            status: 'ok',
            hello: {
              daemonVersion: '0.1.0',
              protocolMajor: 1,
              protocolMinor: 0,
              principal: 'host',
              pid: process.pid,
            },
          })}\n`,
        );
      } else {
        onAuthenticatedFrame(msg, socket);
      }
    }
  });
}

describe('framing', () => {
  test('round trip with unicode and embedded newlines', () => {
    const d = new FrameDecoder();
    const frames = d.push(Buffer.concat([encodeFrame({ x: 'çağrı 🚀\nline' }), encodeFrame(2)]));
    expect(frames).toEqual([{ x: 'çağrı 🚀\nline' }, 2]);
    expect(d.pending).toBe(0);
  });

  test('frames split across chunks, CRLF and blank lines', () => {
    const d = new FrameDecoder();
    const bytes = Buffer.from('\n{"a":1}\r\n{"b":"ü"}\n');
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(...d.push(bytes.subarray(i, i + 1)));
    expect(out).toEqual([{ a: 1 }, { b: 'ü' }]);
  });

  test('partial frame is reported as pending', () => {
    const d = new FrameDecoder();
    expect(d.push(Buffer.from('{"a"'))).toEqual([]);
    expect(d.pending).toBe(4);
  });

  test('oversized line is rejected before a newline arrives', () => {
    const d = new FrameDecoder(100);
    let err: unknown;
    try {
      d.push(Buffer.alloc(1000, 0x78));
    } catch (e) {
      err = e;
    }
    expect(isWrongMemoryError(err, 'PROTOCOL')).toBe(true);
  });

  test('invalid JSON is a protocol error', () => {
    expect(() => new FrameDecoder().push(Buffer.from('not json\n'))).toThrow(/invalid frame/);
  });

  test('encoder refuses oversized payloads', () => {
    expect(() => encodeFrame('x'.repeat(200), 100)).toThrow(/exceeds/);
  });

  test('WrongMemoryClient.close rejects in-flight waiter immediately and non-object JSON frames raise PROTOCOL error (F71)', async () => {
    const closeEnv = await startStubDaemon((socket, token) => {
      wireHandshake(socket, token, () => {
        // Hold request in flight
      });
    });
    try {
      const client = await WrongMemoryClient.connect({
        dataRoot: closeEnv.root,
        timeoutMs: 5000,
      });
      const rawSocket = (client as unknown as { socket: Socket }).socket;
      expect(rawSocket.listenerCount('connect')).toBe(0);
      expect(rawSocket.listenerCount('error')).toBe(1);

      const origDestroy = rawSocket.destroy.bind(rawSocket);
      rawSocket.destroy = (() => rawSocket) as typeof rawSocket.destroy;

      let rejectedErr: unknown;
      const callPromise = client.health().catch((err) => {
        rejectedErr = err;
      });
      await new Promise((r) => setTimeout(r, 15));
      (client as unknown as { frames: unknown[] }).frames.push({
        requestId: 'stale',
        result: { ok: true },
      });
      client.close();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(rejectedErr).toBeInstanceOf(WrongMemoryError);
      expect((rejectedErr as WrongMemoryError).code).toBe('TRANSPORT');
      expect((client as unknown as { frames: unknown[] }).frames.length).toBe(0);

      origDestroy();
      await callPromise;
    } finally {
      await closeEnv.cleanup();
    }

    const protoEnv = await startStubDaemon((socket, token) => {
      wireHandshake(socket, token, (_msg, s) => {
        s.write('null\n');
      });
    });
    try {
      const client = await WrongMemoryClient.connect({
        dataRoot: protoEnv.root,
        timeoutMs: 2000,
      });
      await expect(client.health()).rejects.toSatisfy(
        (err: unknown) => err instanceof WrongMemoryError && err.code === 'PROTOCOL',
      );
      await expect(client.health()).rejects.toSatisfy(
        (err: unknown) => err instanceof WrongMemoryError && err.code === 'PROTOCOL',
      );
      client.close();
    } finally {
      await protoEnv.cleanup();
    }
  });
});
