/**
 * Regression (probe-path bounded wait) for
 * `SessionCatalogProjectClient.connectWithElection(spawnIfMissing=false)`.
 *
 * That branch computes a `CONNECT_TIMEOUT_MS` deadline at the top of the loop
 * and then `break`ed on the FIRST connect failure, so the deadline was dead
 * code: every `callExisting()` probe failed instantly. On Windows a named pipe
 * that is not bound *yet* surfaces as `connect ENOENT`, so a probe racing a
 * daemon's bind died on the first attempt even though the owner was alive and
 * about to answer.
 *
 * The branch now breaks only when no live process owns the endpoint, decided
 * from the metadata `pid`. These tests pin BOTH halves of that contract, which
 * is what makes them meaningful — a test that only asserted "it waits" would
 * also pass if the wait were unconditional, and an unconditional wait would
 * stall cross-project discovery (which probes every known project) on every
 * absent daemon.
 *
 * Timing is used as the discriminator because the two outcomes are far apart
 * by construction: a single failed connect is a few milliseconds, while the
 * bounded window is CONNECT_TIMEOUT_MS (750ms) of ~75ms retries.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionCatalogProjectClient } from '../src/session-catalog/client.js';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from '../src/session-catalog/endpoint.js';
import { isPidAlive } from '../src/utils/pid.js';

/** No OS allocates this pid, so `process.kill(pid, 0)` answers ESRCH: dead. */
const DEAD_PID = 2_147_483_647;
/** Above `delay(75)` cadence, far below the 750ms bounded window. */
const FAST_FAIL_MS = 300;

function makeProjectDir(): string {
  // A fresh directory yields a unique endpoint hash (sha256 of the path), so
  // nothing can be bound on it and every connect fails the same way.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-catalog-probe-'));
}

function writeMetadataPid(projectDir: string, pid: number): void {
  fs.writeFileSync(
    sessionCatalogProjectServerMetadataPath(projectDir),
    JSON.stringify({
      protocolVersion: 1,
      pid,
      projectDir,
      projectRoot: projectDir,
      endpoint: sessionCatalogProjectServerEndpoint(projectDir),
      databasePath: path.join(projectDir, 'sessions', 'catalog.sqlite'),
      instanceId: 'probe-wait-test',
      startedAt: new Date(0).toISOString(),
      authToken: 'a'.repeat(64),
    }),
  );
}

async function probe(projectDir: string): Promise<{ elapsedMs: number; error: unknown }> {
  const client = new SessionCatalogProjectClient({ projectDir, projectRoot: projectDir });
  const startedAt = Date.now();
  let error: unknown = null;
  try {
    await client.callExisting('list_live', {});
  } catch (err) {
    error = err;
  }
  await client.close().catch(() => undefined);
  return { elapsedMs: Date.now() - startedAt, error };
}

describe('SessionCatalogProjectClient probe-path bounded wait', () => {
  it('fails a metadata-absent probe immediately rather than waiting', async () => {
    const projectDir = makeProjectDir();

    const { elapsedMs, error } = await probe(projectDir);

    // The case that must NOT regress: no metadata means "no daemon, or one
    // still pre-bind" and the probe has to stay fast for both.
    expect(elapsedMs).toBeLessThan(FAST_FAIL_MS);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/connect ENOENT|ECONNREFUSED|not bound|unavailable/i);
  });

  it('still fails immediately when the recorded owner pid is dead', async () => {
    // Guards the other direction: presence of metadata is not the gate. A
    // crashed daemon leaves metadata behind, and waiting on it would turn a
    // fast failure into a 750ms stall for every project that has ever run.
    expect(isPidAlive(DEAD_PID)).toBe(false);
    const projectDir = makeProjectDir();
    writeMetadataPid(projectDir, DEAD_PID);

    const { elapsedMs, error } = await probe(projectDir);

    expect(elapsedMs).toBeLessThan(FAST_FAIL_MS);
    expect(error).toBeInstanceOf(Error);
  });

  it('waits the bounded window when a live process still owns the endpoint', async () => {
    // This test's own pid is the live owner, so liveness is deterministic and
    // no process has to be spawned or reaped.
    const projectDir = makeProjectDir();
    writeMetadataPid(projectDir, process.pid);

    const { elapsedMs, error } = await probe(projectDir);

    // The deadline that used to be dead code is now actually honoured...
    expect(elapsedMs).toBeGreaterThanOrEqual(600);
    // ...and it is still bounded: it gives up instead of blocking forever.
    expect(elapsedMs).toBeLessThan(3_000);
    expect(error).toBeInstanceOf(Error);
  });
});
