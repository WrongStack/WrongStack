/**
 * Lifecycle seams between the HQ command queue, client identity, and
 * credentials that expire with the clock rather than with an auth.json write.
 *
 * Each case is a path where the parts were individually correct but the
 * hand-off between them dropped state:
 *  - a queued command whose socket was removed by a path that deleted it from
 *    `clients` BEFORE the socket's own close handler could resolve its queue;
 *  - a reconnect (same clientId) that discarded the operator's pending input;
 *  - a client token holder evicting another publisher by claiming its clientId;
 *  - an expired token that kept working through an open socket or a cookie.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HQ_AUTH_FILE_VERSION,
  HQ_PROTOCOL_VERSION,
  type HqCommandAuditEntry,
  HqCommandAuditLog,
  mutateHqAuthFile,
  writeHqAuthFile,
} from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { credentialMayAnswer } from '../src/hq-server/routes/command-handlers.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let handle: HqServerHandle | null = null;
let tempRoot: string;
let dataDir: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-lifecycle-'));
  dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

function getPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function closed(ws: WebSocket, timeout = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve(-1);
      return;
    }
    const timer = setTimeout(() => reject(new Error('socket did not close')), timeout);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function nextMessage<T extends { type: string }>(
  ws: WebSocket,
  predicate: (message: T) => boolean,
  timeout = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeout);
    const handler = (raw: { toString: () => string }): void => {
      try {
        const message = JSON.parse(raw.toString()) as T;
        if (predicate(message)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(message);
        }
      } catch {
        /* ignore */
      }
    };
    ws.on('message', handler);
  });
}

function hello(clientId: string, pid = 1): string {
  return JSON.stringify({
    type: 'client.hello',
    payload: {
      protocolVersion: HQ_PROTOCOL_VERSION,
      client: {
        clientId,
        kind: 'tui',
        machineId: 'mach-1',
        hostname: 'mach-1.local',
        pid,
        startedAt: new Date().toISOString(),
      },
      project: {
        projectId: 'proj-1',
        projectRoot: '/r/proj-1',
        projectName: 'proj-1',
        machineId: 'mach-1',
        workspaceKind: 'git',
      },
      capabilities: ['telemetry.publish', 'control.receive'],
    },
  });
}

async function helloAndWelcome(ws: WebSocket, clientId: string): Promise<void> {
  const welcome = nextMessage(ws, (m) => m.type === 'hq.welcome');
  ws.send(hello(clientId));
  await welcome;
}

async function writeOpenAuth(): Promise<void> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
}

async function enqueueSteer(port: number, clientId: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      type: 'steer',
      payload: { to: 'leader', subject: 's', body: 'b' },
    }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { commandId: string }).commandId;
}

async function auditEntry(port: number, commandId: string): Promise<HqCommandAuditEntry[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/commands`);
  const body = (await res.json()) as { commands: HqCommandAuditEntry[] };
  return body.commands.filter((c) => c.commandId === commandId);
}

async function waitFor(check: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

describe('command queue across client removal paths', () => {
  it('hands undelivered commands to the socket that reconnects with the same clientId', async () => {
    await writeOpenAuth();
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const base = `ws://127.0.0.1:${handle.port}/ws/client`;

    const first = await open(base);
    await helloAndWelcome(first, 'proc-A');
    const commandId = await enqueueSteer(handle.port, 'proc-A');

    // Same process re-dials before ever polling (network blip). The old
    // socket is superseded — the command must follow the clientId.
    const second = await open(base);
    await helloAndWelcome(second, 'proc-A');
    expect(await closed(first)).toBe(4001);

    const batch = nextMessage<{ type: string; commands: { commandId: string }[] }>(
      second,
      (m) => m.type === 'hq.command_batch',
    );
    second.send(
      JSON.stringify({ type: 'client.command_poll', clientId: 'proc-A', projectId: 'proj-1' }),
    );
    expect((await batch).commands.map((c) => c.commandId)).toEqual([commandId]);
    const [entry] = await auditEntry(handle.port, commandId);
    expect(entry?.status).toBe('delivered');
  });

  it('fails undelivered commands of a client evicted by the heartbeat timeout', async () => {
    // The TTL sweep deleted the client from `clients` before `terminate()`'s
    // close event ran, so the close handler found nothing and the audit row
    // stayed `queued` forever — for exactly the hung client that strands it.
    await writeOpenAuth();
    handle = await startHqServer({
      host: '127.0.0.1',
      port: getPort(),
      dataDir,
      clientTtlMs: 300,
      clientCleanupIntervalMs: 100,
    });
    const client = await open(`ws://127.0.0.1:${handle.port}/ws/client`);
    await helloAndWelcome(client, 'proc-hung');
    const commandId = await enqueueSteer(handle.port, 'proc-hung');

    await closed(client);
    const port = handle.port;
    await waitFor(async () => (await auditEntry(port, commandId))[0]?.ackStatus === 'failed');
    const [entry] = await auditEntry(port, commandId);
    expect(entry).toMatchObject({ status: 'acked', ackStatus: 'failed' });
  });
});

