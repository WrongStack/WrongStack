import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireOrJoin, MAILBOX_BRIDGE_LOCK_FILENAME } from '@wrongstack/core/coordination';
import {
  tryAcquireMailboxBridge,
  type ProbeFn,
  type SpawnFn,
} from '../src/mailbox-bridge-bootstrap.js';

/**
 * Tests for tryAcquireMailboxBridge.
 *
 * Three flows:
 *  - joined:   a live bridge already running → discover via lock + probe,
 *              return its URL/token without spawning
 *  - spawned:  no live bridge → spawn a child (mocked), wait for lock,
 *              probe, return URL/token
 *  - failed:   spawn fails or timeout exceeded → return source='failed'
 *
 * We use a real /healthz HTTP server as the "spawned" bridge so the
 * probe path runs end-to-end. We never actually run `wstack mailbox
 * serve` — instead the SpawnFn stub writes a lock file directly,
 * which is exactly what the real subcommand does after listen().
 */

let projectDir: string;
const _spawnedPid = 0;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-bootstrap-test-'));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────

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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return Object.assign(server, { port });
}

function liveProbe(): ProbeFn {
  return async (url) => {
    // Real fetch — succeeds only when something is actually listening.
    return probeViaFetch(url);
  };
}

/**
 * Real fetch-based /healthz probe, used by liveProbe(). Calls the URL
 * with a tight timeout and returns true only on a 2xx response.
 */
