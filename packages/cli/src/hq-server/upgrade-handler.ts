/**
 * WebSocket upgrade and connection dispatch for HQ server.
 *
 * @module hq-server/upgrade-handler
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type HqToken, hqTokenVerifier, isLoopbackHost, isTokenExpired } from '@wrongstack/core/hq';
import type { WebSocket, WebSocketServer } from 'ws';
import * as HqServerAuth from './auth.js';
import type { HqAuthState } from './auth-state.js';
import { resolveSocketAddress } from './client-address.js';
import type { HqIpAllowlist } from './ip-allowlist.js';
import { hasTrustedBrowserOrigin, parseHqSessionCookie } from './routes.js';
import type { ConnectedClient, HqSessionEntry, TranscriptRing } from './types.js';
import * as HqServerWs from './ws.js';

interface HqUpgradeHandlerDeps {
  host: string;
  port: number;
  listeningPort: () => number;
  trustedPublicOrigins: Set<string>;
  allowFileOrigin?: boolean | undefined;
  requireBrowserAuth?: boolean | undefined;
  mutableAuth: HqAuthState['mutableAuth'];
  sessions: Map<string, HqSessionEntry>;
  clients: Map<WebSocket, ConnectedClient>;
  clientSocketTokens: Map<WebSocket, HqToken | undefined>;
  /**
   * Session id that authorized each open browser socket, so token revocation
   * can close only the affected browsers. Absent for a socket that
   * authenticated with a bare loopback `?token=` rather than a cookie session;
   * the revocation path treats that absence as "affected" (fail closed).
   */
  browserSocketSessions: Map<WebSocket, string>;
  browsers: Set<WebSocket>;
  eventLog: import('@wrongstack/core/hq').HqEventEnvelope[];
  transcripts: Map<string, TranscriptRing>;
  agentMessages: Map<string, import('@wrongstack/core/hq').HqTranscriptEntry[]>;
  persistence: import('@wrongstack/core/hq').HqPersistence;
  auditLog: import('@wrongstack/core/hq').HqCommandAuditLog;
  snapshotBroadcaster: ReturnType<typeof import('./snapshot.js').createSnapshotBroadcaster>;
  wss: WebSocketServer;
  ipAllowlist?: HqIpAllowlist | undefined;
}

