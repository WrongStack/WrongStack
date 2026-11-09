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
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withFileLock } from '../src/atomic-write.js';
import {
  _projectEndpointOps,
  bindProjectEndpoint,
  isProjectEndpointLive,
  retryWhileUnauthorized,
} from '../src/project-endpoint.js';
import { resolveWstackPaths } from '../src/wstack-paths.js';

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

  it('serializes stale reclaim so a contender cannot unlink a newly bound endpoint', async () => {
    const endpoint = await tempEndpoint();
    const savedOps = { ..._projectEndpointOps };
    let owner: number | null = 0;
    let probeCount = 0;

    class Probe extends EventEmitter {
      destroy(): void {}
    }

    class Contender extends EventEmitter {
      private attempts = 0;
      constructor(private readonly id: number) {
        super();
      }
      listen(): void {
        this.attempts += 1;
        if (this.attempts === 1) {
          const error = new Error('address in use') as NodeJS.ErrnoException;
          error.code = 'EADDRINUSE';
          queueMicrotask(() => this.emit('error', error));
          return;
        }
        owner = this.id;
        queueMicrotask(() => this.emit('listening'));
      }
    }

    _projectEndpointOps.platform = 'linux';
    _projectEndpointOps.mkdir = (async () => undefined) as never;
    _projectEndpointOps.chmod = (async () => undefined) as never;
    _projectEndpointOps.stat = (async () => ({ uid: process.getuid?.() ?? 0 })) as never;
    _projectEndpointOps.rm = (async () => {
      owner = null;
    }) as never;
    _projectEndpointOps.createConnection = (() => {
      probeCount += 1;
      const probe = new Probe();
      if (owner !== null && owner !== 0) {
        queueMicrotask(() => probe.emit('connect'));
      } else {
        queueMicrotask(() =>
          probe.emit('error', Object.assign(new Error('stale'), { code: 'ECONNREFUSED' })),
        );
      }
      return probe as never;
    }) as never;

    try {
      const [first, second] = await Promise.all([
        bindProjectEndpoint({
          server: new Contender(1) as never,
          endpoint,
          service: 'test',
          maxAttempts: 2,
        }),
        bindProjectEndpoint({
          server: new Contender(2) as never,
          endpoint,
          service: 'test',
          maxAttempts: 2,
        }),
      ]);
      expect(first.outcome).toBe('bound');
      expect(second.outcome).toBe('already-owned');
      expect(probeCount).toBeGreaterThanOrEqual(2);
    } finally {
      Object.assign(_projectEndpointOps, savedOps);
    }
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

// Regression for G1 (DIP-002/DIP-003): endpoint names are derived from
// the project path, so they are fully predictable; without a 0o700 +
// ownership check on the parent directory, a same-host squatter can
// pre-bind the name and the real daemon concludes "a live owner
// exists" — then hands its IPC token to the squatter. The new check
// forces a chmod AND refuses to start when the directory is owned by
// another uid, breaking the squatter's listen path and the silent
// client-handoff.
describe('bindProjectEndpoint — G1 ownership/mode enforcement', () => {
  let savedOps: typeof _projectEndpointOps;
  beforeEach(() => {
    savedOps = { ..._projectEndpointOps };
  });
  afterEach(() => {
    Object.assign(_projectEndpointOps, savedOps);
  });

  it('forces chmod 0o700 on the parent directory even if it pre-exists', async () => {
    _projectEndpointOps.platform = 'linux';
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'g1-chmod-'));
    try {
      const dir = path.join(tmpDir, 'ep');
      await fs.mkdir(dir, { recursive: true, mode: 0o755 });
      // Pre-existing dir was 0755 — must be tightened by ensureDir.
      _projectEndpointOps.chmod = vi.fn(async (p: string, mode: number) => {
        if (p === dir) expect(mode).toBe(0o700);
      }) as any;
      _projectEndpointOps.stat = vi.fn(async (p: string) => {
        const st = await fs.stat(p);
        return st as any;
      }) as any;

      const fakeServer = new EventEmitter() as any;
      fakeServer.listen = vi.fn(() => {
        setTimeout(() => fakeServer.emit('listening'), 2);
      });
      const res = await bindProjectEndpoint({
        server: fakeServer,
        endpoint: path.join(dir, 'test.sock'),
        service: 'test',
      });
      expect(res.outcome).toBe('bound');
      expect(_projectEndpointOps.chmod).toHaveBeenCalledWith(dir, 0o700);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects an empty endpoint on win32 before calling server.listen (F142)', async () => {
    _projectEndpointOps.platform = 'win32';
    const fakeServer = new EventEmitter() as any;
    fakeServer.listen = vi.fn(() => {
      setTimeout(() => fakeServer.emit('listening'), 2);
    });
    const res = await bindProjectEndpoint({
      server: fakeServer,
      endpoint: '',
      service: 'test',
    });
    expect(res.outcome).toBe('failed');
    expect(fakeServer.listen).not.toHaveBeenCalled();
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

  it('normalizes non-finite retry/lock bounds and resolves relative WstackPaths roots (F684)', async () => {
    let calls = 0;
    await expect(
      retryWhileUnauthorized(
        async () => {
          calls++;
          throw new Error('unauthorized');
        },
        (err) => err instanceof Error && err.message === 'unauthorized',
        { attempts: Number.NaN, delayMs: 0 },
      ),
    ).rejects.toThrow(/unauthorized/);
    expect(calls).toBe(14);

    const relPaths = resolveWstackPaths({ projectRoot: '.', globalRoot: './.tmp-global' });
    expect(path.isAbsolute(relPaths.projectRoot)).toBe(true);
    expect(path.isAbsolute(relPaths.inProjectConfig)).toBe(true);
    expect(path.isAbsolute(relPaths.globalRoot)).toBe(true);
    const paddedPaths = resolveWstackPaths({ projectRoot: `  ${process.cwd()}  ` });
    expect(paddedPaths.projectRoot).toBe(path.resolve(process.cwd()));
    expect(await isProjectEndpointLive('', Number.NaN)).toBe(false);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'f684-lock-'));
    try {
      const targetFile = path.join(tmpDir, 'data.json');
      const lockFile = path.join(tmpDir, '.data.json.lock');
      await fs.writeFile(lockFile, `${process.pid}:held-token`, 'utf8');
      await expect(
        withFileLock(targetFile, async () => 'acquired', {
          timeoutMs: 20,
          staleMs: -1,
        }),
      ).rejects.toThrow(/Timed out waiting for file lock/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
