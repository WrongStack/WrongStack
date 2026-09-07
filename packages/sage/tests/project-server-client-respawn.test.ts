import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SageProjectServerConnection } from '../src/project-server-client.js';

/**
 * Regression (2026-09-07, sibling of the mailbox `connectWithElection` fix):
 * the client spawned the detached daemon exactly once per connect window, so
 * a first spawn that died before binding its endpoint was fatal for the whole
 * `SERVER_START_TIMEOUT_MS` window — every remaining retry hit
 * `connect ENOENT` against a pipe nothing would ever create, and the caller
 * saw that raw error. The fix re-arms the spawn on `SPAWN_RETRY_CADENCE_MS`.
 *
 * The fault is injected deterministically: the FIRST `child_process.spawn`
 * call returns a child that never binds; later calls delegate to the real
 * spawn, so recovery must come from the production retry loop re-arming the
 * spawn and the real dist daemon must complete the IPC handshake.
 *
 * The client class is loaded from the built package — the spawn resolver only
 * resolves `./project-server.js` relative to a built module — so the suite
 * skips when `dist/` has not been built (same convention as
 * `project-server-auth-gate.test.ts`).
 */

const sageDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const distReady =
  fs.existsSync(path.join(sageDistDir, 'index.js')) &&
  fs.existsSync(path.join(sageDistDir, 'project-server.js'));

const spawnState = vi.hoisted(() => ({ calls: 0 }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (...args: Parameters<typeof actual.spawn>): ReturnType<typeof actual.spawn> => {
    spawnState.calls += 1;
    if (spawnState.calls === 1) {
      // A dead-on-arrival daemon: no bind, no events, just the unref() the
      // client calls. Nothing will ever listen on the pipe after this.
      const fake = new EventEmitter() as unknown as ReturnType<typeof actual.spawn>;
      (fake as unknown as { unref: () => void }).unref = () => undefined;
      return fake;
    }
    return actual.spawn(...args);
  };
  return { ...actual, spawn };
});

let projectRoot: string;

beforeEach(async () => {
  spawnState.calls = 0;
  projectRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sage-respawn-regression-'));
});

afterEach(async () => {
  await fs.promises.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(!distReady)('sage project server client respawn', () => {
  it('re-arms the detached daemon after a dead first spawn and completes the IPC connect', async () => {
    const dist = (await import(pathToFileURL(path.join(sageDistDir, 'index.js')).href)) as {
      SageProjectServerConnection: typeof SageProjectServerConnection;
    };
    const connection = new dist.SageProjectServerConnection(projectRoot);
    const control = new dist.SageProjectServerConnection(projectRoot);
    try {
      await connection.connect();
      const state = connection.getState();
      expect(state.connected).toBe(true);
      expect(state.pid).toBeGreaterThan(0);
      // Recovery must have re-armed the spawn — a deadline stretch alone
      // would still see exactly one spawn attempt and fail here.
      expect(spawnState.calls).toBeGreaterThanOrEqual(2);
    } finally {
      await control.shutdown('sage-respawn-regression-complete').catch(() => undefined);
      control.close();
      connection.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 45_000);
});