export function handleHqUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: HqUpgradeHandlerDeps,
): void {
  const url = new URL(req.url ?? '/', `http://${deps.host}:${deps.port}`);
  const pathname = url.pathname;

  if (pathname !== '/ws/client' && pathname !== '/ws/browser') {
    socket.destroy();
    return;
  }

  if (deps.ipAllowlist && !deps.ipAllowlist.allows(resolveSocketAddress(req))) {
    socket.write(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
        JSON.stringify({
          error: { code: 'IP_NOT_ALLOWED', message: 'Source IP is not allowed.' },
        }),
    );
    socket.destroy();
    return;
  }

  if (
    !hasTrustedBrowserOrigin(
      req,
      deps.host,
      deps.listeningPort(),
      deps.trustedPublicOrigins,
      deps.allowFileOrigin,
      // WS-SEC-06 — see the guard. `/ws/browser` and `/ws/client` are the two
      // surfaces this branch left uncontrolled in open mode.
      HqServerAuth.hqAuthRequired(deps.mutableAuth, deps.requireBrowserAuth),
    )
  ) {
    socket.write(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
        JSON.stringify({
          error: {
            code: 'INVALID_ORIGIN',
            message: 'Cross-origin WebSocket upgrade rejected.',
          },
        }),
    );
    socket.destroy();
    return;
  }

  const tokenSet =
    pathname === '/ws/browser' ? deps.mutableAuth.browserTokens : deps.mutableAuth.clientTokens;
  const needsAuth =
    pathname === '/ws/browser'
      ? HqServerAuth.hqAuthRequired(deps.mutableAuth, deps.requireBrowserAuth)
      : HqServerAuth.hqClientAuthRequired(deps.mutableAuth);
  if (needsAuth) {
    let supplied = url.searchParams.get('token') ?? '';
    if (supplied && pathname === '/ws/browser') {
      const requestHost = (req.headers.host ?? '').trim();
      let wsHostname = '';
      try {
        wsHostname = new URL(`http://${requestHost}`).hostname;
      } catch {
        /* unparseable Host → treat as non-loopback */
      }
      if (wsHostname && !isLoopbackHost(wsHostname)) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'hq.ws_token_from_query_rejected',
            message:
              'Browser token in WS query rejected on non-loopback — use session cookie instead.',
            timestamp: new Date().toISOString(),
          }),
        );
        supplied = '';
      }
    }
    const tokenValid = HqServerAuth.timingSafeTokenMatch(tokenSet, supplied) !== undefined;
    // Captured before the cookie branch: `mutableAuth` is re-projected by
    // every auth-file reload (`HqAuthState.apply`), so the guarded reference
    // and the used reference must be the same narrowed local, not a re-read.
    const cookieSecret = deps.mutableAuth.cookieSecret;
    const cookieValid =
      pathname === '/ws/browser' &&
      cookieSecret !== undefined &&
      (() => {
        const raw = HqServerAuth.readHqSessionCookie(req.headers.cookie);
        if (!raw) return false;
        const sessionId = parseHqSessionCookie(raw, cookieSecret);
        if (sessionId === undefined) return false;
        const session = deps.sessions.get(sessionId);
        if (!session || Date.now() - session.createdAt >= HqServerAuth.HQ_SESSION_MAX_AGE_MS)
          return false;
        const now2 = Date.now();
        if (
          !session.pending2fa &&
          now2 - session.lastSeenAt > HqServerAuth.HQ_SESSION_IDLE_TIMEOUT_MS
        )
          return false;
        session.lastSeenAt = now2;
        if (session.pending2fa) return false;
        if (session.kind === 'token' && session.tokenId !== undefined) {
          // Expiry is re-checked here, not only at projection time: the map
          // keeps a token that aged out after the last auth.json apply.
          const stillAuthorized = [...deps.mutableAuth.browserTokenObjs.values()].some(
            (obj) => obj.id === session.tokenId && !isTokenExpired(obj),
          );
          if (!stillAuthorized) return false;
        }
        // Recorded so the connection handoff — a different function, reached
        // through the ws `connection` event — can bind this socket to the
        // session that authorized it. That binding is what lets token
        // revocation close only the affected browsers instead of all of them.
        (req as HqUpgradeRequest).hqBrowserSessionId = sessionId;
        return true;
      })();
    if (!tokenValid && !cookieValid) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
          JSON.stringify({
            error: {
              code: 'UNAUTHORIZED',
              message:
                pathname === '/ws/browser'
                  ? 'A valid ?token= or password session is required for browser connections.'
                  : 'A valid ?token= is required for client connections in token mode.',
            },
          }),
      );
      socket.destroy();
      return;
    }
  }

  deps.wss.handleUpgrade(req, socket, head, (ws) => {
    deps.wss.emit('connection', ws, req, pathname);
  });
}

/**
 * The upgrade-time browser auth check and the connection handoff are different
 * functions, so the authorizing session id is carried across on the request.
 */
interface HqUpgradeRequest extends IncomingMessage {
  hqBrowserSessionId?: string;
}

export function handleHqConnection(
  ws: WebSocket,
  req: IncomingMessage,
  pathname: string,
  deps: HqUpgradeHandlerDeps,
): void {
  if (pathname === '/ws/browser') {
    // Bind this socket to the session that authorized it, so token revocation
    // can close only the affected browsers instead of every browser. A socket
    // with no recorded session authenticated with a bare `?token=` rather than
    // a cookie session; it stays deliberately unbindable, and the revocation
    // path treats "unknown" as affected (fail closed) rather than as safe.
    const sessionId = (req as HqUpgradeRequest).hqBrowserSessionId;
    if (sessionId !== undefined) {
      deps.browserSocketSessions.set(ws, sessionId);
      ws.once('close', () => deps.browserSocketSessions.delete(ws));
    }
    HqServerWs.handleBrowser(ws, deps.snapshotBroadcaster, deps.browsers, deps.eventLog);
  } else {
    const token = new URL(req.url ?? '/', `http://${deps.host}:${deps.port}`).searchParams.get(
      'token',
    );
    const authToken = token
      ? deps.mutableAuth.clientTokenObjs.get(hqTokenVerifier(token))
      : undefined;
    deps.clientSocketTokens.set(ws, authToken);
    ws.once('close', () => deps.clientSocketTokens.delete(ws));
    HqServerWs.handleClient(
      ws,
      deps.clients,
      deps.browsers,
      deps.eventLog,
      {
        ...(authToken ? { token: authToken } : {}),
        getOperatorPolicy: () => deps.mutableAuth.operatorPolicyOverride,
      },
      deps.snapshotBroadcaster,
      deps.transcripts,
      deps.agentMessages,
      deps.persistence,
      deps.auditLog,
    );
  }
}
