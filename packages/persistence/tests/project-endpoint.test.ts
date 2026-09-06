/**
 * The stale-endpoint wedge, pinned.
 *
 * These tests exist because two daemons shipped without the reclaim ladder and
 * were wedgeable by a single SIGKILL. The invariants below are the difference
 * between "recovers on its own" and "unstartable until someone reads a stack
 * trace and deletes a file in /tmp":
 *
 *   - a stale endpoint is reclaimed, not fatal
 *   - a LIVE endpoint is never reclaimed, whatever the pressure to recover
 *
 * The second matters more than the first. Unlinking a live owner's socket
 * severs every connected client and elects a second writer over the same
 * database — a worse failure than the wedge, and a silent one.
 */
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { bindProjectEndpoint, isProjectEndpointLive } from '../src/project-endpoint.js';

const isWindows = process.platform === 'win32';
const describeUnix = isWindows ? describe.skip : describe;

const servers: net.Server[] = [];
const directories: string[] = [];

function track(server: net.Server): net.Server {
  servers.push(server);
  return server;
}

async function tempEndpoint(): Promise<string> {
  // Keep the path short: `sun_path` is 104 bytes on macOS and the OS temp dir
  // already eats ~48 of them there.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wspe-'));
  directories.push(dir);
  return path.join(dir, 's.sock');
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describeUnix('bindProjectEndpoint', () => {
  it('binds a fresh endpoint and reports no reclaim', async () => {
    const endpoint = await tempEndpoint();
    const result = await bindProjectEndpoint({
      server: track(net.createServer()),
      endpoint,
      service: 'test',
    });
    expect(result).toEqual({ outcome: 'bound', reclaimedStaleEndpoint: false });
    expect(await isProjectEndpointLive(endpoint)).toBe(true);
  });

  it('creates the parent directory as an 0700 ownership boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wspe-'));
    directories.push(dir);
    const endpoint = path.join(dir, 'nested', 's.sock');
    const result = await bindProjectEndpoint({
      server: track(net.createServer()),
      endpoint,
      service: 'test',
    });
    expect(result.outcome).toBe('bound');
    const mode = (await fs.stat(path.dirname(endpoint))).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('reclaims an endpoint whose owner died without cleanup', async () => {
    const endpoint = await tempEndpoint();
    // A socket file with nothing behind it is exactly what SIGKILL leaves. A
    // plain file reproduces it: `bind()` fails EADDRINUSE on any existing path.
    await fs.writeFile(endpoint, '');
    expect(await isProjectEndpointLive(endpoint)).toBe(false);

    const result = await bindProjectEndpoint({
      server: track(net.createServer()),
      endpoint,
      service: 'test',
    });
    expect(result).toEqual({ outcome: 'bound', reclaimedStaleEndpoint: true });
    expect(await isProjectEndpointLive(endpoint)).toBe(true);
  });

  it('never reclaims a live endpoint — the loser reports already-owned', async () => {
    const endpoint = await tempEndpoint();
    const owner = track(net.createServer());
    const bound = await bindProjectEndpoint({ server: owner, endpoint, service: 'test' });
    expect(bound.outcome).toBe('bound');

    const contender = await bindProjectEndpoint({
      server: track(net.createServer()),
      endpoint,
      service: 'test',
    });
    expect(contender).toEqual({ outcome: 'already-owned' });
    // The point of the probe: the incumbent is still serving.
    expect(owner.listening).toBe(true);
    expect(await isProjectEndpointLive(endpoint)).toBe(true);
  });

  it('fails with an actionable error instead of spinning when reclaim cannot win', async () => {
    const endpoint = await tempEndpoint();
    await fs.writeFile(endpoint, '');
    // `maxAttempts: 0` starves the loop, standing in for the pathological case
    // where every reclaim is immediately re-lost to a competing contender.
    const result = await bindProjectEndpoint({
      server: track(net.createServer()),
      endpoint,
      service: 'kanban',
      maxAttempts: 0,
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.error.message).toContain('kanban');
    expect(result.error.message).toContain(endpoint);
  });

  it('reports failure rather than throwing on an over-long socket path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wspe-'));
    directories.push(dir);
    const endpoint = path.join(dir, `${'x'.repeat(200)}.sock`);
    const result = await bindProjectEndpoint({
      server: track(net.createServer()),
      endpoint,
      service: 'test',
    });
    // A throw here would land in a detached daemon whose stderr is discarded,
    // which is how this class of bug becomes a bare client-side timeout.
    expect(result.outcome).toBe('failed');
  });
});

// A named pipe has no filesystem entry, so it cannot go stale: it vanishes
// with the process holding it. EADDRINUSE there always means a live owner, and
// the election must resolve without probing or unlinking anything.
const describeWindows = isWindows ? describe : describe.skip;

describeWindows('bindProjectEndpoint on Windows named pipes', () => {
  it('binds, then reports already-owned for a second contender', async () => {
    const endpoint = `\\\\.\\pipe\\wrongstack-test-${process.pid}-${Date.now()}`;
    const owner = track(net.createServer());
    const bound = await bindProjectEndpoint({ server: owner, endpoint, service: 'test' });
    expect(bound).toEqual({ outcome: 'bound', reclaimedStaleEndpoint: false });
    expect(await isProjectEndpointLive(endpoint)).toBe(true);

    const contender = await bindProjectEndpoint({
      server: track(net.createServer()),
      endpoint,
      service: 'test',
    });
    expect(contender).toEqual({ outcome: 'already-owned' });
    expect(owner.listening).toBe(true);
  });
});

describe('isProjectEndpointLive', () => {
  it('is false for a path with no listener', async () => {
    const endpoint = isWindows
      ? `\\\\.\\pipe\\wrongstack-test-absent-${process.pid}`
      : path.join(os.tmpdir(), `wspe-absent-${process.pid}.sock`);
    expect(await isProjectEndpointLive(endpoint)).toBe(false);
  });

  it('resolves to false without throwing when endpoint is malformed or invalid', async () => {
    expect(await isProjectEndpointLive('')).toBe(false);
    expect(await isProjectEndpointLive('invalid:99999')).toBe(false);
  });
});
