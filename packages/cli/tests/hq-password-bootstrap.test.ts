/**
 * WS-049 — `localOpenBootstrap` lets an unauthenticated loopback caller set
 * the first HQ password on a fresh, open instance.
 *
 * The severity is worth stating precisely, because the fix follows from it.
 *
 * NOT a way in. In open mode (no browser tokens, no password) the control
 * plane is already reachable unauthenticated from loopback, so claiming the
 * password grants no access the caller did not already have.
 *
 * NOT reachable from a website. The router's origin guard runs before this
 * route; a browser always sends `Origin` on a POST and it must match the
 * request Host. Pinned below so that stays true.
 *
 * What it IS: silent lockout. The operator who never set a password is shut
 * out of their own HQ across restarts with nothing to tell them why. A
 * same-user local process can read the data dir and the console, so it cannot
 * be authenticated away by a loopback server — the honest mitigation is to
 * make the claim impossible to miss, not to pretend it can be prevented.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqAuthFile } from '@wrongstack/core/hq';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let dataDir: string;
let handle: HqServerHandle | undefined;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-pw-bootstrap-'));
});
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Fully open: no browser tokens, no password. */
async function startOpen(): Promise<HqServerHandle> {
  const auth: HqAuthFile = {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  };
  await writeHqAuthFile(dataDir, auth);
  handle = await startHqServer({ port: 0, exactPort: true, dataDir });
  return handle;
}

function setPassword(
  server: HqServerHandle,
  newPassword: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...headers },
    body: JSON.stringify({ newPassword }),
  });
}

describe('unauthenticated password claim is loud (WS-049)', () => {
  it('logs a warning naming the event and the remedy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const server = await startOpen();
      const response = await setPassword(server, 'a-very-long-passphrase-1');
      expect(response.status).toBeLessThan(400);

      const events = warn.mock.calls
        .flat()
        .filter((arg): arg is string => typeof arg === 'string')
        .map((line) => {
          try {
            return JSON.parse(line) as { event?: string; message?: string };
          } catch {
            return {};
          }
        });
      const claim = events.find((e) => e.event === 'hq.auth.password_claimed_unauthenticated');
      expect(claim, 'the claim must be audited').toBeDefined();
      // The operator needs to know what to DO, not just that something happened.
      expect(claim?.message).toMatch(/auth\.json/);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when an authenticated session changes the password', async () => {
    // The audit line has to mean something: if it fired on ordinary password
    // changes it would be noise the operator learns to ignore.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const server = await startOpen();
      await setPassword(server, 'first-passphrase-value-1');
      warn.mockClear();
      // Second call: a password now exists, so `localOpenBootstrap` is false
      // and the request is rejected as unauthenticated rather than re-claimed.
      const second = await setPassword(server, 'second-passphrase-value-2');
      expect(second.status).toBe(401);
      const claimed = warn.mock.calls
        .flat()
        .some((arg) => typeof arg === 'string' && arg.includes('password_claimed_unauthenticated'));
      expect(claimed).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the web-attacker path stays closed (WS-049)', () => {
  it('rejects a cross-origin claim before it reaches the bootstrap branch', async () => {
    // This is the position that would make the finding serious — any website
    // the operator visits. The router's origin guard must refuse it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const server = await startOpen();
      const response = await setPassword(server, 'attacker-chosen-passphrase', {
        Origin: 'https://evil.example',
      });
      expect(response.status).toBe(403);
      const claimed = warn.mock.calls
        .flat()
        .some((arg) => typeof arg === 'string' && arg.includes('password_claimed_unauthenticated'));
      expect(claimed, 'must be refused before the bootstrap branch runs').toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
