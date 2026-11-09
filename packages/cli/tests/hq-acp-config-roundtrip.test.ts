import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import { HQ_AUTH_FILE_VERSION, HqPublisher, writeHqAuthFile } from '@wrongstack/hq';
import { expect, it } from 'vitest';
import { createHqAcpConfigHandler } from '../../runtime/src/hq-host/acp-config.js';
import { createHqCommandDispatcher } from '../../runtime/src/hq-host/command-controller.js';
import { startHqServer } from '../src/hq-server.js';

it('round-trips authenticated HQ settings through real agent stdio and refuses stale or foreign sessions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wrongstack-hq-acp-'));
  const dataDir = join(temp, 'hq');
  await mkdir(dataDir);
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [
      {
        id: 'operator',
        token: 'hq-acp-operator',
        createdAt: new Date().toISOString(),
        capabilities: ['control.enqueue'],
      },
      {
        id: 'read-only',
        token: 'hq-acp-reader',
        createdAt: new Date().toISOString(),
        capabilities: [],
      },
    ],
    clientTokens: [
      {
        id: 'machine',
        token: 'hq-acp-client',
        createdAt: new Date().toISOString(),
        capabilities: ['telemetry.publish'],
      },
    ],
  });
  const server = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
  const base = `http://127.0.0.1:${server.port}`;
  const journal: unknown[] = [];
  const ctx = {
    projectRoot: process.cwd(),
    provider: { id: 'acp' },
    model: 'fixture',
    meta: {},
    session: {
      id: 'session-a',
      append: async (event: unknown) => {
        journal.push(event);
      },
    },
  } as unknown as AgentContext;
  const config = {
    acp: {
      agents: {
        fixture: {
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL('../../acp/tests/fixtures/runtime-config-agent.ts', import.meta.url),
            ),
          ],
        },
      },
      bridge: { agents: ['fixture'] },
    },
  };
  const control = createHqAcpConfigHandler({
    getConfig: () => config as never,
    context: (id) => (id === 'session-a' ? ctx : undefined),
  });
  const makePublisher = (clientId: string, acpSettings: boolean) =>
    new HqPublisher({
      url: base.replace('http:', 'ws:'),
      token: 'hq-acp-client',
      client: {
        clientId,
        machineId: 'machine',
        kind: 'webui',
        startedAt: new Date().toISOString(),
      },
      project: {
        projectId: 'project',
        projectRoot: process.cwd(),
        projectName: 'Fixture',
        machineId: 'machine',
        workspaceKind: 'git',
      },
      acpSettings,
      capabilities: ['telemetry.publish', 'control.receive'],
      commandPollIntervalMs: 50,
      onCommand: createHqCommandDispatcher({
        acpConfig: control,
        sessionId: () => 'session-a',
        ownsSession: (id) => id === 'session-a',
        sessionTag: () => 'a',
        allowRunCommand: () => false,
        interruptLeader: () => false,
      }),
    });
  const publisher = makePublisher('machine:new', true),
    old = makePublisher('machine:old', false);
  publisher.connect();
  old.connect();
  const post = (payload: unknown, clientId = 'machine:new', token = 'hq-acp-operator') =>
    fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, type: 'acp-config', payload }),
    });
  const wait = async (payload: unknown) => {
    const response = await post(payload);
    expect(response.status).toBe(202);
    const { commandId } = (await response.json()) as { commandId: string };
    let found: import('@wrongstack/hq').HqCommandAuditEntry | undefined;
    await expect
      .poll(
        async () => {
          const response = await fetch(`${base}/api/commands`, {
            headers: { authorization: 'Bearer hq-acp-operator' },
          });
          const body = (await response.json()) as {
            commands: import('@wrongstack/hq').HqCommandAuditEntry[];
          };
          found = body.commands.find((x) => x.commandId === commandId);
          return found?.status;
        },
        { timeout: 15000 },
      )
      .toBe('acked');
    return found!;
  };
  try {
    const inspect = { action: 'inspect', sessionId: 'session-a', agentId: 'fixture' };
    await expect
      .poll(async () => (await post(inspect, 'machine:old')).status, { timeout: 5000 })
      .toBe(409);
    const read = await wait(inspect);
    expect(read.ackStatus).toBe('completed');
    expect(read.acpConfig?.options.map((x) => x.id)).toEqual(['engine', 'thought']);
    expect(journal).toHaveLength(0);
    expect((await post(inspect, 'machine:new', 'hq-acp-reader')).status).toBe(403);
    const foreign = await wait({ ...inspect, sessionId: 'session-b' });
    expect(foreign.ackStatus).toBe('rejected');
    const values = { thought: 'ultra', engine: 'deep' };
    const saved = await wait({ ...inspect, action: 'set', expected: {}, values });
    expect(saved.ackStatus).toBe('completed');
    expect(saved.acpConfig?.applied).toEqual(values);
    expect(ctx.meta['acpRuntime']).toEqual({ fixture: values });
    const stale = await wait({
      ...inspect,
      action: 'set',
      expected: {},
      values: { engine: 'fast' },
    });
    expect(stale.ackStatus).toBe('failed');
    expect(journal).toHaveLength(1);
    const reset = await wait({ ...inspect, action: 'set', expected: values, values: {} });
    expect(reset.ackStatus).toBe('completed');
    expect(reset.acpConfig?.options.map((x) => x.currentValue)).toEqual(['fast', 'low']);
    expect(journal).toHaveLength(2);
  } finally {
    publisher.close();
    old.close();
    await server.close();
    expect(dirname(resolve(temp))).toBe(resolve(tmpdir()));
    expect(basename(temp)).toMatch(/^wrongstack-hq-acp-/);
    await rm(temp, { recursive: true, force: true });
  }
}, 40_000);