describe('client identity is bound to the credential that registered it', () => {
  const TOKEN_A = 'client-token-a-0123456789';
  const TOKEN_B = 'client-token-b-0123456789';

  async function writeTwoClientTokens(): Promise<void> {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [
        { id: 'a', token: TOKEN_A, createdAt: new Date().toISOString() },
        { id: 'b', token: TOKEN_B, createdAt: new Date().toISOString() },
      ],
    });
  }

  it('refuses a hello that claims a live clientId under a different token', async () => {
    await writeTwoClientTokens();
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const base = `ws://127.0.0.1:${handle.port}/ws/client?token=`;

    const victim = await open(base + TOKEN_A);
    await helloAndWelcome(victim, 'victim');

    const attacker = await open(base + TOKEN_B);
    attacker.send(hello('victim', 999));
    expect(await closed(attacker)).toBe(4003);

    // The victim keeps its address, so a command still reaches it.
    expect(victim.readyState).toBe(WebSocket.OPEN);
    const commandId = await enqueueSteerWithAuth(handle.port, 'victim');
    const batch = nextMessage<{ type: string; commands: { commandId: string }[] }>(
      victim,
      (m) => m.type === 'hq.command_batch',
    );
    victim.send(
      JSON.stringify({ type: 'client.command_poll', clientId: 'victim', projectId: 'proj-1' }),
    );
    expect((await batch).commands[0]?.commandId).toBe(commandId);
  });

  it('still lets the same token reconnect and supersede its own zombie socket', async () => {
    await writeTwoClientTokens();
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const base = `ws://127.0.0.1:${handle.port}/ws/client?token=${TOKEN_A}`;
    const zombie = await open(base);
    await helloAndWelcome(zombie, 'self');
    const fresh = await open(base);
    await helloAndWelcome(fresh, 'self');
    expect(await closed(zombie)).toBe(4001);
    expect(fresh.readyState).toBe(WebSocket.OPEN);
  });

  // Client-token-only auth files leave browser access open on loopback, so
  // the command POST needs no browser credential here.
  async function enqueueSteerWithAuth(port: number, clientId: string): Promise<string> {
    return enqueueSteer(port, clientId);
  }
});

describe('credentials that expire while a socket is open', () => {
  it('closes a client socket once its token reaches expiresAt', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [
        { id: 'keep', token: 'client-keep-0123456789', createdAt: new Date().toISOString() },
        {
          id: 'short',
          token: 'client-short-0123456789',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1_500).toISOString(),
        },
      ],
    });
    handle = await startHqServer({
      host: '127.0.0.1',
      port: getPort(),
      dataDir,
      clientCleanupIntervalMs: 100,
    });
    const short = await open(
      `ws://127.0.0.1:${handle.port}/ws/client?token=client-short-0123456789`,
    );
    await helloAndWelcome(short, 'short-lived');
    const keep = await open(`ws://127.0.0.1:${handle.port}/ws/client?token=client-keep-0123456789`);
    await helloAndWelcome(keep, 'long-lived');

    expect(await closed(short, 6_000)).toBe(1008);
    expect(keep.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects a token-backed cookie session after the token expires', async () => {
    const TOKEN = 'browser-expiring-0123456789';
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      cookieSecret: 'lifecycle-test-cookie-secret-not-for-prod',
      browserTokens: [
        {
          id: 'expiring',
          token: TOKEN,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1_500).toISOString(),
        },
      ],
    });
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    const upgrade = await fetch(`${baseUrl}/api/auth/upgrade`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: baseUrl },
    });
    expect(upgrade.status).toBe(200);
    const cookie = (upgrade.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toContain('=');

    const before = await fetch(`${baseUrl}/api/snapshot`, { headers: { Cookie: cookie } });
    expect(before.status).toBe(200);

    await new Promise((r) => setTimeout(r, 1_700));
    const after = await fetch(`${baseUrl}/api/snapshot`, { headers: { Cookie: cookie } });
    expect(after.status).toBe(401);
  });
});

