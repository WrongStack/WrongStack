// @vitest-environment node

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, HQ_PROTOCOL_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let handle: HqServerHandle | null = null;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-welcome-'));
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

function getPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('HQ server welcome handshake', () => {
  it('replies to client.hello with an hq.welcome frame on the same socket', async () => {
    handle = await startHqServer({ port: getPort(), dataDir });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    const rawMessages: string[] = [];
    client.on('message', (data) => {
      // ws library gives a Buffer by default; support string too.
      let text: string;
      if (typeof data === 'string') text = data;
      else if (Buffer.isBuffer(data)) text = data.toString('utf8');
      else text = new TextDecoder().decode(data as ArrayBuffer);
      rawMessages.push(text);
    });
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'welcome_cli',
            kind: 'cli',
            machineId: 'machine-welcome-001',
            hostname: 'test-host',
            pid: 99999,
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj_welcome',
            projectName: 'Welcome Test Project',
            projectRoot: '/tmp/proj_welcome',
            machineId: 'machine-welcome-001',
            workspaceKind: 'directory',
          },
          capabilities: ['mailbox.summary', 'session.summary', 'fleet.summary'],
        },
      }),
    );

    // Poll the raw message buffer for any frame whose JSON contains
    // "hq.welcome". Server may serialize fields in any order, so substring
    // match on the raw frame is more robust than a structured find().
    const deadline = Date.now() + 1500;
    let welcomeRaw: string | null = null;
    while (Date.now() < deadline) {
      const hit = rawMessages.find((m) => m.includes('hq.welcome'));
      if (hit) {
        welcomeRaw = hit;
        break;
      }
      await waitMs(20);
    }

    expect(welcomeRaw).not.toBeNull();
    const parsed = JSON.parse(welcomeRaw!);
    expect(parsed.type).toBe('hq.welcome');
    // HqWelcomePayload's fields are top-level (not wrapped in `payload`),
    // matching the `HqServerMessage = HqServerCommandBatchMessage | HqWelcomePayload`
    // discriminated-union shape: the `type` field is the discriminator and
    // the remaining fields are siblings of it.
    expect(parsed.protocolVersion).toBe(HQ_PROTOCOL_VERSION);
    expect(typeof parsed.serverTime).toBe('string');
    expect(new Date(parsed.serverTime).toISOString()).toBe(parsed.serverTime);
    expect(parsed.acceptedCapabilities).toEqual([
      'mailbox.summary',
      'session.summary',
      'fleet.summary',
    ]);
    expect(parsed.redactionPolicy).toEqual({
      rawContent: true,
      toolArgs: 'full',
      paths: 'full',
    });

    client.close();
  });
});
