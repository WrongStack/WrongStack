/**
 * Session Catalog shutdown answers in-flight requests instead of stranding
 * them.
 *
 * `stop()` used to destroy client sockets while dispatches were still running:
 * an in-flight caller saw nothing but a bare connection close (its response
 * can no longer be written once the socket is destroyed) and hung until its
 * own call timeout, while `store.close()` closed SQLite under the live
 * operation. The deterministic hold: seed a session with an inflated summary
 * so `rename`'s `atomicWrite` spans tens of milliseconds, then confirm the
 * dispatch is in flight on the wire via `ping`'s `activeRequests` BEFORE
 * requesting shutdown.
 *
 * Delivery note: the stopping rejection is flushed with `socket.end()` (not
 * write-then-destroy) — a write immediately followed by destroy() loses the
 * pending bytes on Windows named pipes.
 */
import * as fs from 'node:fs/promises';
import type * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from '../src/session-catalog/endpoint.js';
import {
  connectFrame,
  importDaemonInstance,
  makeTempRoot,
  waitForEndpointClosed,
  waitForMetadataFile,
} from './helpers/project-server-harness.js';

type Frame = Record<string, unknown>;

/** Pull every frame once, recording the FIRST response per id and all frames. */
function makeCollector(client: {
  socket: net.Socket;
  nextFrame: (timeout?: number) => Promise<Frame>;
}) {
  const first = new Map<number, Frame>();
  const all = new Map<number, Frame[]>();
  let closed = false;
  const waiters: Array<() => void> = [];
  const release = (): void => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  void (async () => {
    try {
      for (;;) {
        const frame = await client.nextFrame(15_000);
        if (frame.type === 'response' && typeof frame.id === 'number') {
          if (!first.has(frame.id)) first.set(frame.id, frame);
          const list = all.get(frame.id);
          if (list) list.push(frame);
          else all.set(frame.id, [frame]);
          release();
        }
      }
    } catch {
      closed = true;
      release();
    }
  })();
  return {
    first: (id: number): Frame | undefined => first.get(id),
    framesOf: (id: number): Frame[] => all.get(id) ?? [],
    async waitFor(settled: () => boolean, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (settled()) return;
        if (closed) throw new Error('connection closed before the expected frames arrived');
        if (Date.now() > deadline) throw new Error('timed out waiting for frames');
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

/** Read `health.activeRequests` off a ping response frame, 0 when absent. */
function readActiveRequests(frame: Frame | undefined): number {
  const result = frame?.result;
  if (typeof result !== 'object' || result === null) return 0;
  const active = (result as { activeRequests?: unknown }).activeRequests;
  return typeof active === 'number' ? active : 0;
}

type Harness = {
  root: string;
  client: ReturnType<typeof connectFrame> extends Promise<infer T> ? T : never;
  collector: ReturnType<typeof makeCollector>;
  send: (frame: Record<string, unknown>) => void;
};

async function startDaemon(caseSeed: number): Promise<Harness> {
  const fixture = await makeTempRoot('session-catalog-stop-drain');
  const endpoint = sessionCatalogProjectServerEndpoint(fixture.root);
  const metadataPath = sessionCatalogProjectServerMetadataPath(fixture.root);
  const previousIdle = process.env['WRONGSTACK_SESSION_CATALOG_IDLE_MS'];
  process.env['WRONGSTACK_SESSION_CATALOG_IDLE_MS'] = '60000';
  try {
    await importDaemonInstance(
      '../../src/session-catalog/project-server.ts',
      ['--project-dir', fixture.root, '--project-root', fixture.root],
      caseSeed,
    );
  } finally {
    if (previousIdle === undefined) delete process.env['WRONGSTACK_SESSION_CATALOG_IDLE_MS'];
    else process.env['WRONGSTACK_SESSION_CATALOG_IDLE_MS'] = previousIdle;
  }
  await waitForMetadataFile<{ authToken: string }>(metadataPath);
  const client = await connectFrame(endpoint);
  expect((await client.nextFrame()).type).toBe('hello');
  const collector = makeCollector(client);
  const send = (frame: Record<string, unknown>): void => {
    client.socket.write(`${JSON.stringify(frame)}\n`);
  };
  return { root: fixture.root, client, collector, send };
}

describe('Session Catalog shutdown answers in-flight requests', () => {
  it('rejects an in-flight rename cleanly before the connection closes', async () => {
    const { root, client, collector, send } = await startDaemon(Date.now());
    try {
      const auth = (
        await waitForMetadataFile<{ authToken: string }>(
          sessionCatalogProjectServerMetadataPath(root),
        )
      ).authToken;
      const request = (id: number, op: string, args: Record<string, unknown>): void =>
        send({ type: 'request', id, op, args, authToken: auth });

      // Seed: one live session plus its summary row, with an inflated title so
      // the rename's atomicWrite holds the dispatch for tens of milliseconds.
      request(1, 'claim_new', {
        entry: {
          sessionId: 'stop-drain-session',
          projectSlug: 'stop-drain',
          projectRoot: root,
          projectName: 'stop-drain',
          workingDir: root,
          clientType: 'test',
          status: 'live',
          pid: process.pid,
          startedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
          agentCount: 0,
        },
        ownerInstanceId: 'stop-drain-owner',
        leaseMs: 60_000,
      });
      await collector.waitFor(() => collector.first(1) !== undefined, 30_000);
      expect(collector.first(1)?.ok).toBe(true);

      request(2, 'upsert_summary', {
        summary: {
          id: 'stop-drain-session',
          title: 'x'.repeat(512 * 1024),
          startedAt: new Date().toISOString(),
          model: 'stop-drain-model',
          provider: 'stop-drain-provider',
          tokenTotal: 0,
        },
        transcriptRelativePath: 'stop-drain-session.jsonl',
        summaryRelativePath: 'stop-drain-session.summary.json',
        storageState: 'hot',
      });
      await collector.waitFor(() => collector.first(2) !== undefined, 60_000);
      expect(collector.first(2)?.ok).toBe(true);

      // Rename, then confirm in flight on the wire: ping health must report
      // BOTH the rename and the ping (activeRequests >= 2) before shutdown.
      let renameId: number | undefined;
      let pingId = 100;
      for (let attempt = 0; attempt < 20 && renameId === undefined; attempt++) {
        const candidate = 10 + attempt;
        request(candidate, 'rename', {
          sessionId: 'stop-drain-session',
          name: `renamed-${attempt}`,
        });
        for (let poll = 0; poll < 20 && renameId === undefined; poll++) {
          const id = pingId++;
          request(id, 'ping', {});
          await collector.waitFor(() => collector.first(id) !== undefined, 10_000);
          const ping = collector.first(id);
          expect(ping?.ok).toBe(true);
          if (readActiveRequests(ping) >= 2) {
            renameId = candidate;
          } else if (collector.first(candidate)) {
            break; // settled before the poll saw it — try a fresh rename
          }
        }
      }
      expect(renameId).toBeDefined();

      // Shutdown ONLY after the in-flight confirmation.
      send({ type: 'shutdown', id: 200, reason: 'test', authToken: auth });
      await collector
        .waitFor(
          () => collector.first(200) !== undefined && collector.first(renameId!) !== undefined,
          15_000,
        )
        .catch(() => undefined);

      const inFlight = collector.first(renameId!);
      expect(inFlight).toBeDefined();
      expect(inFlight?.ok).toBe(false);
      expect(String(inFlight?.error)).toMatch(/stopping/i);
      expect(inFlight?.errorName).toBe('SessionCatalogStoppingError');
      expect(collector.first(200)?.ok).toBe(true);
    } finally {
      client.socket.destroy();
    }
    await waitForEndpointClosed(sessionCatalogProjectServerEndpoint(root));
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }, 90_000);

  it('still delivers real responses for requests that settle before shutdown', async () => {
    const { root, client, collector, send } = await startDaemon(Date.now() + 1);
    try {
      const auth = (
        await waitForMetadataFile<{ authToken: string }>(
          sessionCatalogProjectServerMetadataPath(root),
        )
      ).authToken;
      const request = (id: number, op: string, args: Record<string, unknown>): void =>
        send({ type: 'request', id, op, args, authToken: auth });

      request(1, 'ping', {});
      await collector.waitFor(() => collector.first(1) !== undefined, 15_000);
      expect(collector.first(1)?.ok).toBe(true);

      // A settled request is no longer "unsettled": shutdown must not append a
      // stopping rejection after its real response.
      send({ type: 'shutdown', id: 2, reason: 'test', authToken: auth });
      await collector.waitFor(() => collector.first(2) !== undefined, 15_000);
      expect(collector.first(2)?.ok).toBe(true);
      expect(collector.framesOf(1)).toHaveLength(1);
      expect(collector.framesOf(1)?.[0]?.ok).toBe(true);
    } finally {
      client.socket.destroy();
    }
    await waitForEndpointClosed(sessionCatalogProjectServerEndpoint(root));
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }, 60_000);
});