async function probeViaFetch(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    const res = await fetch(`${url}/healthz`, {
      signal: ctrl.signal,
      redirect: 'manual',
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function _failingProbe(): ProbeFn {
  return async () => false;
}

function makeSpawnFnWritingLock(host: string, port: number, token: string): SpawnFn {
  return async (_args, cwd) => {
    // Use the test process's own PID so `isProcessAlive` accepts the
    // lock as live — `readLiveLock` checks both PID and /healthz, and
    // a fake PID would always be stale. The host server IS this
    // test process anyway (we proxy through node:http on localhost),
    // so the lock PID matches reality.
    const lockPath = path.join(cwd, MAILBOX_BRIDGE_LOCK_FILENAME);
    const tokenPath = path.join(cwd, '.mailbox.token');
    const lock = {
      pid: process.pid,
      host,
      port,
      url: `http://${host}:${port}`,
      token,
      generation: 1,
      spawnedAt: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
    await fs.writeFile(tokenPath, token, { mode: 0o600 });
    return {
      pid: process.pid,
      unref: () => {
        /* noop — already detached from the test's perspective */
      },
    };
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('tryAcquireMailboxBridge', () => {
  it('joins a live owner via lock + probe', async () => {
    const owner = await startHealthzServer();
    try {
      // Pre-populate a live lock as if an existing owner had started.
      const ownerLock = {
        pid: process.pid,
        host: '127.0.0.1',
        port: owner.port,
        url: `http://127.0.0.1:${owner.port}`,
        token: 'a'.repeat(64),
        generation: 1,
        spawnedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(projectDir, MAILBOX_BRIDGE_LOCK_FILENAME),
        JSON.stringify(ownerLock, null, 2),
      );
      await fs.writeFile(path.join(projectDir, '.mailbox.token'), ownerLock.token, { mode: 0o600 });

      const handle = await tryAcquireMailboxBridge({
        projectDir,
        probeFn: liveProbe(),
        spawnFn: () => {
          throw new Error('spawnFn should not be called when joining');
        },
      });

      expect(handle.source).toBe('joined');
      expect(handle.url).toBe(ownerLock.url);
      expect(handle.token).toBe(ownerLock.token);
      expect(handle.childPid).toBeNull();
    } finally {
      await owner.close();
    }
  });

  it('spawns a fresh bridge when no lock exists', async () => {
    const owner = await startHealthzServer();
    try {
      const handle = await tryAcquireMailboxBridge({
        projectDir,
        probeFn: liveProbe(),
        spawnFn: makeSpawnFnWritingLock('127.0.0.1', owner.port, 'b'.repeat(64)),
      });

      expect(handle.source).toBe('spawned');
      expect(handle.url).toBe(`http://127.0.0.1:${owner.port}`);
      expect(handle.token).toBe('b'.repeat(64));
      expect(handle.childPid).not.toBeNull();
    } finally {
      await owner.close();
    }
  });

  it('returns source=unhealthy when lock exists but probe fails', async () => {
    // Pre-populate a lock with a URL the probe can't reach. The lock
    // looks "alive" by PID (process.pid = test runner) but the
    // /healthz probe can't connect — this is exactly the
    // "lock says we're up but we can't actually reach the bridge"
    // state that should map to source='unhealthy'.
    //
    // The actual probe behavior depends on the OS and the test
    // runner's network. On Windows the connection is refused
    // immediately; on Linux it may take longer. The 5s default
    // timeout is enough for both, but a fast-fail test (timeoutMs
    // 800ms) is preferable to keep the suite snappy. The check on
    // the source field is what matters.
    const ownerLock = {
      pid: process.pid,
      host: '127.0.0.1',
      port: 1,
      url: 'http://127.0.0.1:1',
      token: 'c'.repeat(64),
      generation: 1,
      spawnedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(projectDir, MAILBOX_BRIDGE_LOCK_FILENAME),
      JSON.stringify(ownerLock, null, 2),
    );

    const handle = await tryAcquireMailboxBridge({
      projectDir,
      timeoutMs: 1500,
      spawnFn: () => {
        throw new Error('spawnFn should NOT be called when joining an existing lock');
      },
    });

    // Source must be either 'unhealthy' (probe failed but we have
    // a recorded URL/token) or 'joined' (probe somehow succeeded
    // on a reserved port, unlikely but possible on a system where
    // something else listens on port 1). The important assertion
    // is that we did NOT spawn a new bridge and we did NOT time out.
    expect(['unhealthy', 'joined']).toContain(handle.source);
    if (handle.source === 'unhealthy' || handle.source === 'joined') {
      expect(handle.url).toBe(ownerLock.url);
      expect(handle.token).toBe(ownerLock.token);
    }
  });

  it('spawns a fresh bridge when the lock PID is DEAD (stale lock), not source=unhealthy', async () => {
    // Regression test for the stale-lock wedge: a bridge crashed or the
    // machine rebooted, leaving a lock file whose recorded PID is gone.
    // Previously `tryAcquireMailboxBridge` short-circuited such a lock to
    // source='unhealthy' and NEVER spawned — wedging every boot forever.
    // Now a dead PID is treated like an absent lock: we spawn a fresh
    // bridge (which internally unlinks the stale lock via acquireOrJoin).
    const owner = await startHealthzServer();
    try {
      // A PID that is reliably dead on every platform: way above any
      // realistic live PID. tasklist won't find it; process.kill(0)
      // throws ESRCH. So `isProcessAlive` returns false → stale lock
      // with pidAlive=false.
      const deadPid = 999_999;
      const staleLock = {
        pid: deadPid,
        host: '127.0.0.1',
        port: 1, // dead port — irrelevant, PID check fails first
        url: 'http://127.0.0.1:1',
        token: 'd'.repeat(64),
        generation: 3,
        spawnedAt: '2020-01-01T00:00:00.000Z',
      };
      await fs.writeFile(
        path.join(projectDir, MAILBOX_BRIDGE_LOCK_FILENAME),
        JSON.stringify(staleLock, null, 2),
      );

      let spawnCalled = false;
      const handle = await tryAcquireMailboxBridge({
        projectDir,
        timeoutMs: 2000,
        spawnFn: (...args) => {
          spawnCalled = true;
          // The real subcommand would run acquireOrJoin (unlinking the
          // stale lock) and bind a port; our stub writes a fresh live
          // lock pointing at the running healthz server, using the
          // test process PID so it reads back as live.
          return makeSpawnFnWritingLock('127.0.0.1', owner.port, 'e'.repeat(64))(...args);
        },
      });

      // The stale lock must trigger a spawn — NOT a short-circuit to
      // 'unhealthy'.
      expect(spawnCalled).toBe(true);
      expect(handle.source).toBe('spawned');
      expect(handle.url).toBe(`http://127.0.0.1:${owner.port}`);
      expect(handle.token).toBe('e'.repeat(64));
      expect(handle.childPid).not.toBeNull();
    } finally {
      await owner.close();
    }
  });

  it('returns source=failed when spawn throws', async () => {
    const handle = await tryAcquireMailboxBridge({
      projectDir,
      probeFn: liveProbe(),
      spawnFn: () => {
        throw new Error('spawn failed in test');
      },
    });
    expect(handle.source).toBe('failed');
    expect(handle.url).toBe('');
    expect(handle.token).toBe('');
  });

  it('returns source=failed when spawn succeeds but lock never appears', async () => {
    // SpawnFn that does NOT write the lock file (simulating a bridge
    // that crashes before listen succeeds).
    const noopSpawn: SpawnFn = async () => {
      return {
        pid: 12345,
        unref: () => {
          /* noop */
        },
      };
    };
    const handle = await tryAcquireMailboxBridge({
      projectDir,
      probeFn: liveProbe(),
      spawnFn: noopSpawn,
      timeoutMs: 500, // keep the test fast
    });
    expect(handle.source).toBe('failed');
    expect(handle.url).toBe('');
  });

  it('cross-project: project A and B are isolated', async () => {
    const projectB = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-bootstrap-other-'));
    try {
      const owner = await startHealthzServer();
      // Project B needs its OWN bridge on a different port — use the
      // same healthz server but expose it under a second listener on
      // owner.port + 1 so the spawn stub can write a lock claiming
      // that port and the probe can actually reach /healthz there.
      const ownerB = await startHealthzServer();
      try {
        const ownerLock = {
          pid: process.pid,
          host: '127.0.0.1',
          port: owner.port,
          url: `http://127.0.0.1:${owner.port}`,
          token: 'd'.repeat(64),
          generation: 1,
          spawnedAt: new Date().toISOString(),
        };
        await fs.writeFile(
          path.join(projectDir, MAILBOX_BRIDGE_LOCK_FILENAME),
          JSON.stringify(ownerLock, null, 2),
        );

        // Bootstrap project B — must not pick up project A's lock.
        const handleB = await tryAcquireMailboxBridge({
          projectDir: projectB,
          probeFn: liveProbe(),
          spawnFn: makeSpawnFnWritingLock('127.0.0.1', ownerB.port, 'e'.repeat(64)),
        });
        expect(handleB.source).toBe('spawned');
        expect(handleB.token).toBe('e'.repeat(64));
      } finally {
        await owner.close();
        await ownerB.close();
      }
    } finally {
      await fs.rm(projectB, { recursive: true, force: true });
    }
  });

  it('readLiveLock returns probe-failed for a tentative (un-finalized) lock', async () => {
    // acquireOrJoin writes a tentative lock with url="" — the
    // probe can't run against an empty URL, so the lock is treated
    // as live-but-unreachable. Caller (tryAcquireMailboxBridge)
    // maps this to source='unhealthy' rather than spawning a new
    // bridge, which is the whole point of distinguishing the two.
    const lock = await acquireOrJoin({
      projectDir,
      host: '127.0.0.1',
      requestedPort: null,
      strictPort: false,
    });
    expect(lock.kind).toBe('acquired');
    const { readLiveLock } = await import('@wrongstack/core/coordination');
    const result = await readLiveLock(projectDir);
    expect(result.kind).toBe('probe-failed');
    if (result.kind === 'probe-failed') {
      expect(result.lock.token).toBe(lock.lock.token);
    }
  });
});
