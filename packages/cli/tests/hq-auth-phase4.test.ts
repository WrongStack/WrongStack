/**
 * Phase 4 — client token auth + live auth.json reload integration tests.
 *
 * Covers:
 *  - /ws/client rejects upgrades without a valid client token (token mode)
 *  - /ws/client accepts upgrades with a valid client token
 *  - browser tokens cannot be replayed on /ws/client (cross-channel isolation)
 *  - live reload: adding a token to auth.json takes effect without restart
 *  - live reload: removing a token from auth.json blocks it without restart
 *  - `wstack hq token create --client` writes to clientTokens
 *  - `wstack hq token list --client` reads from clientTokens
 *  - `wstack hq token revoke --client` removes from clientTokens
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqAuthFile } from '@wrongstack/core/hq';
import { HQ_AUTH_FILE_VERSION, readHqAuthFile, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { hqCmd } from '../src/subcommands/handlers/hq.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

// ── helpers ────────────────────────────────────────────────────────────────

function getPort(): number {
  // Ephemeral high-range port; collisions are extremely unlikely in CI.
  return 37_000 + Math.floor(Math.random() * 3_000);
}

function waitForOpen(ws: WebSocket, timeout = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), timeout);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForRejection(ws: WebSocket, timeout = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(val);
      }
    };
    const timer = setTimeout(() => done(false), timeout);
    // ws library emits 'unexpected-response' when the server returns a
    // non-101 HTTP status during the upgrade handshake.
    ws.on('unexpected-response', () => done(true));
    ws.on('error', () => done(true));
    ws.on('close', () => done(true));
    // If it opens, it wasn't rejected
    ws.on('open', () => done(false));
  });
}

function waitForCloseCode(ws: WebSocket, timeout = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeout);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function makeTempDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-hq-p4-'));
  return dir;
}

// ── shared state ───────────────────────────────────────────────────────────

let handle: HqServerHandle | undefined;
let dataDir: string;

beforeEach(async () => {
  dataDir = await makeTempDataDir();
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  // Retry ENOTEMPTY/EBUSY (Windows temp-dir cleanup race).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(dataDir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err.code !== 'ENOTEMPTY' && err.code !== 'EBUSY') throw err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
});

// ── tests ──────────────────────────────────────────────────────────────────

describe('HQ Phase 4 — client token auth', () => {
  it('rejects /ws/client without a token when clientTokens is non-empty', async () => {
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      clientTokens: [
        { id: 'test-ct-1', token: 'secret-client-token-aaa', createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    const rejected = await waitForRejection(ws, 3_000);
    expect(rejected).toBe(true);
  });

  it('accepts /ws/client with a valid client token', async () => {
    const clientToken = 'valid-client-token-xyz';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      clientTokens: [{ id: 'test-ct-2', token: clientToken, createdAt: new Date().toISOString() }],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client?token=${clientToken}`);
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects /ws/client with a browser token (cross-channel isolation)', async () => {
    const browserToken = 'browser-only-token-123';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [{ id: 'bt-1', token: browserToken, createdAt: new Date().toISOString() }],
      clientTokens: [
        { id: 'ct-1', token: 'real-client-token', createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    // Browser token should work on /ws/browser
    const browserWs = new WebSocket(
      `ws://127.0.0.1:${handle.port}/ws/browser?token=${browserToken}`,
    );
    await waitForOpen(browserWs);
    expect(browserWs.readyState).toBe(WebSocket.OPEN);

    // But browser token should NOT work on /ws/client
    const clientWs = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client?token=${browserToken}`);
    const clientRejected = await waitForRejection(clientWs, 3_000);
    expect(clientRejected).toBe(true);

    browserWs.close();
  });

  it('allows /ws/client in OPEN MODE when clientTokens is empty', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      clientTokens: [],
    });
    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('HQ Phase 4 — live auth.json reload', () => {
  it('picks up a newly added client token without restart', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      clientTokens: [],
    });
    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    // Verify open mode works
    const ws1 = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(ws1);
    ws1.close();

    // Write auth.json with a client token — server should pick it up via watcher
    const newToken = 'live-reloaded-token-abc';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      clientTokens: [{ id: 'live-ct-1', token: newToken, createdAt: new Date().toISOString() }],
    };
    await writeHqAuthFile(dataDir, authFile);

    // Give the watcher time to fire (debounce + fs event latency).
    // Windows fs.watch can be slow to surface rename events.
    await new Promise((r) => setTimeout(r, 1000));

    // Now a connection without a token should fail
    const ws2 = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    const rejected2 = await waitForRejection(ws2, 3_000);
    expect(rejected2).toBe(true);

    // And a connection with the new token should succeed
    const ws3 = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client?token=${newToken}`);
    await waitForOpen(ws3);
    expect(ws3.readyState).toBe(WebSocket.OPEN);
    ws3.close();
  });

  it('picks up a revoked client token without restart', async () => {
    const clientToken = 'will-be-revoked-token';
    const survivingToken = 'still-valid-client-token';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      clientTokens: [
        { id: 'revoke-ct-1', token: clientToken, createdAt: new Date().toISOString() },
        { id: 'survive-ct-1', token: survivingToken, createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    // Verify token works initially
    const ws1 = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client?token=${clientToken}`);
    await waitForOpen(ws1);
    const revokedSocketClosed = waitForCloseCode(ws1);

    // Remove only this token; another token keeps the endpoint in auth mode.
    const updatedAuth: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      clientTokens: [
        { id: 'survive-ct-1', token: survivingToken, createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, updatedAuth);

    expect(await revokedSocketClosed).toBe(1008);

    const revokedReconnect = new WebSocket(
      `ws://127.0.0.1:${handle.port}/ws/client?token=${clientToken}`,
    );
    expect(await waitForRejection(revokedReconnect, 3_000)).toBe(true);

    const survivingWs = new WebSocket(
      `ws://127.0.0.1:${handle.port}/ws/client?token=${survivingToken}`,
    );
    await waitForOpen(survivingWs);
    survivingWs.close();
  });

  it('closes active browser sockets when browser credentials change', async () => {
    const revokedToken = 'browser-token-to-revoke';
    const survivingToken = 'browser-token-to-keep';
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 'browser-revoke-1', token: revokedToken, createdAt: new Date().toISOString() },
        { id: 'browser-survive-1', token: survivingToken, createdAt: new Date().toISOString() },
      ],
    });

    const port = getPort();
    handle = await startHqServer({ port, dataDir });
    const browserWs = new WebSocket(
      `ws://127.0.0.1:${handle.port}/ws/browser?token=${revokedToken}`,
    );
    await waitForOpen(browserWs);
    const revokedSocketClosed = waitForCloseCode(browserWs);

    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 'browser-survive-1', token: survivingToken, createdAt: new Date().toISOString() },
      ],
    });

    expect(await revokedSocketClosed).toBe(1008);
    const revokedReconnect = new WebSocket(
      `ws://127.0.0.1:${handle.port}/ws/browser?token=${revokedToken}`,
    );
    expect(await waitForRejection(revokedReconnect, 3_000)).toBe(true);
  });
});

// ── subcommand tests for --client flag ─────────────────────────────────────

describe('HQ Phase 4 — token subcommand --client flag', () => {
  interface CapturedRenderer {
    out: string[];
    err: string[];
    warn: string[];
  }

  function makeStubRenderer(): SubcommandDeps['renderer'] & { captured: CapturedRenderer } {
    const captured: CapturedRenderer = { out: [], err: [], warn: [] };
    const r = {
      write: (s: string) => {
        captured.out.push(s);
      },
      writeError: (s: string) => {
        captured.err.push(s);
      },
      writeWarning: (s: string) => {
        captured.warn.push(s);
      },
      captured,
    };
    return r as SubcommandDeps['renderer'] & { captured: CapturedRenderer };
  }

  function makeDeps(overrides: Partial<SubcommandDeps> = {}): SubcommandDeps {
    return {
      args: [],
      flags: { 'data-dir': dataDir },
      cwd: process.cwd(),
      renderer: makeStubRenderer(),
      ...overrides,
    } as never as SubcommandDeps;
  }

  it('`wstack hq token create --client` writes to clientTokens', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['token', 'create', '--client', 'my-ci'], deps);
    expect(code).toBe(0);

    const auth = await readHqAuthFile(dataDir);
    expect(auth.clientTokens).toBeDefined();
    expect(auth.clientTokens).toHaveLength(1);
    expect(auth.clientTokens?.[0]?.label).toBe('my-ci');
    expect(auth.clientTokens?.[0]?.capabilities).toEqual(['telemetry.publish']);
    // browserTokens should NOT be populated
    expect(auth.browserTokens).toBeUndefined();

    const out = (deps.renderer as never as { captured: CapturedRenderer }).captured.out.join('');
    expect(out).toContain('Created client token');
    expect(out).toContain('/ws/client');
  });

  it('`wstack hq token create` (no flag) still writes to browserTokens', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['token', 'create', 'my-laptop'], deps);
    expect(code).toBe(0);

    const auth = await readHqAuthFile(dataDir);
    expect(auth.browserTokens).toBeDefined();
    expect(auth.browserTokens).toHaveLength(1);
    expect(auth.clientTokens).toBeUndefined();
  });

  it('honors --client after top-level parsing consumed the flag', async () => {
    const deps = makeDeps({ flags: { 'data-dir': dataDir, client: true } });
    const code = await hqCmd(['token', 'create', 'parsed-client'], deps);
    expect(code).toBe(0);

    const auth = await readHqAuthFile(dataDir);
    expect(auth.browserTokens).toBeUndefined();
    expect(auth.clientTokens?.[0]).toMatchObject({
      label: 'parsed-client',
      capabilities: ['telemetry.publish'],
    });
  });

  it('mints an execution-capable client token only when explicitly requested', async () => {
    const deps = makeDeps({
      flags: {
        'data-dir': dataDir,
        client: true,
        capabilities: 'telemetry.publish,control.execute',
      },
    });
    expect(await hqCmd(['token', 'create', 'operator'], deps)).toBe(0);
    expect((await readHqAuthFile(dataDir)).clientTokens?.[0]?.capabilities).toEqual([
      'telemetry.publish',
      'control.execute',
    ]);
  });

  it('`wstack hq token list --client` lists client tokens', async () => {
    // Create a client token first
    const deps1 = makeDeps();
    await hqCmd(['token', 'create', '--client', 'ci-runner'], deps1);

    const deps2 = makeDeps();
    const code = await hqCmd(['token', 'list', '--client'], deps2);
    expect(code).toBe(0);

    const out = (deps2.renderer as never as { captured: CapturedRenderer }).captured.out.join('');
    expect(out).toContain('Client tokens (1)');
    expect(out).toContain('ci-runner');
  });

  it('`wstack hq token list` (no flag) does NOT show client tokens', async () => {
    // Create only a client token
    const deps1 = makeDeps();
    await hqCmd(['token', 'create', '--client', 'ci-runner'], deps1);

    const deps2 = makeDeps();
    const code = await hqCmd(['token', 'list'], deps2);
    expect(code).toBe(0);

    const out = (deps2.renderer as never as { captured: CapturedRenderer }).captured.out.join('');
    expect(out).toContain('No browser tokens');
    expect(out).not.toContain('ci-runner');
  });

  it('`wstack hq token revoke --client` removes a client token', async () => {
    // Create a client token
    const deps1 = makeDeps();
    await hqCmd(['token', 'create', '--client'], deps1);

    const before = await readHqAuthFile(dataDir);
    const id = before.clientTokens?.[0]?.id;
    expect(id).toBeDefined();

    const deps2 = makeDeps();
    const code = await hqCmd(['token', 'revoke', '--client', id!], deps2);
    expect(code).toBe(0);

    const after = await readHqAuthFile(dataDir);
    expect(after.clientTokens ?? []).toHaveLength(0);

    const out = (deps2.renderer as never as { captured: CapturedRenderer }).captured.out.join('');
    expect(out).toContain('Revoked client token');
  });

  it('`wstack hq token revoke --client` does NOT affect browser tokens', async () => {
    // Create both a browser and client token
    const deps1 = makeDeps();
    await hqCmd(['token', 'create', 'browser-1'], deps1);
    await hqCmd(['token', 'create', '--client', 'client-1'], deps1);

    const before = await readHqAuthFile(dataDir);
    const clientId = before.clientTokens?.[0]?.id!;

    // Revoke the client token by prefix
    const deps2 = makeDeps();
    const code = await hqCmd(['token', 'revoke', '--client', clientId.slice(0, 8)], deps2);
    expect(code).toBe(0);

    const after = await readHqAuthFile(dataDir);
    // Client token gone
    expect(after.clientTokens ?? []).toHaveLength(0);
    // Browser token untouched
    expect(after.browserTokens ?? []).toHaveLength(1);
  });

  it('help output includes --client flag', async () => {
    const deps = makeDeps();
    const code = await hqCmd(['help'], deps);
    expect(code).toBe(0);

    const out = (deps.renderer as never as { captured: CapturedRenderer }).captured.out.join('');
    expect(out).toContain('--client');
    expect(out).toContain('create --client');
    expect(out).toContain('list --client');
    expect(out).toContain('revoke --client');
  });
});

// ── HTTP route auth tests ─────────────────────────────────────────────────

describe('HQ — HTTP route token auth (browser TOKEN MODE)', () => {
  it('rejects /api/snapshot without token when browser TOKEN MODE is active', async () => {
    const browserToken = 'browser-token-for-http';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 'bt-http-1', token: browserToken, createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/snapshot`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  it('accepts /api/snapshot with ?token= in browser TOKEN MODE', async () => {
    const browserToken = 'browser-token-query';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 'bt-http-2', token: browserToken, createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/snapshot?token=${browserToken}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { activeClients: number } };
    expect(body.totals).toBeDefined();
  });

  it('accepts /api/snapshot with Authorization: Bearer in browser TOKEN MODE', async () => {
    const browserToken = 'browser-token-bearer';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 'bt-http-3', token: browserToken, createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/snapshot`, {
      headers: { Authorization: `Bearer ${browserToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { activeClients: number } };
    expect(body.totals).toBeDefined();
  });

  it('serves dashboard HTML (/) without token in browser TOKEN MODE (shell is public, data stays gated)', async () => {
    // The shell must load token-less so the React app can render its
    // token-entry gate — a gated shell means a bare JSON 401 and no way to
    // enter a token. All telemetry still flows through /api/* and /ws/*,
    // which remain token-gated (asserted by the surrounding tests).
    const browserToken = 'browser-token-html';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 'bt-http-4', token: browserToken, createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('<!doctype html>');

    // The data plane is NOT opened up by the public shell.
    const api = await fetch(`http://127.0.0.1:${handle.port}/api/snapshot`);
    expect(api.status).toBe(401);
  });

  it('accepts dashboard HTML (/) with ?token= in browser TOKEN MODE', async () => {
    const browserToken = 'browser-token-html-ok';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 'bt-http-5', token: browserToken, createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const res = await fetch(`http://127.0.0.1:${handle.port}/?token=${browserToken}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // `/` serves either the React SPA (`<!doctype html>`) or the inline
    // HQ_HTML fallback (`<!DOCTYPE html>`) depending on whether the webui
    // dist is built. The point of this test is that a valid browser token
    // grants HTML access in token mode — assert HTML case-insensitively.
    expect(html.toLowerCase()).toContain('<!doctype html>');
  });

  it('rejects /api/projects/:id without token in browser TOKEN MODE', async () => {
    const browserToken = 'browser-token-proj';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 'bt-http-6', token: browserToken, createdAt: new Date().toISOString() },
      ],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/projects/some-project`);
    expect(res.status).toBe(401);
  });

  it('does NOT gate HTTP routes with client-only tokens', async () => {
    // Client tokens should NOT unlock HTTP routes — only browser tokens do.
    const clientToken = 'client-only-token-http';
    const authFile: HqAuthFile = {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      clientTokens: [{ id: 'ct-http-1', token: clientToken, createdAt: new Date().toISOString() }],
    };
    await writeHqAuthFile(dataDir, authFile);

    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    // No browser tokens → HTTP routes are in OPEN MODE
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/snapshot`);
    expect(res.status).toBe(200);
  });

  it('HTTP routes are open when explicit auth has no browser tokens (OPEN MODE)', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [],
    });
    const port = getPort();
    handle = await startHqServer({ port, dataDir });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/snapshot`);
    expect(res.status).toBe(200);
  });
});
