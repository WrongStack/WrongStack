import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserNetworkGuardProxy } from '../src/browser/network-guard-proxy.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function fixtureServer(onRequest?: () => void): Promise<{ origin: string }> {
  const server = http.createServer((_request, response) => {
    onRequest?.();
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('fixture-ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture failed to bind');
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function requestThroughProxy(proxyUrl: string, targetUrl: string) {
  const proxy = new URL(proxyUrl);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: targetUrl,
        headers: { host: new URL(targetUrl).host },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('BrowserNetworkGuardProxy', () => {
  it('blocks a private target before the target receives a request', async () => {
    let hits = 0;
    const fixture = await fixtureServer(() => {
      hits += 1;
    });
    const proxy = new BrowserNetworkGuardProxy();
    const proxyUrl = await proxy.start();
    closers.push(() => proxy.close());

    const response = await requestThroughProxy(proxyUrl, `${fixture.origin}/private`);

    expect(response.status).toBe(403);
    expect(response.body).toContain('Blocked by browser network policy');
    // The guard's precise refusal reason is propagated into the body.
    expect(response.body).toContain('private/loopback');
    expect(hits).toBe(0);
  });

  it('allows only an explicitly listed private origin', async () => {
    const fixture = await fixtureServer();
    const proxy = new BrowserNetworkGuardProxy({ allowedPrivateOrigins: [fixture.origin] });
    const proxyUrl = await proxy.start();
    closers.push(() => proxy.close());

    await expect(requestThroughProxy(proxyUrl, `${fixture.origin}/allowed`)).resolves.toEqual({
      status: 200,
      body: 'fixture-ok',
    });
  });

  it('resolves a hostname once and connects directly to the pinned address', async () => {
    const fixture = await fixtureServer();
    const port = new URL(fixture.origin).port;
    const origin = `http://rebind.test:${port}`;
    let lookups = 0;
    const proxy = new BrowserNetworkGuardProxy({
      allowedPrivateOrigins: [origin],
      lookup: async () => {
        lookups += 1;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const proxyUrl = await proxy.start();
    closers.push(() => proxy.close());

    const response = await requestThroughProxy(proxyUrl, `${origin}/pinned`);

    expect(response).toEqual({ status: 200, body: 'fixture-ok' });
    expect(lookups).toBe(1);
  });

  it('pins HTTPS CONNECT tunnels while preserving the original authority', async () => {
    const target = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`));
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string')
      throw new Error('target failed to bind');

    const authority = `secure.test:${targetAddress.port}`;
    const proxy = new BrowserNetworkGuardProxy({
      allowedPrivateOrigins: [`https://${authority}`],
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const proxyUrl = await proxy.start();
    closers.push(() => proxy.close());

    const proxyAddress = new URL(proxyUrl);
    const result = await new Promise<string>((resolve, reject) => {
      const client = net.connect(Number(proxyAddress.port), proxyAddress.hostname);
      let received = '';
      client.once('connect', () => {
        client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      client.on('data', (chunk) => {
        received += chunk.toString('utf8');
        if (received.includes('\r\n\r\n') && !received.includes('echo:ping')) {
          client.write('ping');
        }
        if (received.includes('echo:ping')) {
          client.end();
          resolve(received);
        }
      });
      client.on('error', reject);
    });

    expect(result).toContain('HTTP/1.1 200 Connection Established');
    expect(result).toContain('echo:ping');
  });

  it('survives a browser abort while an HTTPS CONNECT tunnel is writing', async () => {
    const targetSockets = new Set<net.Socket>();
    const target = net.createServer((socket) => {
      targetSockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => targetSockets.delete(socket));
      socket.on('data', () => {
        const burst = Buffer.alloc(256 * 1024, 0x61);
        for (let index = 0; index < 8; index += 1) socket.write(burst);
      });
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    closers.push(async () => {
      for (const socket of targetSockets) socket.destroy();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    });
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string')
      throw new Error('target failed to bind');

    const authority = `abort.test:${targetAddress.port}`;
    const proxy = new BrowserNetworkGuardProxy({
      allowedPrivateOrigins: [`https://${authority}`],
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const proxyAddress = new URL(await proxy.start());
    closers.push(() => proxy.close());

    await new Promise<void>((resolve, reject) => {
      const client = net.connect(Number(proxyAddress.port), proxyAddress.hostname);
      let received = '';
      client.once('connect', () => {
        client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      client.on('data', (chunk) => {
        received += chunk.toString('utf8');
        if (!received.includes('200 Connection Established')) return;
        client.write('start');
        client.resetAndDestroy();
        resolve();
      });
      client.on('error', (error) => {
        if (received.includes('200 Connection Established')) {
          resolve();
          return;
        }
        reject(error);
      });
    });

    // Let the target's queued burst race the reset socket. The proxy must
    // absorb the asynchronous ECONNRESET/ECONNABORTED instead of crashing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(proxy.start()).resolves.toBe(proxyAddress.toString().replace(/\/$/, ''));
  });

  it('forwards guarded plain WebSocket upgrades', async () => {
    const target = http.createServer();
    const targetSockets = new Set<net.Socket>();
    target.on('upgrade', (_request, socket) => {
      targetSockets.add(socket);
      socket.once('close', () => targetSockets.delete(socket));
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
      socket.on('data', (chunk) => socket.write(`ws:${chunk.toString('utf8')}`));
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    closers.push(async () => {
      for (const socket of targetSockets) socket.destroy();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    });
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string')
      throw new Error('target failed to bind');

    const authority = `socket.test:${targetAddress.port}`;
    const proxy = new BrowserNetworkGuardProxy({
      allowedPrivateOrigins: [`http://${authority}`],
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const proxyAddress = new URL(await proxy.start());
    closers.push(() => proxy.close());

    const result = await new Promise<string>((resolve, reject) => {
      const client = net.connect(Number(proxyAddress.port), proxyAddress.hostname);
      let received = '';
      client.once('connect', () => {
        client.write(
          `GET ws://${authority}/chat HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
      });
      client.on('data', (chunk) => {
        received += chunk.toString('utf8');
        if (received.includes('101 Switching Protocols') && !received.includes('ws:ping')) {
          client.write('ping');
        }
        if (received.includes('ws:ping')) {
          client.destroy();
          resolve(received);
        }
      });
      client.on('error', reject);
    });

    expect(result).toContain('101 Switching Protocols');
    expect(result).toContain('ws:ping');
  });
});
