/**
 * Chronicle shutdown answers in-flight requests instead of stranding them.
 *
 * `stop()` used to destroy client sockets while dispatches were still running:
 * an in-flight caller saw nothing but a bare connection close (its response
 * can no longer be written once the socket is destroyed) and hung until its
 * own call timeout, while `metricsStore`/journals closed under the live
 * operation. The deterministic hold: seed the journal with payload-weighted
 * events, then confirm a `query` dispatch is in flight on the wire via
 * `ping`'s `activeRequests` BEFORE requesting shutdown.
 *
 * Delivery note: the shutdown answers are flushed with `socket.end()` — a
 * write immediately followed by destroy() loses the pending bytes on Windows
 * named pipes. `stop()` still resolves only from `server.close()`'s callback
 * (bounded force-destroy handles clients that ignore the FIN).
 */
import * as fs from 'node:fs/promises';
import type * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  chronicleProjectServerEndpoint,
  chronicleProjectServerMetadataPath,
} from '../src/chronicle/project-server-endpoint.js';
import {
  connectFrame,
  importDaemonInstance,
  makeTempRoot,
  waitForEndpointClosed,
  waitForMetadataFile,
} from './helpers/project-server-harness.js';

type Frame = Record<string, unknown>;

/** Read `health.activeRequests` off a ping response frame, 0 when absent. */
function readActiveRequests(frame: Frame | undefined): number {
  const result = frame?.result;
  if (typeof result !== 'object' || result === null) return 0;
  const active = (result as { activeRequests?: unknown }).activeRequests;
  return typeof active === 'number' ? active : 0;
}

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

type Harness = {
  root: string;
  client: ReturnType<typeof connectFrame> extends Promise<infer T> ? T : never;
  collector: ReturnType<typeof makeCollector>;
  send: (frame: Record<string, unknown>) => void;
};

async function startDaemon(caseSeed: number): Promise<Harness> {
  const fixture = await makeTempRoot('chronicle-stop-drain');
  const endpoint = chronicleProjectServerEndpoint(fixture.root);
  const metadataPath = chronicleProjectServerMetadataPath(fixture.root);
  const previousIdle = process.env['WRONGSTACK_CHRONICLE_SERVER_IDLE_MS'];
  process.env['WRONGSTACK_CHRONICLE_SERVER_IDLE_MS'] = '60000';
  try {
    await importDaemonInstance(
      '../../src/chronicle/project-server.ts',
      [
        '--project-root',
        fixture.root,
        '--global-root',
        `${fixture.root}-global`,
        '--project-id',
        'stop-drain',
        '--project-dir',
        fixture.root,
        '--workspace-id',
        'stop-drain-ws',
      ],
      caseSeed,
    );
  } finally {
    if (previousIdle === undefined) delete process.env['WRONGSTACK_CHRONICLE_SERVER_IDLE_MS'];
    else process.env['WRONGSTACK_CHRONICLE_SERVER_IDLE_MS'] = previousIdle;
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

describe('Chronicle shutdown answers in-flight requests', () => {
  it('answers an in-flight query before the connection closes', async () => {
    const { root, client, collector, send } = await startDaemon(Date.now());
    try {
      const auth = (
        await waitForMetadataFile<{ authToken: string }>(chronicleProjectServerMetadataPath(root))
      ).authToken;
      const request = (id: number, op: string, args: Record<string, unknown>): void =>
        send({ type: 'request', id, op, args, authToken: auth });

      // Seed: payload-weighted events so the query's store/engine work spans
      // enough event-loop turns to be confirmable mid-flight.
      const makeBatch = (batchIndex: number): Record<string, unknown> => ({
        inputs: Array.from({ length: 40 }, (_, i) => ({
          eventType: 'stop-drain.event',
          scope: {
            agentId: `stop-drain-agent-${i}`,
            sessionId: `stop-drain-session-${batchIndex}`,
            installationId: 'stop-drain-installation',
            machineId: 'stop-drain-machine',
          },
          correlation: {
            traceId: `stop-drain-trace-${batchIndex}-${i}`,
            spanId: `stop-drain-span-${batchIndex}-${i}`,
          },
          occurredAt: new Date().toISOString(),
          attributes: { blob: 'x'.repeat(8 * 1024) },
        })),
      });
      request(1, 'append', makeBatch(1));
      await collector.waitFor(() => collector.first(1) !== undefined, 60_000);
      expect(collector.first(1)?.ok).toBe(true);
      request(2, 'append', makeBatch(2));
      await collector.waitFor(() => collector.first(2) !== undefined, 60_000);
      expect(collector.first(2)?.ok).toBe(true);

      // Query, then confirm in flight on the wire: ping health must report
      // BOTH the query and the ping (activeRequests >= 2) before shutdown.
      let queryId: number | undefined;
      let pingId = 100;
      for (let attempt = 0; attempt < 20 && queryId === undefined; attempt++) {
        const candidate = 10 + attempt;
        request(candidate, 'query', { query: { limit: 200 } });
        for (let poll = 0; poll < 20 && queryId === undefined; poll++) {
          const id = pingId++;
          request(id, 'ping', {});
          await collector.waitFor(() => collector.first(id) !== undefined, 10_000);
          const ping = collector.first(id);
          expect(ping?.ok).toBe(true);
          if (readActiveRequests(ping) >= 2) {
            queryId = candidate;
          } else if (collector.first(candidate)) {
            break; // settled before the poll saw it — try a fresh query
          }
        }
      }
      expect(queryId).toBeDefined();

      // Shutdown ONLY after the in-flight confirmation.
      send({ type: 'shutdown', id: 200, reason: 'test', authToken: auth });
      await collector
        .waitFor(
          () => collector.first(200) !== undefined && collector.first(queryId!) !== undefined,
          15_000,
        )
        .catch(() => undefined);

      // The defect under test is silence: an in-flight dispatch must be
      // answered before close — with its real result (it settled mid-stop and
      // end() flushed the queued bytes) or a clean stopping rejection.
      const inFlight = collector.first(queryId!);
      expect(inFlight).toBeDefined();
      if (inFlight?.ok !== true) {
        expect(String(inFlight?.error)).toMatch(/stopping/i);
        expect(inFlight?.errorName).toBe('ChronicleStoppingError');
      }
      expect(collector.first(200)?.ok).toBe(true);
    } finally {
      client.socket.destroy();
    }
    await waitForEndpointClosed(chronicleProjectServerEndpoint(root));
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }, 90_000);

  it('still delivers real responses for requests that settle before shutdown', async () => {
    const { root, client, collector, send } = await startDaemon(Date.now() + 1);
    try {
      const auth = (
        await waitForMetadataFile<{ authToken: string }>(chronicleProjectServerMetadataPath(root))
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
    await waitForEndpointClosed(chronicleProjectServerEndpoint(root));
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }, 60_000);
});