describe('HqCommandAuditLog.seed', () => {
  it('folds the append log to one row per command, last write wins', () => {
    const log = new HqCommandAuditLog(100);
    const base = {
      commandId: 'c1',
      type: 'steer' as const,
      clientId: 'x',
      enqueuedBy: 'op',
      enqueuedAt: '2026-09-25T00:00:00.000Z',
    };
    log.seed([
      { ...base, status: 'queued' },
      { ...base, status: 'delivered', dispatchedAt: 1 },
      { ...base, status: 'acked', ackStatus: 'completed', acknowledgedAt: 2 },
    ]);
    expect(log.recent()).toHaveLength(1);
    expect(log.get('c1')).toMatchObject({ status: 'acked', ackStatus: 'completed' });
  });

  it('resolves commands a previous HQ process left pending', () => {
    const log = new HqCommandAuditLog(100);
    const base = {
      type: 'steer' as const,
      clientId: 'x',
      enqueuedBy: 'op',
      enqueuedAt: '2026-09-25T00:00:00.000Z',
    };
    log.seed([
      { ...base, commandId: 'never-sent', status: 'queued' },
      { ...base, commandId: 'in-flight', status: 'delivered' },
    ]);
    expect(log.get('never-sent')).toMatchObject({ status: 'acked', ackStatus: 'failed' });
    expect(log.get('never-sent')?.ackMessage).toContain('never delivered');
    expect(log.get('in-flight')).toMatchObject({ status: 'acked', ackStatus: 'failed' });
    expect(log.get('in-flight')?.ackMessage).toContain('outcome unknown');
  });

  it('keeps entries recorded before the async seed at the tail', () => {
    const log = new HqCommandAuditLog(100);
    log.record({
      commandId: 'live',
      type: 'steer',
      clientId: 'x',
      enqueuedBy: 'op',
      enqueuedAt: '2026-09-25T01:00:00.000Z',
      status: 'queued',
    });
    log.seed([
      {
        commandId: 'old',
        type: 'steer',
        clientId: 'x',
        enqueuedBy: 'op',
        enqueuedAt: '2026-09-25T00:00:00.000Z',
        status: 'acked',
        ackStatus: 'completed',
      },
    ]);
    expect(log.recent().map((e) => e.commandId)).toEqual(['old', 'live']);
    // A live pending command is NOT resolved by the seed.
    expect(log.get('live')?.status).toBe('queued');
  });
});

describe('token revocation notice reaches only the sockets it concerns', () => {
  it('leaves a password-session dashboard alone and tells the revoked token holder', async () => {
    const TOKEN = 'browser-revoke-me-0123456789';
    handle = await startHqServer({
      host: '127.0.0.1',
      port: getPort(),
      dataDir,
      password: 'correct-horse-battery',
    });
    await mutateHqAuthFile(dataDir, (current) => ({
      ...current,
      browserTokens: [{ id: 'doomed', token: TOKEN, createdAt: new Date().toISOString() }],
    }));
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const port = handle.port;
    // The watcher applies the token asynchronously.
    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/api/snapshot`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      return res.status === 200;
    });

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ password: 'correct-horse-battery' }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const passwordSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/browser`, {
      headers: { Cookie: cookie, Origin: baseUrl },
    });
    sockets.push(passwordSocket);
    const tokenSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/browser?token=${TOKEN}`, {
      headers: { Origin: baseUrl },
    });
    sockets.push(tokenSocket);
    await Promise.all(
      [passwordSocket, tokenSocket].map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
          }),
      ),
    );

    const passwordFrames: string[] = [];
    passwordSocket.on('message', (raw) => passwordFrames.push(raw.toString()));
    const tokenNotice = nextMessage(tokenSocket, (m) => m.type === 'hq.auth_revoked');
    const tokenClosed = closed(tokenSocket);

    await mutateHqAuthFile(dataDir, (current) => ({ ...current, browserTokens: [] }));

    await tokenNotice;
    expect(await tokenClosed).toBe(1008);
    await new Promise((r) => setTimeout(r, 200));
    expect(passwordFrames.some((frame) => frame.includes('hq.auth_revoked'))).toBe(false);
    expect(passwordSocket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('credentialMayAnswer', () => {
  const approve = (decision: string) =>
    ({ type: 'approve', toolUseId: 't', decision }) as Parameters<typeof credentialMayAnswer>[1];

  it('lets the mobile grant answer one prompt but never write persistent policy', () => {
    const mobile = ['control.enqueue', 'control.approve.once'];
    expect(credentialMayAnswer(mobile, approve('yes'))).toBe(true);
    expect(credentialMayAnswer(mobile, approve('no'))).toBe(true);
    for (const decision of ['always', 'always-exact', 'always-command', 'always-tool', 'deny']) {
      expect(credentialMayAnswer(mobile, approve(decision))).toBe(false);
    }
    expect(
      credentialMayAnswer(mobile, {
        type: 'answer-input',
        requestId: 'r',
        response: { answers: [] },
      } as never),
    ).toBe(true);
  });

  it('keeps full and absent grants unrestricted, steer-only grants shut', () => {
    expect(credentialMayAnswer(undefined, approve('always'))).toBe(true);
    expect(credentialMayAnswer(['control.approve'], approve('deny'))).toBe(true);
    expect(credentialMayAnswer(['control.enqueue'], approve('yes'))).toBe(false);
  });
});
