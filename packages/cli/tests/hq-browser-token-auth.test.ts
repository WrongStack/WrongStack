import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqBrowserToken } from '@wrongstack/core/hq';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from '../src/ws-runtime.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let handle: HqServerHandle | null = null;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-tokens-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function startWithTokens(tokens: HqBrowserToken[]): Promise<HqServerHandle> {
  await writeHqAuthFile(dataDir, {
    version: 1,
    updatedAt: new Date().toISOString(),
    browserTokens: tokens,
  });
  // Force dataDir to the test temp dir via the WRONGSTACK_HQ_DATA_DIR env.
  // The server resolves dataDir from options.dataDir if provided.
  handle = await startHqServer({
    host: '127.0.0.1',
    port: 0, // auto-assign
    dataDir,
  });
  return handle;
}

function wsUrl(handle: HqServerHandle, pathname: string, token?: string): string {
  const base = `ws://${handle.host}:${handle.port}${pathname}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function waitForOpen(ws: WebSocket, timeout = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), timeout);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForClose(ws: WebSocket, timeout = 3_000): Promise<number | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeout);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('HQ server — /ws/browser token validation', () => {
  it('first run: creates browser auth and rejects browser connections without a token', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    expect(handle.firstRunSetup?.browserUrl).toContain('#bootstrap=');
    const ws = new WebSocket(wsUrl(handle, '/ws/browser'));
    await expect(waitForOpen(ws)).rejects.toThrow();
    ws.close();
  });

  it('explicit open mode: accepts browser connections without a token', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [],
    });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    expect(handle.firstRunSetup).toMatchObject({
      browserUrl: `http://127.0.0.1:${handle.port}/`,
      clientUrl: `ws://127.0.0.1:${handle.port}/ws/client`,
      clientEnv: { WRONGSTACK_HQ_URL: `http://127.0.0.1:${handle.port}` },
      createdAuth: false,
    });
    const ws = new WebSocket(wsUrl(handle, '/ws/browser'));
    await expect(waitForOpen(ws)).resolves.toBeUndefined();
    ws.close();
  });

  it('token mode: rejects browsers without a token', async () => {
    const h = await startWithTokens([
      { id: 't1', token: 'valid-token-abc', createdAt: '2026-06-21T00:00:00.000Z' },
    ]);
    const ws = new WebSocket(wsUrl(h, '/ws/browser'));
    // Either the connection fails outright or it closes immediately.
    await expect(waitForOpen(ws)).rejects.toThrow();
    ws.close();
  });

  it('token mode: rejects browsers with an unknown token', async () => {
    const h = await startWithTokens([
      { id: 't1', token: 'valid-token-abc', createdAt: '2026-06-21T00:00:00.000Z' },
    ]);
    const ws = new WebSocket(wsUrl(h, '/ws/browser', 'unknown-token'));
    await expect(waitForOpen(ws)).rejects.toThrow();
    ws.close();
  });

  it('token mode: accepts browsers with a valid token', async () => {
    const h = await startWithTokens([
      { id: 't1', token: 'valid-token-abc', createdAt: '2026-06-21T00:00:00.000Z' },
    ]);
    const ws = new WebSocket(wsUrl(h, '/ws/browser', 'valid-token-abc'));
    await expect(waitForOpen(ws)).resolves.toBeUndefined();
    ws.close();
  });

  // WS-2026-09-15-01. This test used to be named "/ws/client connections are
  // exempt from token validation" and asserted that the upgrade OPENED — it was
  // pinning the vulnerability: with a browser credential configured and no
  // client token, an anonymous peer registered as a publisher and was granted
  // every capability it declared, `control.approve` included. Open mode is "no
  // credential of any kind"; a browser token is a credential.
  it('token mode: a tokenless /ws/client upgrade is rejected when only browser tokens exist', async () => {
    const h = await startWithTokens([
      { id: 't1', token: 'valid-token-abc', createdAt: '2026-06-21T00:00:00.000Z' },
    ]);
    const ws = new WebSocket(wsUrl(h, '/ws/client'));
    await expect(waitForOpen(ws)).rejects.toThrow(/401/);
  });

  it('token mode: /ws/client with a live client token still connects', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 't1', token: 'valid-token-abc', createdAt: '2026-06-21T00:00:00.000Z' },
      ],
      clientTokens: [
        {
          id: 'c1',
          token: 'client-token-xyz',
          createdAt: '2026-06-21T00:00:00.000Z',
          capabilities: ['telemetry.publish'],
        },
      ],
    });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const ws = new WebSocket(wsUrl(handle, '/ws/client', 'client-token-xyz'));
    // /ws/client requires a hello frame; open is enough for this test.
    await expect(waitForOpen(ws)).resolves.toBeUndefined();
    ws.close();
  });

  it('explicit open mode: browsers can connect multiple times in parallel', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [],
    });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const a = new WebSocket(wsUrl(handle, '/ws/browser'));
    const b = new WebSocket(wsUrl(handle, '/ws/browser'));
    await Promise.all([waitForOpen(a), waitForOpen(b)]);
    a.close();
    b.close();
  });

  it('token mode: a browser with a still-valid token connects and closes cleanly', async () => {
    // Revocation (token removed from auth.json → live socket closed with 1008,
    // reconnect refused) is covered against the live file watcher in
    // hq-auth-phase4.test.ts. This test only pins the happy path. Its old
    // name claimed revocation while never revoking anything.
    const h = await startWithTokens([
      { id: 't1', token: 'token-to-keep', createdAt: '2026-06-21T00:00:00.000Z' },
    ]);
    const ws = new WebSocket(wsUrl(h, '/ws/browser', 'token-to-keep'));
    await expect(waitForOpen(ws)).resolves.toBeUndefined();
    ws.close();
    // Confirm the close lands (the close code 1005 is fine — we initiated it).
    await waitForClose(ws);
  });
});
