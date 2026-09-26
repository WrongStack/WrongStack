/**
 * HQ peer-lifecycle `reason` label for the session-summary-TTL eviction.
 *
 * The cleanup timer in `packages/cli/src/hq-server.ts` has two distinct
 * eviction branches that both used to pass the literal
 * `'heartbeat-timeout'` to `detectLeaderLoss`:
 *
 *   - `lastSeenAt` older than `clientTtlMs`       -> a REAL heartbeat timeout
 *   - `session.summary` client with zero session   -> a server-side TTL reap,
 *     snapshots past `sessionSnapshotTtlMs`           NOT a heartbeat failure
 *
 * The second branch only runs after the first returns, so the client is
 * demonstrably still heartbeating when it is reaped. Labelling that
 * `'heartbeat-timeout'` made every `peer.rehydrate` / `peer.lost` banner claim
 * a heartbeat failure that never happened (the plan doc reserves that reason
 * for a genuine missed heartbeat, `docs/plans/hq-evolution-2026-08.md` §4.3).
 * The truthful existing label is `'crash'` — an abrupt, non-graceful
 * server-side loss.
 *
 * Drives the real `startHqServer` cleanup timer and the real
 * `detectLeaderLoss` fanout; no mocks on the production path.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, HQ_PROTOCOL_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startHqServer } from '../src/hq-server.js';

let tempRoot = '';
let dataDir = '';
let handle: Awaited<ReturnType<typeof startHqServer>> | null = null;
const sockets: WebSocket[] = [];

function getPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

function waitForOpen(ws: WebSocket, timeout = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), timeout);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface HelloOpts {
  sessionSummary?: boolean;
  pid?: number;
}

/** A client hello; `sessionSummary` adds the session.summary capability. */
function hello(
  clientId: string,
  machineId: string,
  projectId: string,
  opts: HelloOpts = {},
): string {
  const capabilities = ['telemetry.publish', 'control.receive'];
  if (opts.sessionSummary) capabilities.push('session.summary');
  return JSON.stringify({
    type: 'client.hello',
    payload: {
      protocolVersion: HQ_PROTOCOL_VERSION,
      client: {
        clientId,
        kind: 'tui',
        machineId,
        hostname: machineId + '.local',
        pid: opts.pid ?? 1,
        startedAt: new Date().toISOString(),
      },
      project: {
        projectId,
        projectRoot: '/r/' + projectId,
        projectName: projectId,
        machineId,
        workspaceKind: 'git',
      },
      capabilities,
    },
  });
}

/** A benign telemetry event that keeps the client's `lastSeenAt` fresh. */
function keepalive(clientId: string, projectId: string, seq: number): string {
  return JSON.stringify({
    type: 'client.event',
    event: {
      id: `ka-${seq}`,
      type: 'agent.timeline.message',
      schemaVersion: HQ_PROTOCOL_VERSION,
      timestamp: new Date().toISOString(),
      clientId,
      projectId,
      seq,
      payload: { message: 'alive' },
    },
  });
}

async function startOpenHqServer(
  options: Omit<Parameters<typeof startHqServer>[0], 'dataDir'> = {},
): Promise<Awaited<ReturnType<typeof startHqServer>>> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
  return startHqServer({ host: '127.0.0.1', ...options, dataDir });
}

interface PeerEnvelope {
  type: string;
  payload?: { reason?: string };
}

