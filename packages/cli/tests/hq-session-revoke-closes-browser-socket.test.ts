/**
 * WS-2026-09-15-02 — revoking a browser session in-process closes its socket.
 *
 * `/ws/browser` checks the session cookie once, at upgrade. In-process auth
 * routes (session revoke, password change/removal, TOTP enable, logout) apply
 * the new auth state before the auth.json watcher runs, so the watcher's
 * before/after diff was empty and its close loop never fired: the revoked
 * party kept a live telemetry stream. The server now closes sockets bound to
 * sessions an HTTP request removed.
 *
 * Injection-validated: with the request wrapper removed from hq-server.ts the
 * socket stays open and `waitForClose` resolves `undefined`.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HQ_AUTH_FILE_VERSION,
  hashHqPassword,
  mintHqCookieSecret,
  writeHqAuthFile,
} from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from '../src/ws-runtime.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

const PASSWORD = 'dummy-password-123';

let handle: HqServerHandle | null = null;
let dataDir: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-revoke-socket-'));
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
    passwordHash: await hashHqPassword(PASSWORD),
    cookieSecret: mintHqCookieSecret(),
  });
  handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const httpUrl = (p: string): string => `http://${handle!.host}:${handle!.port}${p}`;

async function login(): Promise<string> {
  const res = await fetch(httpUrl('/api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  return cookie;
}

function openBrowserSocket(cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${handle!.host}:${handle!.port}/ws/browser`, {
      headers: { Cookie: cookie },
    });
    sockets.push(ws);
    const timer = setTimeout(() => reject(new Error('WS open timeout')), 3_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`upgrade refused: ${res.statusCode}`));
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForClose(ws: WebSocket, timeout = 3_000): Promise<number | undefined> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(ws.readyState);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeout);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('HQ in-process session revocation closes bound browser sockets', () => {
  it('DELETE /api/auth/sessions closes the open /ws/browser socket', async () => {
    const cookie = await login();
    const socket = await openBrowserSocket(cookie);
    const closed = waitForClose(socket);

    const res = await fetch(httpUrl('/api/auth/sessions'), {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);

    expect(await closed).toBe(1008);
  });

  it('a request that removes no session leaves the socket open', async () => {
    const cookie = await login();
    const socket = await openBrowserSocket(cookie);
    const closed = waitForClose(socket, 500);

    const res = await fetch(httpUrl('/api/auth/sessions'), { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    expect(await closed).toBeUndefined();
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
