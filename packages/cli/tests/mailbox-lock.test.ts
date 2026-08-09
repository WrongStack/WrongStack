import * as fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireOrJoin,
  finalize,
  type MailboxBridgeLock,
  release,
} from '@wrongstack/core/coordination';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Tests for the single-instance mailbox-bridge lock.
 *
 * Covers:
 *  - acquire creates the lock atomically
 *  - generation increments on every acquire
 *  - re-acquiring while alive joins (URL/token reuse)
 *  - stale PID detection (dead PID → treated as free)
 *  - port-conflict when caller requests a port different from the live owner
 *  - finalize writes the bound port
 *  - release is generation-checked
 *  - cross-project isolation (different projectDir → different lock)
 *  - malformed lock is cleaned up
 *  - integration: spawn a tiny /healthz server, lock+probe real path
 */

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-lock-test-'));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe('acquireOrJoin', () => {
  it('creates a lock atomically on first acquire', async () => {
    const result = await acquireOrJoin({
      projectDir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(result.kind).toBe('acquired');
    if (result.kind !== 'acquired') return;

    // Lock file exists with the right shape.
    const raw = await fs.readFile(path.join(projectDir, '.mailbox-bridge.lock'), 'utf-8');
    const lock = JSON.parse(raw) as MailboxBridgeLock;
    expect(lock.pid).toBe(process.pid);
    expect(lock.host).toBe('127.0.0.1');
    expect(lock.token).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.generation).toBe(1);
    expect(lock.url).toBe(''); // empty until finalize() is called
  });

  it('fresh acquire (no prior lock) starts at generation 1', async () => {
    const result = await acquireOrJoin({
      projectDir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(result.kind).toBe('acquired');
    if (result.kind !== 'acquired') return;
    expect(result.lock.generation).toBe(1);
  });

  it('finalize() writes the bound port into the lock', async () => {
    const acq = await acquireOrJoin({
      projectDir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    if (acq.kind !== 'acquired') throw new Error('expected acquired');
    const finalized = await finalize(projectDir, acq.lock, 12345);

    expect(finalized.port).toBe(12345);
    expect(finalized.url).toBe('http://127.0.0.1:12345');

    const raw = await fs.readFile(path.join(projectDir, '.mailbox-bridge.lock'), 'utf-8');
    const persisted = JSON.parse(raw) as MailboxBridgeLock;
    expect(persisted.port).toBe(12345);
    expect(persisted.url).toBe('http://127.0.0.1:12345');

    // Token file is also written with the same token.
    const tokenFile = await fs.readFile(path.join(projectDir, '.mailbox.token'), 'utf-8');
    expect(tokenFile).toBe(finalized.token);
  });

  it('release() removes the lock + token when generation matches', async () => {
    const acq = await acquireOrJoin({
      projectDir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    if (acq.kind !== 'acquired') throw new Error('expected acquired');
    await finalize(projectDir, acq.lock, 11111);
    await release(projectDir, acq.lock.generation);

    await expect(fs.access(path.join(projectDir, '.mailbox-bridge.lock'))).rejects.toThrow();
    await expect(fs.access(path.join(projectDir, '.mailbox.token'))).rejects.toThrow();
  });

  it('release() leaves a foreign-generation lock alone', async () => {
    const acq = await acquireOrJoin({
      projectDir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    if (acq.kind !== 'acquired') throw new Error('expected acquired');
    await finalize(projectDir, acq.lock, 22222);

    // Pretend someone else took over with a higher generation — write
    // a new lock directly.
    await fs.writeFile(
      path.join(projectDir, '.mailbox-bridge.lock'),
      JSON.stringify({ ...acq.lock, generation: 99, pid: 99999 }, null, 2),
      'utf-8',
    );
    await release(projectDir, acq.lock.generation); // our generation, now stale

    // The foreign lock survived.
    const raw = await fs.readFile(path.join(projectDir, '.mailbox-bridge.lock'), 'utf-8');
    const persisted = JSON.parse(raw) as MailboxBridgeLock;
    expect(persisted.generation).toBe(99);
  });

  it('treats a malformed lock as stale and acquires fresh', async () => {
    await fs.writeFile(
      path.join(projectDir, '.mailbox-bridge.lock'),
      '{ this is not json',
      'utf-8',
    );
    const result = await acquireOrJoin({
      projectDir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(result.kind).toBe('acquired');
    if (result.kind !== 'acquired') return;
    // New lock overwrote the malformed one.
    const raw = await fs.readFile(path.join(projectDir, '.mailbox-bridge.lock'), 'utf-8');
    const lock = JSON.parse(raw) as MailboxBridgeLock;
    expect(lock.generation).toBe(1);
  });

  it('treats a dead PID lock as stale and acquires fresh', async () => {
    // Spawn + kill a child to get a known-dead PID. PID numbers are
    // recycled but Windows / Linux usually pick much higher PIDs for
    // test processes; use a very high fake PID that almost certainly
    // doesn't exist.
    const deadPid = 999_999_999;
    await fs.writeFile(
      path.join(projectDir, '.mailbox-bridge.lock'),
      JSON.stringify(
        {
          pid: deadPid,
          host: '127.0.0.1',
          port: 0,
          url: '',
          token: 'a'.repeat(64),
          generation: 1,
          spawnedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf-8',
    );
    const result = await acquireOrJoin({
      projectDir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(result.kind).toBe('acquired');
    if (result.kind !== 'acquired') return;
    // Note: due to pid-reuse risk on busy CI runners, the live-PID
    // detection uses both process.kill(pid, 0) AND a /healthz probe.
    // The probe fails because the URL points to "" (never finalized),
    // so the lock is treated as stale.
    expect(result.lock.generation).toBeGreaterThanOrEqual(2);
  });

  it('joins a live owner when called a second time', async () => {
    // Start a tiny /healthz HTTP server to simulate a live owner.
    const owner = await startHealthzServer();
    try {
      const ownerLock: MailboxBridgeLock = {
        pid: process.pid,
        host: '127.0.0.1',
        port: owner.port,
        url: `http://127.0.0.1:${owner.port}`,
        token: 'b'.repeat(64),
        generation: 1,
        spawnedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(projectDir, '.mailbox-bridge.lock'),
        JSON.stringify(ownerLock, null, 2),
        'utf-8',
      );
      await fs.writeFile(path.join(projectDir, '.mailbox.token'), ownerLock.token, { mode: 0o600 });

      const result = await acquireOrJoin({
        projectDir,
        host: '127.0.0.1',
        requestedPort: null,
        strictPort: false,
      });
      expect(result.kind).toBe('joined');
      if (result.kind !== 'joined') return;
      expect(result.lock.url).toBe(ownerLock.url);
      expect(result.lock.token).toBe(ownerLock.token);
      expect(result.lock.generation).toBe(ownerLock.generation);
    } finally {
      await owner.close();
    }
  });

  it('returns port-conflict when caller wants port != live owner port', async () => {
    const owner = await startHealthzServer();
    try {
      const ownerLock: MailboxBridgeLock = {
        pid: process.pid,
        host: '127.0.0.1',
        port: owner.port,
        url: `http://127.0.0.1:${owner.port}`,
        token: 'c'.repeat(64),
        generation: 1,
        spawnedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(projectDir, '.mailbox-bridge.lock'),
        JSON.stringify(ownerLock, null, 2),
        'utf-8',
      );

      const result = await acquireOrJoin({
        projectDir,
        host: '127.0.0.1',
        requestedPort: owner.port + 1, // different from owner's port
        strictPort: true,
      });
      expect(result.kind).toBe('port-conflict');
      if (result.kind !== 'port-conflict') return;
      expect(result.existing.port).toBe(owner.port);
    } finally {
      await owner.close();
    }
  });

  it('isolates two projects — lock in A does not affect acquire in B', async () => {
    const otherProject = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-lock-other-'));
    try {
      const a = await acquireOrJoin({
        projectDir,
        host: '127.0.0.1',
        requestedPort: null,
        strictPort: false,
      });
      if (a.kind !== 'acquired') throw new Error('A expected acquired');

      const b = await acquireOrJoin({
        projectDir: otherProject,
        host: '127.0.0.1',
        requestedPort: null,
        strictPort: false,
      });
      expect(b.kind).toBe('acquired');
      if (b.kind !== 'acquired') return;
      // Two different locks, two different tokens, two different
      // projectDir-scoped files.
      expect(a.lock.token).not.toBe(b.lock.token);
      expect(a.lock.generation).toBe(1);
      expect(b.lock.generation).toBe(1);
    } finally {
      await fs.rm(otherProject, { recursive: true, force: true });
    }
  });
});

// ── Helpers ────────────────────────────────────────────────────────────

/** Spin up a tiny HTTP server that answers 200 OK on /healthz. */
async function startHealthzServer(): Promise<Server & { port: number }> {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return Object.assign(server, { port });
}
