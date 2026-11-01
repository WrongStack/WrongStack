/**
 * HQ pushes what needs the operator to a channel outside the browser.
 *
 * End to end: an admin adds a webhook channel over `/api/notify`, a client
 * raises an approval that nobody answers, and the webhook receives it. The
 * channel URL is a credential, so it never comes back to the browser, and the
 * routes need `auth.admin`.
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, HQ_PROTOCOL_VERSION, writeHqAuthFile } from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { WebSocket } from '../src/ws-runtime.js';

const SCOPED = 'e'.repeat(64);
const ADMIN = 'f'.repeat(64);
const CLIENT = 'a'.repeat(64);

let handle: HqServerHandle | null = null;
let receiver: http.Server | null = null;
let dataDir: string;
let received: Array<Record<string, unknown>>;
let receiverUrl: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-notify-e2e-'));
  const now = new Date().toISOString();
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: now,
    browserTokens: [
      { id: 'scoped', token: SCOPED, createdAt: now, capabilities: ['control.enqueue'] },
      {
        id: 'admin',
        token: ADMIN,
        createdAt: now,
        capabilities: ['control.enqueue', 'auth.admin'],
      },
    ],
    clientTokens: [{ id: 'client', token: CLIENT, createdAt: now }],
  });
  received = [];
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => receiver!.listen(0, '127.0.0.1', resolve));
  const address = receiver.address() as { port: number };
  receiverUrl = `http://127.0.0.1:${address.port}/hook/SECRET-TOKEN-1234`;
  handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  if (handle) {
    await handle.close();
    handle = null;
  }
  await new Promise<void>((resolve) => receiver?.close(() => resolve()) ?? resolve());
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

function api(pathname: string, token: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle!.port}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

describe('HQ notifications', () => {
  it('needs auth.admin and never returns the channel URL', async () => {
    expect((await api('/api/notify', SCOPED)).status).toBe(403);
    const add = await api('/api/notify/channels', ADMIN, 'POST', {
      name: 'Ops hook',
      type: 'webhook',
      url: receiverUrl,
      kinds: ['alert', 'approval'],
    });
    expect(add.status).toBe(200);
    const listed = await (await api('/api/notify', ADMIN)).text();
    expect(listed).toContain('Ops hook');
    expect(listed).not.toContain('SECRET-TOKEN');

    const id = (JSON.parse(listed) as { channels: { id: string }[] }).channels[0]!.id;
    expect((await api(`/api/notify/channels/${id}/test`, SCOPED, 'POST')).status).toBe(403);
    expect((await api(`/api/notify/channels/${id}/test`, ADMIN, 'POST')).status).toBe(200);
    expect(received[0]).toMatchObject({ title: 'WrongStack HQ test notification' });

    expect((await api(`/api/notify/channels/${id}`, ADMIN, 'DELETE')).status).toBe(200);
    expect((await (await api('/api/notify', ADMIN)).json()) as unknown).toMatchObject({
      channels: [],
    });
  });

  it('pushes an approval nobody answered', async () => {
    await api('/api/notify/channels', ADMIN, 'POST', {
      name: 'Phone',
      type: 'webhook',
      url: receiverUrl,
      kinds: ['approval'],
    });
    await api('/api/notify/settings', ADMIN, 'PUT', { approvalDelaySeconds: 0 });

    const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws/client?token=${CLIENT}`);
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
            clientId: 'lab-client',
            kind: 'tui',
            machineId: 'mach-lab',
            hostname: 'LAB-02',
            pid: 7,
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj',
            projectRoot: '/r/proj',
            projectName: 'Datapipe',
            machineId: 'mach-lab',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'control.receive'],
        },
      }),
    );
    await welcomed;
    ws.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-approval',
          type: 'approval.requested',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'lab-client',
          projectId: 'proj',
          seq: 1,
          payload: {
            toolUseId: 'tool-1',
            toolName: 'bash',
            suggestedPattern: 'bash:rm *',
            deadlineAt: Date.now() + 600_000,
            destructive: true,
            inputSummary: { command: 'rm -rf build' },
          },
        },
      }),
    );
    await until(() => received.length > 0);
    expect(received[0]).toMatchObject({
      kind: 'approval',
      severity: 'error',
      title: 'Approval waiting: bash on LAB-02',
      body: 'Datapipe — a destructive call is waiting for a decision.',
    });
    // Tool arguments never leave HQ.
    expect(JSON.stringify(received)).not.toContain('rm -rf');
  });
});

describe('HQ alert settings', () => {
  it('saves budgets as admin only, and lets an operator snooze a rule across restarts', async () => {
    const thresholds = {
      costThresholdUsd: 75,
      projectDailyBudgetsUsd: { proj: 5 },
      machineDailyBudgetsUsd: { 'host:lab-02': 2 },
    };
    expect((await api('/api/alerts/settings', SCOPED, 'PUT', { thresholds })).status).toBe(403);
    expect(
      (await api('/api/alerts/settings', ADMIN, 'PUT', { thresholds: { staleMachineSeconds: 1 } }))
        .status,
    ).toBe(400);
    const saved = await api('/api/alerts/settings', ADMIN, 'PUT', { thresholds });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ thresholds, spend24h: { totalUsd: 0 } });

    // Muting one rule is an operator act (control.enqueue), not an admin one.
    const rule = encodeURIComponent('budget-project:proj');
    const snoozed = await api(`/api/alerts/rules/${rule}/snooze`, SCOPED, 'POST', { minutes: 60 });
    expect(snoozed.status).toBe(200);
    expect(
      (await api('/api/alerts/rules/not-a-rule/snooze', SCOPED, 'POST', { minutes: 5 })).status,
    ).toBe(404);
    // A budget rule with no budget behind it cannot be muted (the list would
    // grow with every made-up id).
    const unconfigured = encodeURIComponent('budget-project:no-such-project');
    expect(
      (await api(`/api/alerts/rules/${unconfigured}/snooze`, SCOPED, 'POST', { minutes: 5 }))
        .status,
    ).toBe(404);

    await handle!.close();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    // The settings file is read asynchronously at boot.
    type View = { thresholds: Record<string, unknown>; snoozes: Record<string, number> };
    let after: View = { thresholds: {}, snoozes: {} };
    const deadline = Date.now() + 5_000;
    while (Object.keys(after.snoozes).length === 0 && Date.now() < deadline) {
      after = (await (await api('/api/alerts/settings', SCOPED)).json()) as View;
    }
    expect(after.thresholds).toEqual(thresholds);
    expect(Object.keys(after.snoozes)).toEqual(['budget-project:proj']);
    expect((await api(`/api/alerts/rules/${rule}/snooze`, SCOPED, 'DELETE')).status).toBe(200);
  });
});
