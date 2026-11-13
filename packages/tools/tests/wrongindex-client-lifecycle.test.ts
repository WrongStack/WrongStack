import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeFrame,
  FrameReader,
  WrongIndexClient,
  WrongIndexRemoteError,
  WrongIndexUnavailableError,
} from '../src/codebase-index/wrongindex/client.js';

const bridge = process.env['WRONGINDEX_TEST_DAEMON'];
const peers: net.Socket[] = [];
const servers: net.Server[] = [];
const clients: WrongIndexClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) c.close();
  for (const s of peers.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
async function fixture(answerHello: boolean | 'shutting-down') {
  let helloArrived!: () => void;
  const helloSeen = new Promise<void>((r) => {
    helloArrived = r;
  });
  let requestArrived!: () => void;
  const requestSeen = new Promise<void>((r) => {
    requestArrived = r;
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-client-lifecycle-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\wi-client-${process.pid}-${path.basename(home)}`
      : path.join(home, 'pipe.sock');
  const received: unknown[] = [];
  const server = net.createServer((socket) => {
    peers.push(socket);
    const frames = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of frames.push(chunk)) {
        received.push(frame);
        if (received.length === 1) helloArrived();
        if (received.length === 2) requestArrived();
        if (received.length === 1 && answerHello === 'shutting-down')
          socket.write(
            encodeFrame({
              status: 'error',
              error: { code: 'SHUTTING_DOWN', message: 'the service is shutting down' },
            }),
          );
        else if (received.length === 1 && answerHello)
          socket.write(
            encodeFrame({
              status: 'ok',
              hello: {
                protocolMajor: 1,
                protocolMinor: 0,
                daemonInstanceId: 'fixture',
                daemonVersion: 'test',
                capabilities: [],
              },
            }),
          );
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(endpoint, r));
  fs.mkdirSync(path.join(home, 'runtime'));
  fs.writeFileSync(
    path.join(home, 'runtime', 'endpoint.json'),
    JSON.stringify({
      endpoint,
      clientBridge: bridge,
      daemonInstanceId: 'fixture',
      daemonVersion: 'test',
      pid: process.pid,
      protocolMajor: 1,
      protocolMinor: 0,
      startedAtMs: 0,
    }),
  );
  fs.writeFileSync(path.join(home, 'runtime', 'token'), 'synthetic-fixture-token');
  return { home, received, requestSeen, helloSeen };
}

describe.runIf(process.platform !== 'win32' || Boolean(bridge))(
  'WrongIndex client lifecycle',
  () => {
    it.runIf(process.platform === 'win32')(
      'refuses legacy discovery before sending a credential',
      async () => {
        const { home, received } = await fixture(true);
        const info = path.join(home, 'runtime', 'endpoint.json');
        const metadata = JSON.parse(fs.readFileSync(info, 'utf8'));
        delete metadata.clientBridge;
        fs.writeFileSync(info, JSON.stringify(metadata));
        await expect(WrongIndexClient.connect({ dataRoot: home })).rejects.toMatchObject({
          code: 'PROTOCOL_UNSUPPORTED',
        });
        expect(received).toEqual([]);
      },
    );
    it('treats a service that is shutting down as not running', async () => {
      // It still holds its endpoint while it finishes its last job, as the
      // closed endpoint of a stopped service did: callers may use the local
      // engine where the service does not hold the index.
      const { home } = await fixture('shutting-down');
      await expect(WrongIndexClient.connect({ dataRoot: home })).rejects.toBeInstanceOf(
        WrongIndexUnavailableError,
      );
    });
    it('bounds a connected peer that never answers authentication', async () => {
      const { home, helloSeen } = await fixture(false);
      // Keep native process/stream scheduling real; only the deadline clock
      // is fake. Faking setImmediate can stop Bun's child transport startup.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = WrongIndexClient.connect({ dataRoot: home, timeoutMs: 100 }).then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      expect(await Promise.race([helloSeen.then(() => true), pending.then(() => false)])).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(100);
      expect((await pending).error).toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    }, 5_000);
    it('settles pending and queued requests when closed', async () => {
      const { home, requestSeen } = await fixture(true);
      const c = await WrongIndexClient.connect({ dataRoot: home });
      clients.push(c);
      const first = c.call('daemon.health', null);
      const queued = c.call('daemon.health', null);
      const settled = Promise.allSettled([first, queued]);
      await requestSeen;
      c.close();
      expect((await settled).map((v) => v.status)).toEqual(['rejected', 'rejected']);
    }, 5_000);
    it('cancels a pending response and closes its stream', async () => {
      const { home, requestSeen } = await fixture(true);
      const c = await WrongIndexClient.connect({ dataRoot: home });
      clients.push(c);
      const controller = new AbortController();
      const pending = expect(
        c.call('daemon.health', null, {}, undefined, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'CANCELED' });
      await requestSeen;
      controller.abort();
      await pending;
      expect(c.isClosed).toBe(true);
    }, 5_000);
    it('bounds a stalled response and rejects the queued call too', async () => {
      const { home, requestSeen } = await fixture(true);
      const c = await WrongIndexClient.connect({ dataRoot: home, requestTimeoutMs: 100 });
      clients.push(c);
      vi.useFakeTimers();
      const a = c.call('daemon.health', null);
      const b = c.call('daemon.health', null);
      const outcome = Promise.allSettled([a, b]);
      await requestSeen;
      await vi.advanceTimersByTimeAsync(100);
      expect((await outcome).map((v) => v.status)).toEqual(['rejected', 'rejected']);
      expect(c.isClosed).toBe(true);
    }, 5_000);
  },
);

describe('WrongIndexClient queued cancellation and bystander isolation (F167)', () => {
  function pairedDuplexClient() {
    let clientSide!: Duplex;
    let serverSide!: Duplex;
    clientSide = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        serverSide.push(chunk);
        cb();
      },
      destroy(err, cb) {
        serverSide.push(null);
        cb(err);
      },
    });
    serverSide = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        clientSide.push(chunk);
        cb();
      },
      destroy(err, cb) {
        clientSide.push(null);
        cb(err);
      },
    });
    const client = Reflect.construct(WrongIndexClient, [
      clientSide,
      () => {},
      30_000,
    ]) as WrongIndexClient;
    clients.push(client);
    return { client, serverSide };
  }

  it('canceling a queued undispatched call preserves the lane and active calls', async () => {
    const { client, serverSide } = pairedDuplexClient();
    const reader = new FrameReader();
    let resolveFirst!: (frame: { requestId: string }) => void;
    const firstDispatched = new Promise<{ requestId: string }>((r) => {
      resolveFirst = r;
    });
    let seen = 0;
    serverSide.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(chunk) as Array<{ requestId: string }>) {
        seen++;
        if (seen === 1) resolveFirst(frame);
        else serverSide.write(encodeFrame({ requestId: frame.requestId, result: { slot: 3 } }));
      }
    });

    const call1 = client.call<{ slot: number }>('index.query', 'proj', { slot: 1 });
    const f1 = await firstDispatched;

    const ac2 = new AbortController();
    const call2 = client.call('index.query', 'proj', { slot: 2 }, undefined, {
      signal: ac2.signal,
    });
    const call3 = client.call<{ slot: number }>('index.query', 'proj', { slot: 3 });

    ac2.abort();
    await expect(call2).rejects.toMatchObject({ code: 'CANCELED' });

    serverSide.write(encodeFrame({ requestId: f1.requestId, result: { slot: 1 } }));
    await expect(call1).resolves.toEqual({ slot: 1 });
    await expect(call3).resolves.toEqual({ slot: 3 });
    expect(client.isClosed).toBe(false);
    expect(seen).toBe(2);
  });

  it('surfaces WrongIndexUnavailableError to queued bystanders when a dispatched call aborts', async () => {
    const { client, serverSide } = pairedDuplexClient();
    const reader = new FrameReader();
    let resolveDispatched!: () => void;
    const dispatched = new Promise<void>((r) => {
      resolveDispatched = r;
    });
    serverSide.on('data', (chunk: Buffer) => {
      if (reader.push(chunk).length > 0) resolveDispatched();
    });

    const ac = new AbortController();
    const stalled = client.call('index.query', 'proj', { q: 'stalled' }, undefined, {
      signal: ac.signal,
    });
    await dispatched;
    const bystander = client.call('index.query', 'proj', { q: 'bystander' });

    ac.abort();
    await expect(stalled).rejects.toBeInstanceOf(WrongIndexRemoteError);
    const bystanderErr = await bystander.catch((err: unknown) => err);
    expect(bystanderErr).toBeInstanceOf(WrongIndexUnavailableError);
    expect(bystanderErr).not.toBeInstanceOf(WrongIndexRemoteError);
  });
});
