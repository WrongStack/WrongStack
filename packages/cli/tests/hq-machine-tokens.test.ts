/**
 * Adding a machine from the dashboard: `/api/machine-tokens` mints a client
 * token (admin only, secret shown once), lists tokens without their secrets,
 * and revoking one disconnects the machine using it. The mint that would put
 * an open HQ into client-token mode — dropping token-less clients — needs an
 * explicit acknowledgement.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, HQ_PROTOCOL_VERSION, writeHqAuthFile } from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { WebSocket } from '../src/ws-runtime.js';

const SCOPED = 'e'.repeat(64);
const ADMIN = 'f'.repeat(64);

let handle: HqServerHandle | null = null;
let dataDir: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-machine-tokens-'));
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

function api(pathname: string, token?: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle!.port}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Connect a client; resolves to the socket and a promise of its close. */
async function connect(token?: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  const query = token !== undefined ? `?token=${token}` : '';
  const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws/client${query}`);
  sockets.push(ws);
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
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
          clientId: `c-${sockets.length}`,
          kind: 'tui',
          machineId: 'mach',
          hostname: 'LAB-02',
          pid: sockets.length,
          startedAt: new Date().toISOString(),
        },
        project: {
          projectId: 'proj',
          projectRoot: '/r/proj',
          projectName: 'proj',
          machineId: 'mach',
          workspaceKind: 'git',
        },
        capabilities: ['telemetry.publish'],
      },
    }),
  );
  await welcomed;
  return { ws, closed };
}

describe('machine tokens from the dashboard', () => {
  it('mints for admins only, never lists the secret, and revoking disconnects the machine', async () => {
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
    });
    handle = await startHqServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      clientCleanupIntervalMs: 50,
    });

    expect((await api('/api/machine-tokens', SCOPED)).status).toBe(403);
    expect((await api('/api/machine-tokens', SCOPED, 'POST', { label: 'x' })).status).toBe(403);
    expect((await api('/api/machine-tokens', ADMIN, 'POST', { label: '' })).status).toBe(400);

    const minted = (await (
      await api('/api/machine-tokens', ADMIN, 'POST', { label: 'LAB-02', ttlDays: 30 })
    ).json()) as { id: string; token: string; capabilities: string[]; expiresAt: string };
    expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.capabilities).toEqual(['telemetry.publish']);
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const listed = await (await api('/api/machine-tokens', ADMIN)).text();
    expect(listed).toContain('LAB-02');
    expect(listed).not.toContain(minted.token);

    const { closed } = await connect(minted.token);
    expect((await api(`/api/machine-tokens/${minted.id}`, ADMIN, 'DELETE')).status).toBe(200);
    expect(await closed).toBe(1008);

    const audit = await fs.readFile(path.join(dataDir, 'auth-audit.jsonl'), 'utf8');
    expect(audit).toContain('"kind":"create"');
    expect(audit).toContain('"kind":"revoke"');
    expect(audit).toContain('hq-dashboard:token:admin');
    expect(audit).not.toContain(minted.token);
  });

  it('refuses every admin route when HQ has no sign-in configured at all', async () => {
    // Explicit open mode: an auth file with no credentials. A loopback HQ
    // reached through a tunnel must not hand out tokens or webhooks.
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [],
    });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const { closed } = await connect();

    for (const [pathname, method, body] of [
      ['/api/machine-tokens', 'GET', undefined],
      ['/api/machine-tokens', 'POST', { label: 'LAB-02', allowShell: true }],
      ['/api/notify', 'GET', undefined],
      [
        '/api/notify/channels',
        'POST',
        { name: 'x', type: 'webhook', url: 'http://127.0.0.1:9/h', kinds: ['alert'] },
      ],
      ['/api/alerts/settings', 'PUT', { thresholds: { costThresholdUsd: 1 } }],
    ] as const) {
      const res = await api(pathname, undefined, method, body);
      expect(res.status, `${method} ${pathname}`).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'AUTH_CREDENTIAL_REQUIRED',
      );
    }
    // Nothing was minted, so the machine that joined without a token stays.
    const stillOpen = await Promise.race([
      closed.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300)),
    ]);
    expect(stillOpen).toBe(true);
  });
});
