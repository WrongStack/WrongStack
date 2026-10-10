import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws/native';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

vi.mock('../src/update-check.js', () => ({
  checkForUpdate: vi.fn().mockResolvedValue({
    current: '1.2.3',
    latest: '1.3.0',
    outdated: true,
    checkFailed: false,
  }),
}));

vi.mock('../src/subcommands/handlers/update.js', () => ({
  detectUpdatePackageName: vi.fn(() => 'wrongstack'),
}));

let dataDir: string;
let handle: HqServerHandle | null = null;

function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitForWebSocketClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), 2_000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function waitForWebSocketRejection(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(false);
    }, 2_000);
    const finish = (rejected: boolean): void => {
      clearTimeout(timer);
      resolve(rejected);
    };
    ws.once('unexpected-response', () => finish(true));
    ws.once('error', () => finish(true));
    ws.once('open', () => {
      ws.close();
      finish(false);
    });
  });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-update-route-'));
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('HQ update status route', () => {
  it('refuses a public relay when browser auth is explicitly open', async () => {
    await expect(startHqServer({ port: 0, dataDir, requireBrowserAuth: true })).rejects.toThrow(
      'requires browser authentication',
    );
  });

  it('revokes the final browser token without turning a public relay into open mode', async () => {
    const browserToken = 'relay-browser-token';
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        {
          id: 'relay-browser',
          token: browserToken,
          createdAt: new Date().toISOString(),
        },
      ],
      clientTokens: [],
    });
    handle = await startHqServer({ port: 0, dataDir, requireBrowserAuth: true });
    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser?token=${browserToken}`);
    await waitForWebSocketOpen(browser);
    const browserClosed = waitForWebSocketClose(browser);

    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [],
    });

    let authStatus = { tokenMode: true, passwordMode: false, loggedIn: true };
    for (let attempt = 0; attempt < 20 && authStatus.tokenMode; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const status = await fetch(`http://127.0.0.1:${handle.port}/api/auth/status`);
      authStatus = (await status.json()) as typeof authStatus;
    }
    expect(authStatus).toMatchObject({
      tokenMode: false,
      passwordMode: false,
      publicRelay: true,
      loggedIn: false,
    });
    expect(await browserClosed).toBe(1008);

    const baseUrl = `http://127.0.0.1:${handle.port}/api/snapshot`;
    expect((await fetch(baseUrl)).status).toBe(401);
    expect(
      (await fetch(baseUrl, { headers: { Authorization: `Bearer ${browserToken}` } })).status,
    ).toBe(401);
    expect(await waitForWebSocketRejection(`ws://127.0.0.1:${handle.port}/ws/browser`)).toBe(true);
  });

  it('returns an actionable cached npm version status', async () => {
    handle = await startHqServer({ port: 0, dataDir });
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/system/update`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      current: '1.2.3',
      latest: '1.3.0',
      outdated: true,
      checkFailed: false,
      packageName: 'wrongstack',
      command: 'wstack update',
    });
  });
});
