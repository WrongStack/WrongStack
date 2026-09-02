import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { findFreePort, isPortFree } from '@wrongstack/webui-server';

const HOST = '127.0.0.1';
const servers: net.Server[] = [];

/** Bind a server to an OS-assigned port and return it for later occupancy checks. */
function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, HOST, () => {
      servers.push(srv);
      resolve(srv);
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('isPortFree', () => {
  it('reports an occupied port as not free, and a free one as free', async () => {
    // Grab an ephemeral port, learn its number, then probe it.
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const taken = addr.port;
    expect(await isPortFree(HOST, taken)).toBe(false);

    // Close it and confirm it frees up.
    await new Promise<void>((r) => srv.close(() => r()));
    servers.splice(servers.indexOf(srv), 1);
    expect(await isPortFree(HOST, taken)).toBe(true);
  });
});

describe('findFreePort', () => {
  it('returns the start port when it is free', async () => {
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const known = addr.port;
    await new Promise<void>((r) => srv.close(() => r()));
    servers.splice(servers.indexOf(srv), 1);
    expect(await findFreePort(HOST, known)).toBe(known);
  });

  it('advances past an occupied port to the next free one', async () => {
    // Occupy an ephemeral port, then ask findFreePort to start there. It must
    // skip the taken port and return a higher one.
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const taken = addr.port;
    // Start at an OS-assigned ephemeral port. Under full-suite + coverage load,
    // many parallel workers hold ephemeral sockets, so the default 200-port scan
    // window above `taken` can be entirely occupied and throw. A generous
    // maxTries makes exhaustion effectively impossible while still proving the
    // skip-occupied-port behaviour (the call returns on the first free port).
    const found = await findFreePort(HOST, taken, { maxTries: 2000 });
    expect(found).toBeGreaterThan(taken);
    expect(await isPortFree(HOST, found)).toBe(true);
  });

  it('honors the exclude set even when the port is free', async () => {
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const base = addr.port;
    await new Promise<void>((r) => srv.close(() => r()));
    servers.splice(servers.indexOf(srv), 1);
    // base is free now, but excluded → must return something else.
    const found = await findFreePort(HOST, base, { exclude: new Set([base]) });
    expect(found).not.toBe(base);
  });

  it('throws when no free port is found within maxTries', async () => {
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const taken = addr.port;
    // maxTries=1 with the only candidate occupied → no free port.
    await expect(findFreePort(HOST, taken, { maxTries: 1 })).rejects.toThrow(/No free port/);
  });
});
