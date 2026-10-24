/**
 * Regression: `createHqSocketCredentialEnforcer.sweepExpiredSocketCredentials`
 * must evict sessions whose bound browser has already closed.
 *
 * The sweep previously iterated `state.browserSocketSessions.values()`, so a
 * session whose upgrade-handler `'close'` listener had already removed the
 * socket entry was invisible to the sweep and stayed in `state.sessions` for
 * the rest of the process lifetime. Long-running HQ with many short-lived
 * browser connections accumulated orphaned session entries without bound.
 *
 * Drives the real production source directly — no mocks on the path.
 *
 * @module tests/hq-socket-credential-sweep
 */

import { DEFAULT_HQ_REDACTION_POLICY } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { HQ_SESSION_MAX_AGE_MS } from '../src/hq-server/auth.js';
import {
  createHqSocketCredentialEnforcer,
  type HqSocketCredentialState,
} from '../src/hq-server/socket-credentials.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../src/hq-server/types.js';

// Mirror the production WebSocket readyState constants. socket-credentials.ts
// only touches `readyState` and `close()` on the socket, so a plain object
// with those two members is a faithful stand-in for the eviction path — no
// need to spin up a real `ws` server.
const OPEN = 1;
const CLOSED = 3;
const makeBrowser = (): WebSocket => {
  let readyState = OPEN;
  const socket = {
    get readyState() {
      return readyState;
    },
    close() {
      readyState = CLOSED;
    },
  };
  return socket as unknown as WebSocket;
};

const buildState = (): {
  state: HqSocketCredentialState;
  enforcer: ReturnType<typeof createHqSocketCredentialEnforcer>;
} => {
  const mutableAuth = {
    operatorPolicy: DEFAULT_HQ_REDACTION_POLICY,
    operatorPolicyOverride: undefined,
    browserTokens: new Set<string>(),
    clientTokens: new Set<string>(),
    browserTokenObjs: new Map(),
    clientTokenObjs: new Map(),
    passwordHash: undefined,
    cookieSecret: undefined,
    totpSecret: undefined,
    totpPendingSecret: undefined,
    totpRecoveryCodes: undefined,
    totpLastUsedCounter: undefined,
    alertRules: undefined,
    requireAuthFloor: undefined,
    requireBrowserAuth: undefined,
  } satisfies HqRouterMutableAuth;
  const state: HqSocketCredentialState = {
    mutableAuth,
    sessions: new Map<string, HqSessionEntry>(),
    browsers: new Set(),
    browserSocketSessions: new Map(),
    clientSocketTokens: new Map(),
  };
  const enforcer = createHqSocketCredentialEnforcer(state);
  return { state, enforcer };
};

describe('createHqSocketCredentialEnforcer.sweepExpiredSocketCredentials', () => {
  it('evicts an expired session whose browser is still open (control)', () => {
    const { state, enforcer } = buildState();
    const liveBrowser = makeBrowser();
    const sessionId = 'sess-control-live';
    state.sessions.set(sessionId, {
      createdAt: Date.now() - HQ_SESSION_MAX_AGE_MS - 1,
      kind: 'password',
      lastSeenAt: Date.now(),
    });
    state.browserSocketSessions.set(liveBrowser, sessionId);
    state.browsers.add(liveBrowser);

    enforcer.sweepExpiredSocketCredentials();

    expect(state.sessions.has(sessionId)).toBe(false);
  });

  it('evicts an expired orphan session whose browser already closed (regression)', () => {
    const { state, enforcer } = buildState();
    const closedBrowser = makeBrowser();
    // Simulate the upgrade-handler.ts:212 cleanup: the browser closed, the
    // browserSocketSessions entry is removed, but the session is left behind
    // — the orphan shape the sweep used to miss.
    closedBrowser.close();
    const sessionId = 'sess-target-orphan';
    state.sessions.set(sessionId, {
      createdAt: Date.now() - HQ_SESSION_MAX_AGE_MS - 1,
      kind: 'password',
      lastSeenAt: Date.now(),
    });
    // Deliberately NO browserSocketSessions entry: that is the orphan shape.
    expect(state.browserSocketSessions.has(closedBrowser)).toBe(false);

    enforcer.sweepExpiredSocketCredentials();

    expect(state.sessions.has(sessionId)).toBe(false);
  });

  it('does not evict a still-fresh orphan session', () => {
    const { state, enforcer } = buildState();
    const sessionId = 'sess-fresh-orphan';
    state.sessions.set(sessionId, {
      createdAt: Date.now(),
      kind: 'password',
      lastSeenAt: Date.now(),
    });

    enforcer.sweepExpiredSocketCredentials();

    expect(state.sessions.has(sessionId)).toBe(true);
  });
});

// H-3 (security-check 2026-09-26): a bare loopback `?token=` browser socket
// has no session, so the session sweep above never saw it — it kept
// streaming after its token expired by the clock.
describe('sweepExpiredSocketCredentials — bare-token browser sockets', () => {
  const withTokenSocket = (expiresAt: string | undefined) => {
    const built = buildState();
    const browser = makeBrowser();
    const key = 'verifier-1';
    built.state.mutableAuth.browserTokens.add(key);
    built.state.mutableAuth.browserTokenObjs.set(key, {
      id: 't1',
      ...(expiresAt ? { expiresAt } : {}),
    });
    built.state.browserSocketTokenKeys = new Map([[browser as never, key]]);
    return { ...built, browser, key };
  };

  it('closes the socket once its token has expired', () => {
    const { enforcer, browser } = withTokenSocket(new Date(Date.now() - 1000).toISOString());
    enforcer.sweepExpiredSocketCredentials();
    expect(browser.readyState).toBe(CLOSED);
  });

  it('closes the socket once its token is no longer live (revoked)', () => {
    const { state, enforcer, browser, key } = withTokenSocket(undefined);
    state.mutableAuth.browserTokens.delete(key);
    enforcer.sweepExpiredSocketCredentials();
    expect(browser.readyState).toBe(CLOSED);
  });

  it('leaves a socket with a live, unexpired token open', () => {
    const { enforcer, browser } = withTokenSocket(new Date(Date.now() + 60_000).toISOString());
    enforcer.sweepExpiredSocketCredentials();
    expect(browser.readyState).toBe(OPEN);
  });
});
