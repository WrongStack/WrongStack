/**
 * Credential enforcement for HQ sockets that are ALREADY open.
 *
 * Neither side of a WebSocket re-presents its credential after the upgrade,
 * so every rule here is the only enforcement that credential gets once the
 * socket is live: revocation notices, expiry that happens with the clock
 * rather than with an auth.json write, and client tokens that stopped being
 * live.
 *
 * @module hq-server/socket-credentials
 */

import { type HqToken, hqTokenKey, isTokenExpired } from '@wrongstack/core/hq';
import { WebSocket } from 'ws';
import { HQ_SESSION_MAX_AGE_MS, hqClientAuthRequired } from './auth.js';
import type { HqRouterMutableAuth, HqSessionEntry } from './types.js';

export interface HqSocketCredentialState {
  mutableAuth: HqRouterMutableAuth;
  sessions: Map<string, HqSessionEntry>;
  browsers: Set<WebSocket>;
  /** Session that authorized each cookie-authenticated browser socket. */
  browserSocketSessions: Map<WebSocket, string>;
  /** Token each `/ws/client` socket authenticated with (absent in open mode). */
  clientSocketTokens: Map<WebSocket, HqToken | undefined>;
}

export interface HqSocketCredentialEnforcer {
  /**
   * Tell the browsers a token revocation can concern.
   *
   * This ONLY announces; it deliberately does not close. The auth.json
   * watcher owns eviction and does it precisely (it deletes the sessions
   * whose `tokenId` is no longer live, and distinguishes a password change
   * from a token change). Because the revocation hook fires from
   * `authState.apply`, which the watcher calls before its close loop, the
   * browser still learns why it is about to be disconnected.
   *
   * A socket bound to a password (or mobile) session, or to a session minted
   * from a DIFFERENT token, is untouched by the revocation — telling it anyway
   * made every password-signed dashboard re-validate and, having no stored
   * token to re-mint, sign itself out. A socket with no recorded session
   * authenticated with a bare `?token=` the server cannot attribute, so it is
   * told and re-validates on its own (fail closed).
   */
  announceRevokedTokens(keys: readonly string[], ids: readonly string[]): void;
  /** Close every `/ws/client` socket whose credential is no longer live. */
  closeUnauthorizedClientSockets(): void;
  /**
   * Credentials also die with the clock. The watcher reacts to file changes
   * only, so before this a client token or a token-backed browser session
   * that reached its `expiresAt` kept its open socket (telemetry in, commands
   * out) until the process restarted.
   */
  sweepExpiredSocketCredentials(now?: number): void;
  /** Close the browser sockets bound to a session that was just removed. */
  closeSessionSockets(sessionId: string, reason: string): void;
}

export function createHqSocketCredentialEnforcer(
  state: HqSocketCredentialState,
): HqSocketCredentialEnforcer {
  const closeSessionSockets = (sessionId: string, reason: string): void => {
    for (const [browser, boundSessionId] of state.browserSocketSessions) {
      if (boundSessionId === sessionId && browser.readyState === WebSocket.OPEN) {
        browser.close(1008, reason);
      }
    }
  };

  const closeUnauthorizedClientSockets = (): void => {
    const clientAuthRequired = hqClientAuthRequired(state.mutableAuth);
    for (const [clientSocket, authToken] of state.clientSocketTokens) {
      const stillAuthorized =
        authToken === undefined
          ? !clientAuthRequired
          : !isTokenExpired(authToken) &&
            state.mutableAuth.clientTokenObjs.has(hqTokenKey(authToken));
      if (!stillAuthorized) clientSocket.close(1008, 'Client authentication revoked');
    }
  };

  return {
    announceRevokedTokens(keys, ids) {
      const frame = JSON.stringify({ type: 'hq.auth_revoked', revokedTokenKeys: keys });
      const revokedIds = new Set(ids);
      for (const ws of state.browsers) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const sessionId = state.browserSocketSessions.get(ws);
        if (sessionId !== undefined) {
          const session = state.sessions.get(sessionId);
          const affected =
            session === undefined ||
            (session.kind === 'token' &&
              (session.tokenId === undefined || revokedIds.has(session.tokenId)));
          if (!affected) continue;
        }
        ws.send(frame);
      }
    },
    closeUnauthorizedClientSockets,
    sweepExpiredSocketCredentials(now = Date.now()) {
      closeUnauthorizedClientSockets();
      const expiredTokenIds = new Set(
        [...state.mutableAuth.browserTokenObjs.values()]
          .filter((token) => isTokenExpired(token, now))
          .map((token) => token.id),
      );
      for (const sessionId of new Set(state.browserSocketSessions.values())) {
        const session = state.sessions.get(sessionId);
        if (session === undefined) continue;
        const expired =
          now - session.createdAt >= HQ_SESSION_MAX_AGE_MS ||
          (session.kind === 'token' &&
            session.tokenId !== undefined &&
            expiredTokenIds.has(session.tokenId));
        if (!expired) continue;
        state.sessions.delete(sessionId);
        closeSessionSockets(sessionId, 'Browser session expired');
      }
    },
    closeSessionSockets,
  };
}
