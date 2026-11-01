/**
 * HQ remembers machines after their clients disconnect.
 *
 * The live snapshot only knew machines with a connected client, so a box that
 * dropped off vanished: an operator could not tell "LAB-02 went quiet" from
 * "LAB-02 never existed". The roster (`machines.json`) keeps them, the
 * snapshot lists them as `offlineMachines`, and `DELETE /api/machines/:key`
 * forgets one that is offline.
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
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-machine-roster-'));
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

function forget(key: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle!.port}/api/machines/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}

const offlineKeys = (snap: HqSnapshot): string[] =>
  (snap.offlineMachines ?? []).map((machine) => machine.key);

describe('HQ machine roster', () => {
  it('lists a disconnected machine as offline and survives a restart', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const ws = await connect('lab-client', 'mach-lab', 11, 'proj', 'LAB-02');
    await connect('desk-client', 'mach-desk', 22, 'proj', 'DESK');
    const live = await snapshot();
    expect(offlineKeys(live)).toEqual([]);

    ws.close();
    const after = await eventually(snapshot, (snap) => offlineKeys(snap).length > 0);
    expect(offlineKeys(after)).toEqual(['host:lab-02']);
    expect(after.offlineMachines?.[0]).toMatchObject({
      hostname: 'LAB-02',
      machineIds: ['mach-lab'],
      projects: [{ projectId: 'proj', projectName: 'proj' }],
    });

    await handle.close();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const restarted = await eventually(snapshot, (snap) => offlineKeys(snap).length === 2);
    expect(offlineKeys(restarted).sort()).toEqual(['host:desk', 'host:lab-02']);
  });

  it('forgets an offline machine and refuses a connected one', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const ws = await connect('lab-client', 'mach-lab', 11, 'proj', 'LAB-02');
    await snapshot();

    expect((await forget('host:lab-02')).status).toBe(409);
    expect((await forget('not-a-key')).status).toBe(400);
    expect((await forget('host:never-seen')).status).toBe(404);

    ws.close();
    await eventually(snapshot, (snap) => offlineKeys(snap).length > 0);
    const res = await forget('host:lab-02');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forgotten: 'host:lab-02' });
    expect(offlineKeys(await snapshot())).toEqual([]);
  });
});
