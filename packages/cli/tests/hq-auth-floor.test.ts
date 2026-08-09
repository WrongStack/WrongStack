/**
 * WS-077 — the fail-closed auth floor must reach EVERY HQ gate.
 *
 * WS-010 added `requireAuthFloor` so that revoking the last credential on a
 * running, network-reachable `wstack hq` could not silently reopen it. The
 * latch was then honoured at only three of seven decision points; the other
 * four re-derived `browserTokens.size > 0 || passwordHash` inline and stayed
 * open. None of this was covered by a test, which is why the gap survived.
 *
 * These tests pin the predicate itself (the single source of truth) and the
 * two gates whose bypass had real teeth: `/api/mailbox-send`, which enqueues
 * into a live agent session, and the WebSocket upgrade.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqAuthFile } from '@wrongstack/core/hq';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hqAuthRequired, hqClientAuthRequired } from '../src/hq-server/auth.js';
import type { HqRouterMutableAuth } from '../src/hq-server/types.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

function mutableAuth(overrides: Partial<HqRouterMutableAuth> = {}): HqRouterMutableAuth {
  return {
    operatorPolicy: {} as HqRouterMutableAuth['operatorPolicy'],
    operatorPolicyOverride: undefined,
    browserTokens: new Set<string>(),
    clientTokens: new Set<string>(),
    browserTokenObjs: new Map(),
    clientTokenObjs: new Map(),
    alertRules: undefined,
    ...overrides,
  } as HqRouterMutableAuth;
}

describe('hqAuthRequired — single source of truth', () => {
  it('is false only when HQ genuinely has no credential and no floor', () => {
    expect(hqAuthRequired(mutableAuth())).toBe(false);
  });

  it('is true when browser tokens exist', () => {
    expect(hqAuthRequired(mutableAuth({ browserTokens: new Set(['k']) }))).toBe(true);
  });

  it('is true in password mode', () => {
    expect(hqAuthRequired(mutableAuth({ passwordHash: 'h' }))).toBe(true);
  });

  it('is true when requireBrowserAuth is forced on', () => {
    expect(hqAuthRequired(mutableAuth(), true)).toBe(true);
  });

  it('is true when the fail-closed floor is set even with ZERO credentials', () => {
    // The regression: an empty token set used to read as "open mode" at four
    // gates. This is the state after revoking the last token on a live wildcard
    // bind, and after an all-expired auth file is projected through liveTokens.
    expect(hqAuthRequired(mutableAuth({ requireAuthFloor: true }))).toBe(true);
  });
});

describe('hqClientAuthRequired — /ws/client counterpart', () => {
  it('is false with no client tokens and no floor', () => {
    expect(hqClientAuthRequired(mutableAuth())).toBe(false);
  });

  it('is true when client tokens exist', () => {
    expect(hqClientAuthRequired(mutableAuth({ clientTokens: new Set(['k']) }))).toBe(true);
  });

  it('is true under the floor with zero client tokens', () => {
    expect(hqClientAuthRequired(mutableAuth({ requireAuthFloor: true }))).toBe(true);
  });
});

describe('HQ gates reject unauthenticated callers when tokens are configured', () => {
  let dataDir: string;
  let handle: HqServerHandle | undefined;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-auth-floor-'));
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await handle?.close();
    handle = undefined;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function start(
    auth: HqAuthFile,
    options: { requireBrowserAuth?: boolean } = {},
  ): Promise<HqServerHandle> {
    await writeHqAuthFile(dataDir, auth);
    handle = await startHqServer({ port: 0, exactPort: true, dataDir, ...options });
    return handle;
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

  // NOTE ON COVERAGE. The zero-credential-but-auth-required state — the one the
  // four broken gates actually mishandled — cannot be constructed through
  // `startHqServer`: `requireBrowserAuth` with no token and no password is
  // refused outright by preflight, and `requireAuthFloor` is only ever set at
  // runtime by the auth-file watcher after the bind has already been assessed
  // as network-reachable. So that state is pinned by the predicate unit tests
  // above rather than end-to-end here. A server-level test that configures a
  // LIVE token would pass against the pre-WS-077 code too and prove nothing.
  it('/api/mailbox-send answers 401, not 403, when no credential is presented', async () => {
    const h = await start(
      authFile({
        browserTokens: [{ id: 'b1', token: 'browser-secret', createdAt: new Date().toISOString() }],
      }),
    );
    const res = await fetch(`http://127.0.0.1:${h.port}/api/mailbox-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${h.port}` },
      body: JSON.stringify({ projectId: 'p', to: 'agent', body: 'hello' }),
    });
    expect(res.status).toBe(401);
  });

  it('/ws/browser rejects an upgrade with no token when tokens are configured', async () => {
    const h = await start(
      authFile({
        browserTokens: [{ id: 'b1', token: 'browser-secret', createdAt: new Date().toISOString() }],
      }),
    );
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws/browser`, {
      headers: { Origin: `http://127.0.0.1:${h.port}` },
    });
    sockets.push(socket);
    const outcome = await new Promise<string>((resolve) => {
      socket.on('open', () => resolve('open'));
      socket.on('error', () => resolve('rejected'));
      socket.on('unexpected-response', () => resolve('rejected'));
    });
    expect(outcome).toBe('rejected');
  });
});
