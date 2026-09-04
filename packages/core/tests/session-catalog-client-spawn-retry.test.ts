/**
 * Regression (bug-hunt round 18): `SessionCatalogProjectClient.connectWithElection`
 * runs a 10s deadline loop whose purpose is to absorb transient spawn
 * unavailability — but `spawnDetached`'s throw when the built artifact is
 * momentarily absent (a concurrent workspace rebuild re-emitting
 * `packages/core/dist/session-catalog/project-server.js`) used to escape the
 * loop uncaught, rejecting the call instantly instead of retrying. That made
 * `ProjectSessionRegistry.register` — and every test that seeds through it —
 * fail spuriously under full-suite load (hq-mailbox-mutation flake).
 *
 * The loop now records the spawn failure as `lastError` and retries until the
 * deadline, so a transiently-missing artifact is absorbed and a genuinely
 * broken build still fails (with the same message) once the window elapses.
 *
 * This test hides the dist artifact for exactly the FIRST spawn attempt by
 * scoping a `node:fs` `existsSync` mock to the dist candidate path — no real
 * file is renamed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const existsState = vi.hoisted(() => ({
  actual: null as null | ((filePath: string) => boolean),
  hideDistProjectServer: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  existsState.actual = (filePath: string) => actual.existsSync(filePath);
  return {
    ...actual,
    existsSync: vi.fn(((filePath: Parameters<typeof actual.existsSync>[0]) => {
      const p = String(filePath);
      if (
        existsState.hideDistProjectServer &&
        p.includes('project-server.js') &&
        p.includes('dist')
      ) {
        return false;
      }
      return existsState.actual!(p);
    }) as typeof actual.existsSync),
  };
});

import * as fs from 'node:fs';
import { SessionCatalogProjectClient } from '../src/session-catalog/client.js';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from '../src/session-catalog/endpoint.js';
import {
  connectFrame,
  makeTempRoot,
  waitForEndpointClosed,
  waitForMetadataFile,
  waitForMetadataRemoval,
} from './helpers/project-server-harness.js';

describe('SessionCatalogProjectClient spawn retry', () => {
  afterEach(() => {
    existsState.hideDistProjectServer = false;
    vi.restoreAllMocks();
  });

  it('retries the spawn when the built artifact is transiently missing', async () => {
    const fixture = await makeTempRoot('session-catalog-spawn-retry');
    const metadataPath = sessionCatalogProjectServerMetadataPath(fixture.root);
    const endpoint = sessionCatalogProjectServerEndpoint(fixture.root);

    // First probe of the dist artifact: absent (mid-rebuild). Every later
    // probe sees the re-emitted file.
    let distProbes = 0;
    vi.mocked(fs.existsSync).mockImplementation(((filePath: string) => {
      const p = String(filePath);
      if (p.includes('dist') && p.includes('project-server.js')) {
        distProbes += 1;
        if (distProbes === 1) return false;
      }
      return existsState.actual!(p);
    }) as typeof fs.existsSync);

    const client = new SessionCatalogProjectClient({
      projectDir: fixture.root,
      projectRoot: fixture.root,
    });
    try {
      // The first spawn attempt throws; the deadline loop must retry the
      // spawn and land on the re-emitted artifact instead of rejecting.
      const ping = await client.ping();
      expect(ping).toMatchObject({ catalogRows: expect.any(Number) });
      expect(distProbes, 'spawn must have been retried after the transient absence').toBe(2);
    } finally {
      existsState.hideDistProjectServer = false;
    }

    // Deterministic teardown of the spawned detached server (harness pattern
    // from session-catalog-project-server.test.ts).
    const metadata = await waitForMetadataFile<{ authToken: string }>(metadataPath);
    const raw = await connectFrame(endpoint);
    // The server greets on connect; consume the hello frame before the
    // shutdown request (same frame order the harness tests pin).
    expect((await raw.nextFrame()).type).toBe('hello');
    raw.socket.write(
      `${JSON.stringify({ type: 'shutdown', id: 99, reason: 'test', authToken: metadata.authToken })}\n`,
    );
    expect(await raw.nextFrame()).toMatchObject({ type: 'response', id: 99, ok: true });
    raw.socket.destroy();
    await waitForMetadataRemoval(metadataPath);
    await waitForEndpointClosed(endpoint);
    await fixture.release();
  });
});
