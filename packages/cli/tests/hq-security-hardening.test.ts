import {
  HQ_AUTH_FILE_VERSION,
  HQ_PROTOCOL_VERSION,
  type HqAuthFile,
  writeHqAuthFile,
} from '@wrongstack/core';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let dataDir: string;
let handle: HqServerHandle | undefined;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-hardening-'));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await handle?.close();
  handle = undefined;
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function start(auth: HqAuthFile, options: Record<string, number> = {}): Promise<HqServerHandle> {
  await writeHqAuthFile(dataDir, auth);
  handle = await startHqServer({ port: 0, exactPort: true, dataDir, ...options });
  return handle;
}

function token(id: string, value: string, capabilities?: string[]) {
  return {
    id,
    token: value,
    createdAt: new Date().toISOString(),
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}

function authFile(overrides: Partial<HqAuthFile> = {}): HqAuthFile {
  return {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
    ...overrides,
  };
}

function connect(url: string, options?: ConstructorParameters<typeof WebSocket>[1]): WebSocket {
  const socket = new WebSocket(url, options);
  sockets.push(socket);
  return socket;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('open timeout')), 3_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), 3_000);
    socket.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function waitForMessage<T>(socket: WebSocket, predicate: (message: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 3_000);
    const listener = (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as T;
        if (!predicate(message)) return;
        clearTimeout(timer);
        socket.off('message', listener);
        resolve(message);
      } catch {
        // Ignore unrelated malformed frames in the test collector.
      }
    };
    socket.on('message', listener);
  });
}

function hello(clientId: string, capabilities = ['telemetry.publish', 'control.receive']): string {
  return JSON.stringify({
    type: 'client.hello',
    payload: {
      protocolVersion: HQ_PROTOCOL_VERSION,
      client: {
        clientId,
        kind: 'cli',
        machineId: 'machine-hardening',
        startedAt: new Date().toISOString(),
      },
      project: {
        projectId: 'project-hardening',
        projectRoot: '/repo/hardening',
        projectName: 'hardening',
        machineId: 'machine-hardening',
        workspaceKind: 'git',
      },
      capabilities,
      redactionPolicy: { rawContent: true, toolArgs: 'summary', paths: 'project-relative' },
    },
  });
}

