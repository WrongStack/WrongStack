import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailboxProjectServerConnection } from '../../src/coordination/mailbox-project-server-client.js';

/**
 * Regression: `connectWithElection` spawned the detached daemon exactly once
 * per connect window, so a first spawn that died before binding its endpoint
 * (crash pre-bind, or a silent spawn-level error under load) was fatal for the
 * whole `SERVER_START_TIMEOUT_MS` window — every remaining retry hit
 * `connect ENOENT` against a pipe nothing would ever create, and the caller
 * saw that raw error. Observed as a flaky failure of the "elects one owner"
 * test under full-suite load (2026-09-07).
 *
 * The fix re-arms the spawn on `SPAWN_RETRY_CADENCE_MS` inside the retry
 * loop. This test injects the transient fault deterministically: the FIRST
 * `child_process.spawn` call returns a daemon that never binds; later calls
 * delegate to the real spawn so recovery must come from the production retry
 * loop re-arming the spawn — the real dist daemon has to come up and answer
 * an authenticated ping within the window.
 */
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

let projectDir: string;

beforeEach(async () => {
  spawnState.calls = 0;
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-respawn-regression-'));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
});

describe('mailbox project server client respawn', () => {
  it('re-arms the detached daemon after a dead first spawn and completes an authenticated ping', async () => {
    const connection = new MailboxProjectServerConnection(projectDir);
    const control = new MailboxProjectServerConnection(projectDir);
    try {
      const status = await connection.call('ping', {}, { timeoutMs: 20_000 });
      expect(status.pid).toBeGreaterThan(0);
      // Recovery must have re-armed the spawn — a deadline stretch alone
      // would still see exactly one spawn attempt and fail here.
      expect(spawnState.calls).toBeGreaterThanOrEqual(2);
    } finally {
      await control.shutdown('mailbox-respawn-regression-complete').catch(() => undefined);
      control.close();
      connection.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 45_000);
});
