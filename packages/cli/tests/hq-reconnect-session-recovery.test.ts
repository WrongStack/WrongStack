/**
 * End-to-end: a terminal must not vanish from HQ when its socket blips.
 *
 * HQ holds a client's sessions in a map on the SOCKET. A reconnect registers a
 * fresh `ConnectedClient` with that map empty, and the session bridge dedups on
 * content — so a terminal that was simply idle stayed absent from every
 * snapshot until the 4-minute keep-alive fired. On the fleet map that reads as
 * the node blinking out and coming back minutes later.
 *
 * This exercises the real server, a real publisher and the real bridge,
 * because the bug lived in the seam between them: each piece was individually
 * correct.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqSnapshot } from '@wrongstack/core/hq';
import {
  HQ_AUTH_FILE_VERSION,
  startSessionTelemetryBridge,
  writeHqAuthFile,
} from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createCliHqPublisher } from '../src/hq-publisher.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let dataDir: string;
let projectRoot: string;
let globalRoot: string;
let handle: HqServerHandle | undefined;
let stopBridge: (() => void) | undefined;
let publisherClose: (() => void) | undefined;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-recon-data-'));
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-recon-proj-'));
  globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-recon-global-'));
});

afterEach(async () => {
  stopBridge?.();
  stopBridge = undefined;
  publisherClose?.();
  publisherClose = undefined;
  await handle?.close();
  handle = undefined;
  for (const dir of [dataDir, projectRoot, globalRoot]) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function port(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

async function snapshot(): Promise<HqSnapshot> {
  const res = await fetch(`http://127.0.0.1:${handle!.port}/api/snapshot`);
  return (await res.json()) as HqSnapshot;
}

describe('HQ reconnect session recovery', () => {
  it('re-announces the session immediately after the socket drops', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [],
    });
    handle = await startHqServer({ host: '127.0.0.1', port: port(), dataDir });

    // Keep a handle on every socket the publisher dials so the test can drop
    // one the way a network blip would — `publisher.close()` would stop it for
    // good instead.
    const sockets: WebSocket[] = [];
    const publisher = createCliHqPublisher({
      clientKind: 'tui',
      projectRoot,
      projectName: 'demo',
      config: { url: `http://127.0.0.1:${handle.port}`, enabled: true },
      capabilities: ['telemetry.publish', 'session.summary'],
      socketFactory: (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket as never;
      },
    });
    expect(publisher).toBeDefined();
    publisherClose = () => publisher?.close();
    publisher?.connect();

    const sessionId = '2026-09-05/12-00-00Z_reconnect';
    stopBridge = startSessionTelemetryBridge({
      publisher: publisher!,
      sessionId,
      projectRoot,
      projectName: 'demo',
      globalRoot,
      startedAt: new Date().toISOString(),
      // Long intervals on purpose: nothing but the reconnect hook may be what
      // brings the session back. With the keep-alive in play the test would
      // pass even with the fix reverted.
      snapshotIntervalMs: 60_000,
      transcriptIntervalMs: 60_000,
    });

    await expect
      .poll(async () => (await snapshot()).liveSessions?.map((s) => s.sessionId) ?? [], {
        timeout: 5_000,
      })
      .toEqual([sessionId]);
    const clientIdBefore = (await snapshot()).clients[0]?.clientId;

    // Drop the live socket without telling the publisher to stop.
    sockets.at(-1)?.terminate();

    // Wait for the re-dial first: polling the snapshot straight away can
    // observe the pre-drop state and pass without proving anything.
    await expect.poll(() => sockets.length, { timeout: 10_000 }).toBeGreaterThan(1);

    await expect
      .poll(
        async () => {
          const current = await snapshot();
          return {
            sessions: current.liveSessions?.map((session) => session.sessionId) ?? [],
            clients: current.clients.map((client) => client.clientId),
          };
        },
        { timeout: 10_000 },
      )
      .toEqual({
        sessions: [sessionId],
        // Same publisher identity: a reconnect must not read as a new terminal
        // joining the fleet next to a ghost of the old one.
        clients: [clientIdBefore],
      });
  }, 30_000);
});