async function postCommand(
  server: HqServerHandle,
  browserToken: string | undefined,
  body: unknown,
  origin?: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      ...(browserToken ? { Authorization: `Bearer ${browserToken}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('HQ security and control-plane hardening', () => {
  it('prints browser and client tokens in startup logs for local operator setup', async () => {
    const browserToken = 'startup-browser-secret';
    const clientToken = 'startup-client-secret';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await start(
        authFile({
          browserTokens: [token('bt-startup', browserToken, ['control.enqueue'])],
          clientTokens: [token('ct-startup', clientToken, ['telemetry.publish'])],
        }),
      );
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain(`?token=${browserToken}`);
      expect(output).toContain(`?token=${clientToken}`);
      expect(output).toContain(`WRONGSTACK_HQ_TOKEN=${clientToken}`);
      expect(output).not.toContain('[REDACTED]');
    } finally {
      log.mockRestore();
    }
  });

  it('adds browser security headers and rejects cross-origin writes/upgrades', async () => {
    const server = await start(authFile());
    const snapshot = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`);
    expect(snapshot.headers.get('x-frame-options')).toBe('DENY');
    expect(snapshot.headers.get('x-content-type-options')).toBe('nosniff');
    expect(snapshot.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    const crossOrigin = await postCommand(
      server,
      undefined,
      { clientId: 'missing', type: 'abort', payload: { target: 'leader' } },
      'https://evil.example',
    );
    expect(crossOrigin.status).toBe(403);

    const rejected = connect(`ws://127.0.0.1:${server.port}/ws/browser`, {
      headers: { Origin: 'https://evil.example' },
    });
    const outcome = await new Promise<'rejected' | 'opened'>((resolve) => {
      rejected.once('unexpected-response', () => resolve('rejected'));
      rejected.once('error', () => resolve('rejected'));
      rejected.once('open', () => resolve('opened'));
    });
    expect(outcome).toBe('rejected');
  });

  it('rejects oversized bodies and malformed path encoding as client errors', async () => {
    const server = await start(authFile());
    const oversized = await fetch(`http://127.0.0.1:${server.port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(1_000_001),
    });
    expect(oversized.status).toBe(413);

    const malformed = await fetch(
      `http://127.0.0.1:${server.port}/api/projects/%E0%A4%A`,
    );
    expect(malformed.status).toBe(400);
  });

  it('enforces telemetry.publish on scoped client tokens', async () => {
    const clientToken = 'client-control-only';
    const server = await start(
      authFile({ clientTokens: [token('ct-control', clientToken, ['control.receive'])] }),
    );
    const client = connect(`ws://127.0.0.1:${server.port}/ws/client?token=${clientToken}`);
    await waitForOpen(client);
    client.send(hello('scoped-client'));
    await waitForMessage<{ type: string }>(client, (message) => message.type === 'hq.welcome');
    const closed = waitForClose(client);
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-denied',
          type: 'custom.event',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'scoped-client',
          projectId: 'project-hardening',
          seq: 1,
          payload: {},
        },
      }),
    );
    expect(await closed).toMatchObject({
      code: 1008,
      reason: 'client token lacks telemetry.publish capability',
    });
  });

  it('requires the target client token to grant control.execute for run-command', async () => {
    const browserToken = 'browser-control';
    const clientToken = 'client-no-exec';
    const server = await start(
      authFile({
        browserTokens: [token('bt-control', browserToken, ['control.enqueue'])],
        clientTokens: [token('ct-no-exec', clientToken, ['telemetry.publish'])],
      }),
    );
    const client = connect(`ws://127.0.0.1:${server.port}/ws/client?token=${clientToken}`);
    await waitForOpen(client);
    client.send(hello('no-exec-client'));
    await waitForMessage<{ type: string }>(client, (message) => message.type === 'hq.welcome');

    const response = await postCommand(server, browserToken, {
      clientId: 'no-exec-client',
      type: 'run-command',
      payload: { command: 'echo safe' },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('control.execute');
  });

  it('accepts run-command only when both browser and client scopes allow it', async () => {
    const browserToken = 'browser-control';
    const clientToken = 'client-with-exec';
    const server = await start(
      authFile({
        browserTokens: [token('bt-control', browserToken, ['control.enqueue'])],
        clientTokens: [
          token('ct-exec', clientToken, ['telemetry.publish', 'control.execute']),
        ],
      }),
    );
    const client = connect(`ws://127.0.0.1:${server.port}/ws/client?token=${clientToken}`);
    await waitForOpen(client);
    client.send(hello('exec-client'));
    await waitForMessage<{ type: string }>(client, (message) => message.type === 'hq.welcome');
    const response = await postCommand(server, browserToken, {
      clientId: 'exec-client',
      type: 'run-command',
      payload: { command: 'echo safe' },
    });
    expect(response.status).toBe(202);
  });

  it('binds command polling identity to the registered socket', async () => {
    const server = await start(authFile());
    const client = connect(`ws://127.0.0.1:${server.port}/ws/client`);
    await waitForOpen(client);
    client.send(hello('bound-client'));
    await waitForMessage<{ type: string }>(client, (message) => message.type === 'hq.welcome');
    const closed = waitForClose(client);
    client.send(
      JSON.stringify({
        type: 'client.command_poll',
        clientId: 'another-client',
        projectId: 'project-hardening',
        limit: 25,
      }),
    );
    expect(await closed).toMatchObject({ code: 1008, reason: 'command poll identity mismatch' });
  });

  it('does not let one authenticated client acknowledge another client command', async () => {
    const server = await start(authFile());
    const owner = connect(`ws://127.0.0.1:${server.port}/ws/client`);
    const attacker = connect(`ws://127.0.0.1:${server.port}/ws/client`);
    await Promise.all([waitForOpen(owner), waitForOpen(attacker)]);
    owner.send(hello('command-owner'));
    attacker.send(hello('other-client'));
    await Promise.all([
      waitForMessage<{ type: string }>(owner, (message) => message.type === 'hq.welcome'),
      waitForMessage<{ type: string }>(attacker, (message) => message.type === 'hq.welcome'),
    ]);

    const response = await postCommand(server, undefined, {
      clientId: 'command-owner',
      type: 'abort',
      payload: { target: 'leader' },
    });
    const { commandId } = (await response.json()) as { commandId: string };
    attacker.send(
      JSON.stringify({
        type: 'client.command_ack',
        clientId: 'other-client',
        projectId: 'project-hardening',
        commandId,
        status: 'completed',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    const auditResponse = await fetch(`http://127.0.0.1:${server.port}/api/commands`);
    const audit = (await auditResponse.json()) as {
      commands: Array<{ commandId: string; status: string }>;
    };
    expect(audit.commands.find((entry) => entry.commandId === commandId)?.status).toBe('queued');
  });

  it('honors command poll limits and cursors without dropping queued commands', async () => {
    const server = await start(authFile());
    const client = connect(`ws://127.0.0.1:${server.port}/ws/client`);
    await waitForOpen(client);
    client.send(hello('cursor-client'));
    await waitForMessage<{ type: string }>(client, (message) => message.type === 'hq.welcome');

    for (let i = 1; i <= 3; i++) {
      const response = await postCommand(server, undefined, {
        clientId: 'cursor-client',
        type: 'steer',
        payload: { to: 'leader', subject: `step ${i}`, body: `body ${i}` },
      });
      expect(response.status).toBe(202);
    }

    const firstBatchPromise = waitForMessage<{
      type: string;
      commands: Array<{ commandId: string }>;
    }>(client, (message) => message.type === 'hq.command_batch');
    client.send(
      JSON.stringify({
        type: 'client.command_poll',
        clientId: 'cursor-client',
        projectId: 'project-hardening',
        limit: 2,
      }),
    );
    const firstBatch = await firstBatchPromise;
    expect(firstBatch.commands).toHaveLength(2);

    const secondBatchPromise = waitForMessage<{
      type: string;
      commands: Array<{ commandId: string }>;
    }>(client, (message) => message.type === 'hq.command_batch');
    client.send(
      JSON.stringify({
        type: 'client.command_poll',
        clientId: 'cursor-client',
        projectId: 'project-hardening',
        afterCommandId: firstBatch.commands[1]!.commandId,
        limit: 2,
      }),
    );
    expect((await secondBatchPromise).commands).toHaveLength(1);
  });

  it('sends application-level browser heartbeats during otherwise idle periods', async () => {
    const server = await start(authFile(), { browserHeartbeatIntervalMs: 20 });
    const browser = connect(`ws://127.0.0.1:${server.port}/ws/browser`);
    await waitForOpen(browser);
    const heartbeat = await waitForMessage<{ type: string; serverTime: string }>(
      browser,
      (message) => message.type === 'hq.heartbeat',
    );
    expect(new Date(heartbeat.serverTime).toISOString()).toBe(heartbeat.serverTime);
  });

  it('applies an operator redaction clamp before events reach browsers', async () => {
    const server = await start(
      authFile({
        redactionPolicy: { rawContent: false },
      }),
    );
    const browser = connect(`ws://127.0.0.1:${server.port}/ws/browser`);
    await waitForOpen(browser);
    const eventPromise = waitForMessage<{
      type: string;
      event: { type: string; payload: { entries: Array<{ text: string }> } };
    }>(
      browser,
      (message) => message.type === 'hq.event' && message.event.type === 'session.transcript',
    );

    const client = connect(`ws://127.0.0.1:${server.port}/ws/client`);
    await waitForOpen(client);
    client.send(hello('redaction-client'));
    await waitForMessage<{ type: string }>(client, (message) => message.type === 'hq.welcome');
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-private',
          type: 'session.transcript',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'redaction-client',
          projectId: 'project-hardening',
          sessionId: 'session-private',
          seq: 1,
          payload: {
            sessionId: 'session-private',
            fromSeq: 0,
            entries: [
              { ts: new Date().toISOString(), role: 'user', text: 'operator-private prompt' },
            ],
          },
        },
      }),
    );
    expect((await eventPromise).event.payload.entries[0]?.text).toBe(
      '[REDACTED:hq_raw_content]',
    );
  });

  it('broadcasts a zero-client snapshot when the final stale client is evicted', async () => {
    const server = await start(authFile(), {
      clientTtlMs: 700,
      clientCleanupIntervalMs: 20,
      browserHeartbeatIntervalMs: 1_000,
    });
    const browser = connect(`ws://127.0.0.1:${server.port}/ws/browser`);
    await waitForOpen(browser);
    const activePromise = waitForMessage<{
      type: string;
      snapshot: { totals: { activeClients: number } };
    }>(
      browser,
      (message) =>
        message.type === 'hq.snapshot' && message.snapshot.totals.activeClients === 1,
    );

    const client = connect(`ws://127.0.0.1:${server.port}/ws/client`);
    await waitForOpen(client);
    client.send(hello('stale-client'));
    await activePromise;

    const empty = await waitForMessage<{
      type: string;
      snapshot: { totals: { activeClients: number } };
    }>(
      browser,
      (message) =>
        message.type === 'hq.snapshot' && message.snapshot.totals.activeClients === 0,
    );
    expect(empty.snapshot.totals.activeClients).toBe(0);
  });

  it('keeps a silent client connected when it sends application heartbeats', async () => {
    // TTL must be generous relative to the 100ms heartbeat interval: under
    // full-suite load a fork worker's event loop can stall long enough that a
    // 700ms TTL evicts the client between two heartbeats (observed flake).
    // 3s keeps the property under test (heartbeats refresh lastSeenAt past
    // the TTL) while tolerating multi-second scheduler stalls.
    const server = await start(authFile(), {
      clientTtlMs: 3_000,
      clientCleanupIntervalMs: 20,
      browserHeartbeatIntervalMs: 1_000,
    });
    const client = connect(`ws://127.0.0.1:${server.port}/ws/client`);
    await waitForOpen(client);
    client.send(hello('heartbeat-client'));
    await waitForMessage<{ type: string }>(client, (message) => message.type === 'hq.welcome');

    let seq = 0;
    const heartbeat = setInterval(() => {
      seq += 1;
      client.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: `heartbeat-${seq}`,
            type: 'client.heartbeat',
            schemaVersion: 1,
            timestamp: new Date().toISOString(),
            clientId: 'heartbeat-client',
            projectId: 'project-hardening',
            seq,
            payload: { uptimeMs: seq * 100, status: 'idle' },
          },
        }),
      );
    }, 100);
    try {
      // Wait past the TTL so survival proves the heartbeats refreshed it.
      await new Promise((resolve) => setTimeout(resolve, 3_600));
      const snapshot = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`).then(
        (res) => res.json() as Promise<{ totals: { activeClients: number } }>,
      );
      expect(snapshot.totals.activeClients).toBe(1);
    } finally {
      clearInterval(heartbeat);
      client.close();
    }
  });

  it('supersedes an older socket that reconnects with the same clientId', async () => {
    const server = await start(authFile());
    const older = connect(`ws://127.0.0.1:${server.port}/ws/client`);
    await waitForOpen(older);
    older.send(hello('reconnecting-client'));
    await waitForMessage<{ type: string }>(older, (message) => message.type === 'hq.welcome');
    const olderClosed = waitForClose(older);

    const newer = connect(`ws://127.0.0.1:${server.port}/ws/client`);
    await waitForOpen(newer);
    newer.send(hello('reconnecting-client'));
    await waitForMessage<{ type: string }>(newer, (message) => message.type === 'hq.welcome');
    expect(await olderClosed).toMatchObject({ code: 4001 });

    const response = await postCommand(server, undefined, {
      clientId: 'reconnecting-client',
      type: 'steer',
      payload: { to: 'leader', subject: 'new socket', body: 'deliver here' },
    });
    expect(response.status).toBe(202);
    const batchPromise = waitForMessage<{ type: string; commands: unknown[] }>(
      newer,
      (message) => message.type === 'hq.command_batch',
    );
    newer.send(
      JSON.stringify({
        type: 'client.command_poll',
        clientId: 'reconnecting-client',
        projectId: 'project-hardening',
      }),
    );
    expect((await batchPromise).commands).toHaveLength(1);
  });
});
