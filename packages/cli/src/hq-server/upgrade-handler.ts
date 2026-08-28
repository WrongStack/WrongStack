/**
 * WebSocket upgrade and connection dispatch for HQ server.
 *
 * @module hq-server/upgrade-handler
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { isLoopbackHost, type HqToken, hqTokenVerifier } from '@wrongstack/core/hq';
import type { WebSocket, WebSocketServer } from 'ws';
import * as HqServerAuth from './auth.js';
import type { HqAuthState } from './auth-state.js';
import {
  hasTrustedBrowserOrigin,
  parseHqSessionCookie,
} from './routes.js';
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
  browsers: Set<WebSocket>;
  eventLog: import('@wrongstack/core/hq').HqEventEnvelope[];
  transcripts: Map<string, TranscriptRing>;
  agentMessages: Map<string, import('@wrongstack/core/hq').HqTranscriptEntry[]>;
  persistence: import('@wrongstack/core/hq').HqPersistence;
  auditLog: import('@wrongstack/core/hq').HqCommandAuditLog;
  snapshotBroadcaster: ReturnType<typeof import('./snapshot.js').createSnapshotBroadcaster>;
  wss: WebSocketServer;
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

  if (
    !hasTrustedBrowserOrigin(
      req,
      deps.host,
      deps.listeningPort(),
      deps.trustedPublicOrigins,
      deps.allowFileOrigin,
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
    const cookieValid =
      pathname === '/ws/browser' &&
      deps.mutableAuth.cookieSecret !== undefined &&
      (() => {
        const raw = HqServerAuth.readHqSessionCookie(req.headers.cookie);
        if (!raw) return false;
        const sessionId = parseHqSessionCookie(raw, deps.mutableAuth.cookieSecret!);
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
          return [...deps.mutableAuth.browserTokenObjs.values()].some(
            (obj) => obj.id === session.tokenId,
          );
        }
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

export function handleHqConnection(
  ws: WebSocket,
  req: IncomingMessage,
  pathname: string,
  deps: HqUpgradeHandlerDeps,
): void {
  if (pathname === '/ws/browser') {
    HqServerWs.handleBrowser(ws, deps.snapshotBroadcaster, deps.browsers, deps.eventLog);
  } else {
    const token = new URL(req.url ?? '/', `http://${deps.host}:${deps.port}`).searchParams.get('token');
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
