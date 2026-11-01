/**
 * Machine health on the heartbeat: a client's host-health sample reaches the
 * machine in the snapshot (newest sample wins across the machine's clients),
 * and a malformed sample is dropped without closing the client.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqSnapshot } from '@wrongstack/hq';
import { HQ_AUTH_FILE_VERSION, HQ_PROTOCOL_VERSION, writeHqAuthFile } from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { WebSocket } from '../src/ws-runtime.js';

let handle: HqServerHandle | null = null;
let tempRoot: string;
let dataDir: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-host-health-'));
  dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, { recursive: true });
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function connect(
  clientId: string,
  machineId: string,
  pid: number,
  projectId = 'proj',
  hostname = `${machineId}.local`,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws/client`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const welcomed = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      if (raw.toString().includes('"hq.welcome"')) resolve();
    });
  });
  ws.send(
    JSON.stringify({
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: {
          clientId,
          kind: 'tui',
          machineId,
          hostname,
          pid,
          startedAt: new Date().toISOString(),
        },
        project: {
          projectId,
          projectRoot: `/r/${projectId}`,
          projectName: projectId,
          machineId,
          workspaceKind: 'git',
        },
        capabilities: ['telemetry.publish'],
      },
    }),
  );
  await welcomed;
  return ws;
}

async function snapshot(): Promise<HqSnapshot> {
  const res = await fetch(`http://127.0.0.1:${handle!.port}/api/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as HqSnapshot;
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    value = await read();
  }
  return value;
}

let seq = 0;
function heartbeat(ws: WebSocket, clientId: string, host: unknown): void {
  seq += 1;
  ws.send(
    JSON.stringify({
      type: 'client.event',
      event: {
        id: `hb-${seq}`,
        type: 'client.heartbeat',
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        clientId,
        projectId: 'proj',
        seq,
        payload: { uptimeMs: 1000, status: 'idle', host },
      },
    }),
  );
}

const HOST = {
  platform: 'linux',
  arch: 'x64',
  cpuCount: 8,
  loadAvg1: 1.5,
  memTotalBytes: 16e9,
  memAvailableBytes: 4e9,
  osUptimeSec: 7200,
  diskTotalBytes: 500e9,
  diskFreeBytes: 10e9,
  processRssBytes: 3e8,
};

const healthOf = (snap: HqSnapshot, hostname: string) =>
  snap.machines?.find((machine) => machine.hostname === hostname)?.health;

describe('HQ machine health', () => {
  it('attaches the newest host-health sample to its machine', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const first = await connect('lab-a', 'mach-lab', 11, 'proj', 'LAB-02');
    const second = await connect('lab-b', 'mach-lab', 12, 'proj', 'LAB-02');
    heartbeat(first, 'lab-a', HOST);
    const snap = await eventually(snapshot, (s) => healthOf(s, 'LAB-02') !== undefined);
    expect(healthOf(snap, 'LAB-02')).toMatchObject(HOST);
    expect(typeof healthOf(snap, 'LAB-02')?.reportedAt).toBe('string');

    await new Promise((r) => setTimeout(r, 5));
    heartbeat(second, 'lab-b', { ...HOST, diskFreeBytes: 9e9 });
    const later = await eventually(snapshot, (s) => healthOf(s, 'LAB-02')?.diskFreeBytes === 9e9);
    expect(healthOf(later, 'LAB-02')?.diskFreeBytes).toBe(9e9);
  });

  it('drops a malformed sample and keeps the client connected', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const ws = await connect('lab-a', 'mach-lab', 11, 'proj', 'LAB-02');
    heartbeat(ws, 'lab-a', { ...HOST, platform: '/etc/passwd' });
    heartbeat(ws, 'lab-a', { ...HOST, memTotalBytes: -5 });
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(healthOf(await snapshot(), 'LAB-02')).toBeUndefined();
    // A good sample after the bad ones is still accepted.
    heartbeat(ws, 'lab-a', HOST);
    const snap = await eventually(snapshot, (s) => healthOf(s, 'LAB-02') !== undefined);
    expect(healthOf(snap, 'LAB-02')?.platform).toBe('linux');
  });
});
