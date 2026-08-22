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
  encodeJsonFrame,
  isBinaryFrame,
  MAX_INBOUND_BINARY_FRAME_BYTES,
} from '../src/codebase-index/binary-frame.js';
import { projectIndexServerEndpoint } from '../src/codebase-index/project-server-endpoint.js';
import {
  encodeProjectServerMessage,
  type ProjectIndexServerMetadata,
} from '../src/codebase-index/project-server-protocol.js';

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

describe('encodeBinaryFrame null-prototype normalization (unit)', () => {
  it('strips undefined inside Object.create(null) wrappers — JSON/binary shape parity', () => {
    // JSON.parse and Object.assign(Object.create(null), …) both produce
    // null-prototype records. Before the isPlainObject fix these skipped the
    // undefined-stripping recursion, so the SAME payload shape-shifted
    // between framings: JSON dropped the key, MessagePack delivered null.
    const nested = Object.assign(Object.create(null), {
      lspKind: undefined,
      name: 'keep',
      inner: Object.assign(Object.create(null), { gone: undefined, kept: 2 }),
    });
    const frame = encodeBinaryFrame({ type: 'ping', payload: nested });
    // Strip the 5-byte header (magic + uint32 BE length) to get the payload.
    const decoded = binaryFrameModule.decodeBinaryFrame(frame.subarray(5)) as {
      payload: { name: string; inner: Record<string, unknown> };
    };
    expect('lspKind' in decoded.payload).toBe(false);
    expect(decoded.payload['name']).toBe('keep');
    expect('gone' in decoded.payload['inner']).toBe(false);
    expect(decoded.payload['inner']['kept']).toBe(2);
  });
});

describe('encodeBinaryFrame null values (unit, audit follow-up)', () => {
  // Chimera Medium: the null-prototype tests covered undefined-stripping,
  // but nothing pinned bare null VALUES — the exact payload of the first
  // authorized binary ping response (updatedAt: null / lastError: null)
  // that crashed the daemon when isPlainObject's prototype lookup ran
  // before its null guard.
  it('encodes the ping-response shape without throwing and preserves nulls', () => {
    const decoded = binaryFrameModule.decodeBinaryFrame(
      encodeBinaryFrame({ type: 'ping', ok: true, updatedAt: null, lastError: null }).subarray(5),
    ) as Record<string, unknown>;
    expect(decoded['ok']).toBe(true);
    expect(decoded['updatedAt']).toBeNull();
    expect(decoded['lastError']).toBeNull();
  });

  it('distinguishes null from undefined exactly as the JSON framing does', () => {
    const payload = { dropped: undefined, kept: null } as Record<string, unknown>;
    const decoded = binaryFrameModule.decodeBinaryFrame(
      encodeBinaryFrame(payload).subarray(5),
    ) as Record<string, unknown>;
    // undefined is stripped (JSON.stringify drops the key); null survives.
    expect('dropped' in decoded).toBe(false);
    expect(decoded['kept']).toBeNull();
    // Parity oracle: identical shape to the JSON framing of the same payload.
    expect(decoded).toEqual(JSON.parse(JSON.stringify(payload)));
  });
});

