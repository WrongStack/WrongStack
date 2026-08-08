/**
 * End-to-end reproduction of the HQ token gate manual-entry failure.
 *
 * Simulates exactly what the React SPA does when the user pastes a token
 * into the gate and clicks Connect:
 *   1. fetch('/api/auth/status') with Origin header
 *   2. fetch('/api/auth/upgrade', POST, Authorization: Bearer <token>) with Origin
 *   3. fetch('/api/snapshot') with the returned Set-Cookie
 *
 * If step 2 fails, that mirrors what the user reports ("clicking continue
 * does nothing"); step 3 mirrors what happens on the subsequent page reload.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

const TOKEN = 'browser-token-for-manual-entry-test';

let handle: HqServerHandle | null = null;
let dataDir: string;
let tempRoot: string;
const capturedLog: string[] = [];

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-manual-entry-'));
  dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, { recursive: true });
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [{ id: 'r1', token: TOKEN, createdAt: new Date().toISOString() }],
  });
  capturedLog.length = 0;
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('manual entry: token paste + click Connect', () => {
  it('simulates the exact browser request the gate sends', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 31234, dataDir });
    const base = `http://127.0.0.1:${handle.port}`;

    // Step 1: page loads, the SPA calls /api/auth/status.
    const s1 = await fetch(`${base}/api/auth/status`, { headers: { Origin: base } });
    expect(s1.status).toBe(200);
    const s1Body = (await s1.json()) as { tokenMode?: boolean; loggedIn?: boolean };
    expect(s1Body.tokenMode).toBe(true);
    expect(s1Body.loggedIn).toBe(false);

    // Step 2: user pastes a token, clicks Connect — POST /api/auth/upgrade.
    const s2 = await fetch(`${base}/api/auth/upgrade`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: base,
      },
    });
    const s2Body = (await s2.json()) as { loggedIn?: boolean; upgraded?: boolean; error?: unknown };
    expect(s2.status, JSON.stringify(s2Body)).toBe(200);
    expect(s2Body.loggedIn).toBe(true);
    expect(s2Body.upgraded).toBe(true);
    expect(s2.headers.get('set-cookie')).toMatch(/HttpOnly/i);

    // Step 3: page reload, /api/snapshot must succeed with the new cookie.
    const cookie = (s2.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const s3 = await fetch(`${base}/api/snapshot`, {
      headers: { Cookie: cookie, Origin: base },
    });
    expect(s3.status).toBe(200);
  });
});
