import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserNetworkGuardProxy } from '../src/network-guard-proxy.js';

// A browser socket that is reset while the proxy is still resolving its target
// must not be dialled afterwards: the tunnel's close listener was registered
// after the DNS await, so a dial for a gone browser leaked (on Node it was never
// closed, not even by proxy.close()).

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function gate() {
  let release!: () => void;
  let called!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const reached = new Promise<void>((r) => {
    called = r;
  });
  return { released, reached, release, called };
}

const flush = async (turns = 20) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
};

async function gatedProxy() {
  const dns = gate();
  const proxy = new BrowserNetworkGuardProxy({
    allowPrivateHosts: true,
    lookup: async (host) => {
      if (host === 'gated.test') {
        dns.called();
        await dns.released;
      }
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  const url = new URL(await proxy.start());
  closers.push(() => proxy.close());
  const sockets = (proxy as unknown as { sockets: Set<net.Socket> }).sockets;
  const sendRaw = (payload: string) => {
    const client = net.connect({ host: '127.0.0.1', port: Number(url.port) });
    client.on('error', () => {});
    client.write(payload);
    closers.push(() => {
      client.destroy();
    });
    return client;
  };
  /** Reset the browser socket during DNS, wait until the proxy has dropped it, release DNS. */
  const abortDuringDns = async (client: net.Socket) => {
    await dns.reached;
    client.resetAndDestroy();
    for (let i = 0; i < 2000 && sockets.size > 0; i++) await flush(1);
    expect(sockets.size).toBe(0);
    dns.release();
    await flush();
  };
  return { sendRaw, abortDuringDns, sockets };
}

const firstChunk = (client: net.Socket) =>
  new Promise<string>((resolve) => client.once('data', (d) => resolve(String(d))));

describe('BrowserNetworkGuardProxy — browser aborts while DNS is pending', () => {
  it('does not dial a CONNECT target for a browser socket that is already gone', async () => {
    const hosts: string[] = [];
    let fenceByteArrived!: () => void;
    const fenceByte = new Promise<void>((resolve) => {
      fenceByteArrived = resolve;
    });
    const target = net.createServer((socket) => {
      socket.on('error', () => {});
      hosts.push('connection');
      socket.on('data', () => fenceByteArrived());
      closers.push(() => {
        socket.destroy();
      });
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => target.close(() => r())));
    const port = (target.address() as net.AddressInfo).port;
    const { sendRaw, abortDuringDns } = await gatedProxy();

    const aborted = sendRaw(
      `CONNECT gated.test:${port} HTTP/1.1\r\nHost: gated.test:${port}\r\n\r\n`,
    );
    await abortDuringDns(aborted);

    // Fence: a later tunnel completes after any dial the aborted one issued. The
    // proxy answers 200 when its own socket connects, not when the target has
    // accepted, so wait for a byte sent through the tunnel to reach the target:
    // by then the target has registered the fence's connection.
    const fence = sendRaw(`CONNECT open.test:${port} HTTP/1.1\r\nHost: open.test:${port}\r\n\r\n`);
    expect(await firstChunk(fence)).toMatch(/^HTTP\/1\.1 200/);
    fence.write('F');
    await fenceByte;
    await flush();

    expect(hosts).toHaveLength(1);
  });

  it('does not forward a ws upgrade for a browser socket that is already gone', async () => {
    const upgradeHosts: string[] = [];
    const target = http.createServer((_request, response) => response.end('plain'));
    target.on('upgrade', (request, socket) => {
      socket.on('error', () => {});
      upgradeHosts.push(String(request.headers.host));
      closers.push(() => {
        socket.destroy();
      });
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => target.close(() => r())));
    const port = (target.address() as net.AddressInfo).port;
    const { sendRaw, abortDuringDns } = await gatedProxy();
    const upgrade = (host: string) =>
      `GET http://${host}:${port}/ws HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

    const aborted = sendRaw(upgrade('gated.test'));
    await abortDuringDns(aborted);

    const fence = sendRaw(upgrade('open.test'));
    expect(await firstChunk(fence)).toMatch(/^HTTP\/1\.1 101/);
    await flush();

    expect(upgradeHosts.filter((host) => host.startsWith('gated.test'))).toEqual([]);
    expect(upgradeHosts.filter((host) => host.startsWith('open.test'))).toHaveLength(1);
  });
});

// F1570: forwardHttp only listened for the request's `aborted` event, which
// never fires once a GET has been read. A browser leaving an SSE / long-poll
// body (or leaving while DNS ran) kept an upstream connection the proxy never
// closed, unlike the CONNECT and upgrade paths above.
describe('BrowserNetworkGuardProxy — plain HTTP upstream follows the browser', () => {
  it('closes the upstream of a streaming response when the browser leaves mid-body', async () => {
    let upstreamClosed = false;
    const target = http.createServer((request, response) => {
      request.socket.once('close', () => {
        upstreamClosed = true;
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: 1\n\n');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    closers.push(
      () =>
        new Promise<void>((r) => {
          target.closeAllConnections();
          target.close(() => r());
        }),
    );
    const port = (target.address() as net.AddressInfo).port;
    const { sendRaw, sockets } = await gatedProxy();

    const client = sendRaw(
      `GET http://open.test:${port}/sse HTTP/1.1\r\nHost: open.test:${port}\r\n\r\n`,
    );
    let received = '';
    await new Promise<void>((resolve) => {
      client.on('data', (chunk) => {
        received += String(chunk);
        if (received.includes('data: 1')) resolve();
      });
    });
    client.destroy();
    for (let i = 0; i < 2000 && sockets.size > 0; i++) await flush(1);
    expect(sockets.size).toBe(0);
    for (let i = 0; i < 2000 && !upstreamClosed; i++) await flush(1);

    expect(upstreamClosed).toBe(true);
  });

  it('does not dial a plain HTTP target for a browser socket that is already gone', async () => {
    const hosts: string[] = [];
    const target = http.createServer((request, response) => {
      hosts.push(String(request.headers.host));
      response.end('ok');
    });
    let connections = 0;
    target.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    closers.push(
      () =>
        new Promise<void>((r) => {
          target.closeAllConnections();
          target.close(() => r());
        }),
    );
    const port = (target.address() as net.AddressInfo).port;
    const { sendRaw, abortDuringDns } = await gatedProxy();

    const aborted = sendRaw(
      `GET http://gated.test:${port}/ HTTP/1.1\r\nHost: gated.test:${port}\r\n\r\n`,
    );
    await abortDuringDns(aborted);

    // Fence: the target has seen the later request, so any dial the aborted
    // one issued has connected by now.
    const fence = sendRaw(
      `GET http://open.test:${port}/ HTTP/1.1\r\nHost: open.test:${port}\r\n\r\n`,
    );
    expect(await firstChunk(fence)).toMatch(/^HTTP\/1\.1 200/);
    await flush();

    expect(hosts.filter((host) => host.startsWith('open.test'))).toHaveLength(1);
    expect(connections).toBe(1);
  });
});