describe('framing parity: both framings deliver the same normalized tree (bf-2)', () => {
  // The daemon answers in the client's framing, so a payload's delivered
  // shape must not depend on which framing carried it. Before bf-2 the
  // framings diverged in both directions: JSON.stringify silently lost
  // Map/Set/Error/RegExp payloads entirely (`{}`), while the binary
  // normalizer threw on invalid Dates where JSON delivered null.
  const parityCases: Array<[string, unknown]> = [
    [
      'Map',
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    ],
    ['Set', new Set([1, 2])],
    ['Error', new Error('boom')],
    ['Date valid', new Date('2026-08-22T10:00:00.000Z')],
    ['Date invalid (NaN)', new Date('not-a-date')],
    ['RegExp', /ab+c/gi],
    ['URL', new URL('https://x.example/p?q=1')],
    ['Buffer', Buffer.from([1, 2, 3])],
    ['nested map/set/date', { m: new Map([['k', 1]]), s: new Set([9]), d: new Date(0) }],
  ];

  // Error stacks vary per run, but BOTH framings serialize the SAME Error
  // instance within one comparison, so the stack text is identical on both
  // sides — the per-case equality check is deterministic.

  for (const [name, value] of parityCases) {
    it(`${name}: decode(binary) equals JSON.parse(json)`, () => {
      const binaryDecoded = binaryFrameModule.decodeBinaryFrame(
        encodeBinaryFrame({ v: value }).subarray(5),
      ) as Record<string, unknown>;
      const jsonDecoded = JSON.parse(encodeJsonFrame({ v: value })) as Record<string, unknown>;
      expect(binaryDecoded).toEqual(jsonDecoded);
    });
  }

  it('Map and Set payloads carry data in BOTH framings (no silent {} loss)', () => {
    const jsonDecoded = JSON.parse(encodeJsonFrame({ m: new Map([['k', 1]]), s: new Set([9]) }));
    // The bf-1 dump showed plain JSON.stringify delivering {} here — the
    // normalizer must preserve the data on the JSON path too.
    expect(jsonDecoded).toEqual({ m: { k: 1 }, s: [9] });
  });

  it('invalid Date never throws in either framing', () => {
    expect(() => encodeBinaryFrame({ d: new Date('not-a-date') })).not.toThrow();
    expect(JSON.parse(encodeJsonFrame({ d: new Date('not-a-date') })).d).toBeNull();
  });

  it('undefined-stripping is identical across framings', () => {
    const payload = { a: undefined, b: 1, inner: { c: undefined, d: null } };
    const binaryDecoded = binaryFrameModule.decodeBinaryFrame(
      encodeBinaryFrame(payload).subarray(5),
    ) as Record<string, unknown>;
    const jsonDecoded = JSON.parse(encodeJsonFrame(payload)) as Record<string, unknown>;
    expect(binaryDecoded).toEqual(jsonDecoded);
    expect('a' in binaryDecoded).toBe(false);
    expect((binaryDecoded['inner'] as Record<string, unknown>)['d']).toBeNull();
  });

  it('PRODUCTION encoder: encodeProjectServerMessage delivers normalized data', () => {
    // prod fix pin: the server and client write JSON frames through
    // encodeProjectServerMessage, NOT through encodeJsonFrame. When it used
    // raw JSON.stringify, Map/Set/Error/RegExp data was silently lost on
    // the real wire even though the helper-level parity tests were green —
    // the gap Chimera caught after the bf-2 commit. This test fails if the
    // production encoder ever stops delegating to the shared normalizer.
    const decoded = JSON.parse(
      encodeProjectServerMessage({ type: 'response', id: 1, ok: true, m: new Map([['k', 7]]) }),
    ) as Record<string, unknown>;
    expect(decoded['m']).toEqual({ k: 7 }); // data, not {}
    expect(decoded['ok']).toBe(true);

    // Frame terminator preserved (the reader splits on newline).
    expect(encodeProjectServerMessage({ type: 'ping' }).endsWith('\n')).toBe(true);

    // And it matches the binary framing of the identical payload.
    const binaryDecoded = binaryFrameModule.decodeBinaryFrame(
      encodeBinaryFrame({ type: 'ping', m: new Map([['k', 7]]) }).subarray(5),
    ) as Record<string, unknown>;
    expect(
      JSON.parse(encodeProjectServerMessage({ type: 'ping', m: new Map([['k', 7]]) })),
    ).toEqual(binaryDecoded);
  });
});

describe('encodeBinaryFrame class-instance allowlist (unit)', () => {
  function roundTrip(payload: object): Record<string, unknown> {
    return binaryFrameModule.decodeBinaryFrame(encodeBinaryFrame(payload).subarray(5)) as Record<
      string,
      unknown
    >;
  }

  it('converts Date to its JSON-framing shape — ISO string, exact parity', () => {
    const stamp = new Date(0);
    const decoded = roundTrip({ at: stamp });
    expect(decoded['at']).toBe(stamp.toISOString());
    // Parity oracle: the JSON framing of the very same payload.
    expect(decoded).toEqual(JSON.parse(JSON.stringify({ at: stamp })));
  });

  it('converts Map to a plain object and Set to an array, recursively', () => {
    const payload = {
      map: new Map([
        ['keep', 1],
        [
          'inner',
          new Map([
            ['gone', undefined],
            ['kept', 2],
          ]),
        ],
      ]),
      set: new Set(['x', 'y']),
    };
    const decoded = roundTrip(payload) as {
      map: Record<string, unknown>;
      set: unknown[];
    };
    expect(decoded.map['keep']).toBe(1);
    const inner = decoded.map['inner'] as Record<string, unknown>;
    expect('gone' in inner).toBe(false);
    expect(inner['kept']).toBe(2);
    expect(decoded.set).toEqual(['x', 'y']);
  });

  it('converts Error to { name, message, stack }', () => {
    const decoded = roundTrip({ err: new TypeError('boom') }) as {
      err: { name: string; message: string; stack: string | undefined };
    };
    expect(decoded.err.name).toBe('TypeError');
    expect(decoded.err.message).toBe('boom');
    expect(typeof decoded.err.stack).toBe('string');
  });

  it('converts RegExp to its source string and URL to its href (toJSON parity)', () => {
    const payload = { re: /ab+c/gi, url: new URL('https://example.com/x?y=1') };
    const decoded = roundTrip(payload) as { re: string; url: string };
    expect(decoded.re).toBe('/ab+c/gi');
    expect(decoded.url).toBe('https://example.com/x?y=1');
    expect(decoded.url).toBe(JSON.parse(JSON.stringify(payload)).url);
  });

  it('converts Buffer to the JSON-framing shape { type: "Buffer", data: [...] }', () => {
    const payload = { buf: Buffer.from([1, 2, 3]) };
    const decoded = roundTrip(payload);
    expect(decoded['buf']).toEqual({ type: 'Buffer', data: [1, 2, 3] });
    expect(decoded).toEqual(JSON.parse(JSON.stringify(payload)));
  });
});
