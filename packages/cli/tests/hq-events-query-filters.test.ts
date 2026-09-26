/**
 * `GET /api/events` scoping filters.
 *
 * `clientId` lives on the event ENVELOPE — the dashboard shows and copies
 * `event.clientId` — but the filter compared `payload.clientId`, which no
 * payload has, so pasting a client id returned nothing. The filters also ran
 * AFTER the log had been cut to the newest `limit` events, so a source that
 * had been quiet for a while could never be found at all.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, HQ_PROTOCOL_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let handle: HqServerHandle | null = null;
let tempRoot: string;
let dataDir: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-events-filter-'));
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

async function connect(clientId: string, machineId: string, pid: number): Promise<WebSocket> {
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
          hostname: `${machineId}.local`,
          pid,
          startedAt: new Date().toISOString(),
        },
        project: {
          projectId: 'proj',
          projectRoot: '/r/proj',
          projectName: 'proj',
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

async function events(query: string): Promise<Array<{ clientId?: string; type: string }>> {
  const res = await fetch(`http://127.0.0.1:${handle!.port}/api/events?${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: Array<{ clientId?: string; type: string }> }).events;
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

describe('GET /api/events filters', () => {
  it('filters by the envelope clientId and finds it past the newest `limit` events', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    await connect('quiet-client', 'mach-a', 11);
    await connect('busy-client', 'mach-b', 22);

    // The persisted log is written asynchronously.
    await eventually(
      () => events('type=client.hello&limit=10'),
      (list) => list.length >= 2,
    );

    // limit=1: the newest event belongs to busy-client, so a post-hoc filter
    // over the newest one would return nothing for quiet-client.
    const quiet = await events('clientId=quiet-client&limit=1');
    expect(quiet.map((event) => event.clientId)).toEqual(['quiet-client']);
  });

  it('filters by machineId, including events whose payload carries none', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    await connect('on-a', 'mach-a', 11);
    await connect('on-b', 'mach-b', 22);
    await eventually(
      () => events('type=client.hello&limit=10'),
      (list) => list.length >= 2,
    );

    const onB = await events('machineId=mach-b&limit=10');
    expect(onB.length).toBeGreaterThan(0);
    expect(new Set(onB.map((event) => event.clientId))).toEqual(new Set(['on-b']));
  });
});