/** Capture peer.rehydrate / peer.lost envelopes delivered to a client socket. */
function collectPeerEnvelopes(ws: WebSocket): PeerEnvelope[] {
  const found: PeerEnvelope[] = [];
  ws.on('message', (raw: unknown) => {
    try {
      const parsed = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Buffer),
      ) as { type?: string; event?: PeerEnvelope };
      const event = parsed.event;
      if (parsed.type === 'hq.event' && event) {
        if (event.type === 'peer.rehydrate' || event.type === 'peer.lost') found.push(event);
      }
    } catch {
      /* non-JSON frame */
    }
  });
  return found;
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-peer-reason-'));
  dataDir = path.join(tempRoot, 'hq');
  handle = null;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  await handle?.close?.();
  handle = null;
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('HQ peer-lifecycle reason label', () => {
  it('reports a session-summary-TTL reap as a crash, not a heartbeat timeout', async () => {
    // LONG client TTL so the genuine-heartbeat-timeout branch can never fire;
    // SHORT session-summary TTL so the session-summary branch does.
    const port = getPort();
    handle = await startOpenHqServer({
      port,
      clientTtlMs: 600_000,
      sessionSnapshotTtlMs: 150,
      clientCleanupIntervalMs: 50,
    });

    // Doomed leader: advertises session.summary, publishes NO session
    // snapshots, and stays connected + heartbeating.
    const leader = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    sockets.push(leader);
    await waitForOpen(leader);
    leader.send(hello('lead-ttl', 'mach-A', 'projTTL', { sessionSummary: true, pid: 101 }));
    await new Promise((r) => setTimeout(r, 30));

    // Healthy control-capable survivor in the same project so leader loss is
    // fanned out to a surviving client. Distinct pid avoids the supersede
    // path (which would report 'crash' for a different reason).
    const survivor = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    sockets.push(survivor);
    await waitForOpen(survivor);
    const envelopes = collectPeerEnvelopes(survivor);
    survivor.send(hello('follow-ttl', 'mach-A', 'projTTL', { pid: 202 }));
    await new Promise((r) => setTimeout(r, 30));

    // Keep the leader ALIVE so the ONLY branch that can reap it is the
    // session-summary-TTL one.
    let seq = 1;
    const beat = setInterval(() => {
      if (leader.readyState === WebSocket.OPEN)
        leader.send(keepalive('lead-ttl', 'projTTL', seq++));
    }, 20);

    try {
      await vi.waitFor(
        () => {
          expect(envelopes.some((e) => e.payload?.reason !== undefined)).toBe(true);
        },
        { timeout: 8_000, interval: 25 },
      );
    } finally {
      clearInterval(beat);
    }

    const reap = envelopes.find((e) => e.payload?.reason !== undefined)!;
    expect(
      reap.payload?.reason,
      `session-summary-TTL reap must not be labeled 'heartbeat-timeout' (got '${reap.payload?.reason}')`,
    ).not.toBe('heartbeat-timeout');
    expect(reap.payload?.reason).toBe('crash');
  });

  it('still reports a genuine missed heartbeat as heartbeat-timeout', async () => {
    // Neighbor unaffected path: SHORT client TTL, leader goes silent, survivor
    // heartbeats. The genuine-heartbeat-timeout branch keeps its label.
    const port = getPort();
    handle = await startOpenHqServer({
      port,
      clientTtlMs: 300,
      clientCleanupIntervalMs: 20,
    });

    const leader = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    sockets.push(leader);
    await waitForOpen(leader);
    // Distinct pid so the survivor's hello does not supersede the leader.
    leader.send(hello('lead-hb', 'mach-B', 'projHB', { pid: 11 }));

    const survivor = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    sockets.push(survivor);
    await waitForOpen(survivor);
    const envelopes = collectPeerEnvelopes(survivor);
    survivor.send(hello('follow-hb', 'mach-B', 'projHB', { pid: 22 }));
    await new Promise((r) => setTimeout(r, 30));

    // Survivor heartbeats so it outlives the leader; the leader stays silent
    // so its lastSeenAt ages past clientTtlMs.
    let seq = 1;
    const beat = setInterval(() => {
      if (survivor.readyState === WebSocket.OPEN) {
        survivor.send(keepalive('follow-hb', 'projHB', seq++));
      }
    }, 20);

    try {
      await vi.waitFor(
        () => {
          expect(envelopes.some((e) => e.payload?.reason !== undefined)).toBe(true);
        },
        { timeout: 8_000, interval: 25 },
      );
    } finally {
      clearInterval(beat);
    }

    const timeoutReap = envelopes.find((e) => e.payload?.reason !== undefined)!;
    expect(timeoutReap.payload?.reason).toBe('heartbeat-timeout');
  });
});
