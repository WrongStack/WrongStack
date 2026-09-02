/**
 * HQ server — HTTP API route handlers.
 *
 * All routes for the HQ server's REST API live here, extracted from the
 * monolithic request handler in {@link startHqServerWithAuth}. A single
 * factory {@link createHqRouter} wires them into one request listener.
 *
 * @module hq-server/routes
 */

import type * as http from 'node:http';
import type { createMailboxHttpRouter } from '@wrongstack/core/coordination';
import type {
  Mailbox,
  MailboxHttpAccessDecision,
  MailboxHttpRateLimiter,
} from '@wrongstack/core/coordination';
import type {
  HqAlertEngine,
  HqCommandAuditLog,
  HqEventEnvelope,
  HqSnapshot,
  HqTranscriptEntry,
} from '@wrongstack/core/hq';
import type { createHqPersistence } from '@wrongstack/core/hq';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { WebSocket } from 'ws';
import { HQ_HTML } from '../hq-recovery-html.js';
import { resolveHqDistDir, serveHqStatic } from '../hq-static-serve.js';
import * as HqServerAuth from './auth.js';
import {
  type ApplyHqAuthFile,
  callerCanAdministerAuth,
  handleApiAuthAudit,
  handleApiAuthSessions,
  handleApiAuthSessionsRevoke,
  handleApiAuthStatus,
  handleApiBootstrap,
  handleApiLogin,
  handleApiLoginVerify,
  handleApiLogout,
  handleApiPassword,
  handleApiTokenUpgrade,
  handleApiTotpDisable,
  handleApiTotpEnable,
  handleApiTotpSetup,
} from './routes/auth-handlers.js';
import { handleApiCommand } from './routes/command-handlers.js';
import {
  handleApiEvents,
  handleApiProjectDetail,
  handleApiTrendsCost,
} from './routes/data-handlers.js';
import {
  handleApiMailboxSend,
  handleMailboxAction,
  handleMailboxGateway,
} from './routes/mailbox-handlers.js';
import {
  handleApiAgentMessages,
  handleApiSessionAgentMessages,
  handleApiSessionEvents,
  handleApiSessions,
} from './routes/session-handlers.js';
import {
  handleApiAlerts,
  handleApiCommandsAudit,
  handleApiSystemHealth,
  handleApiSystemUpdate,
} from './routes/system-handlers.js';
import * as HqServerSnapshot from './snapshot.js';
import * as HqServerUtils from './utils.js';

// ── Re-exports for hq-server.ts backward compat ────────────────────────────

export const setHqSecurityHeaders = HqServerAuth.setHqSecurityHeaders;
export const hasTrustedBrowserOrigin = HqServerAuth.hasTrustedBrowserOrigin;
export const authenticateBrowserRequest = HqServerAuth.authenticateBrowserRequest;
export const isTokenAuth = HqServerAuth.isTokenAuth;
export const isCookieAuth = HqServerAuth.isCookieAuth;
export const hqAuthRequired = HqServerAuth.hqAuthRequired;
export const setHqSessionCookie = HqServerAuth.setHqSessionCookie;
export const clearHqSessionCookie = HqServerAuth.clearHqSessionCookie;
export const serializeHqSessionCookie = HqServerAuth.serializeHqSessionCookie;
export const parseHqSessionCookie = HqServerAuth.parseHqSessionCookie;
export const parseCookieHeader = HqServerAuth.parseCookieHeader;
export const HQ_SESSION_COOKIE = HqServerAuth.HQ_SESSION_COOKIE;

export const decodePathSegment = HqServerUtils.decodePathSegment;
export const readRequestBody = HqServerUtils.readRequestBody;
export const writeInvalidBody = HqServerUtils.writeInvalidBody;
export const sanitizeApiError = HqServerUtils.sanitizeApiError;
export const buildHttpUrl = HqServerUtils.buildHttpUrl;
export const buildBootstrapHttpUrl = HqServerUtils.buildBootstrapHttpUrl;
export const buildClientWsUrl = HqServerUtils.buildClientWsUrl;
export const agentRingKey = HqServerUtils.agentRingKey;
export const agentMessageToEntry = HqServerUtils.agentMessageToEntry;
export const readLocalSubagentTranscript = HqServerUtils.readLocalSubagentTranscript;
export const lanIPv4Addresses = HqServerUtils.lanIPv4Addresses;
export const hqRuntimeMarkerPath = HqServerUtils.hqRuntimeMarkerPath;

// ── Shared helpers used in routes ──────────────────────────────────────────

import type { LoginAttemptStore } from './login-attempt-store.js';
import type {
  ConnectedClient,
  HqRouterMutableAuth,
  HqSessionEntry,
  HqSnapshotBroadcaster,
  ProjectDetail,
  TranscriptRing,
} from './types.js';

export type { ConnectedClient, HqSnapshotBroadcaster, ProjectDetail, TranscriptRing };

// ── Router dependency interface ────────────────────────────────────────────

export interface HqRouterMailboxGateway {
  mailbox: Mailbox;
  router: ReturnType<typeof createMailboxHttpRouter>;
}

export interface HqRouterDeps {
  trustBoundary: TrustBoundary;
  host: string;
  /**
   * Getter, not a value. The router is constructed BEFORE `listen()`
   * resolves, so a copied number froze the REQUESTED port. When the default
   * is busy and `strictPort` is off, the scan binds `port+1` and the banner
   * prints it — but the origin guard kept comparing against the old number and
   * answered `403 forbidden: untrusted request origin` to the dashboard and
   * every `/api/*` call. (The WS upgrade handler read the live local, so the
   * failure looked like "the socket connects but the page won't load".)
   */
  listeningPort: () => number;
  trustedPublicOrigins: Set<string>;
  /** Trust `Origin: file://`. Off by default — see StartHqServerOptions (WS-081). */
  allowFileOrigin?: boolean | undefined;
  mutableAuth: HqRouterMutableAuth;
  sessions: Map<string, HqSessionEntry>;
  loginAttempts: LoginAttemptStore;
  clients: Map<WebSocket, ConnectedClient>;
  browsers: Set<WebSocket>;
  eventLog: HqEventEnvelope[];
  transcripts: Map<string, TranscriptRing>;
  agentMessages: Map<string, HqTranscriptEntry[]>;
  mailboxGateways: Map<string, HqRouterMailboxGateway>;
  mailboxGatewayRateLimiter: MailboxHttpRateLimiter;
  alertEngine: HqAlertEngine;
  auditLog: HqCommandAuditLog;
  persistence: ReturnType<typeof createHqPersistence>;
  dataDir: string;
  hqSessionTag: string;
  requireBrowserAuth: boolean | undefined;
  secureCookies: boolean | undefined;
  authorizeMailboxGateway: (
    req: http.IncomingMessage,
    projectDir: string,
  ) => MailboxHttpAccessDecision;
  getMailboxGateway: (projectDir: string) => HqRouterMailboxGateway;
  /** Aggregate token-expiry stats for snapshot totals + alert engine. */
  getTokenStats?: (() => HqSnapshot['totals']['tokenStats'] | undefined) | undefined;
  /** One-time bootstrap code store for token-to-cookie exchange. */
  bootstrapStore?: import('@wrongstack/core/hq').HqBootstrapCodeStore | undefined;
  /**
   * Applies a freshly-persisted `auth.json` to live server state. Bound to
   * `HqAuthState.apply` so the in-process mutation routes share one projection
   * — and one WS-010 exposure re-assessment — with the reload watcher.
   */
  applyAuthFile: ApplyHqAuthFile;
  /**
   * How many trusted reverse proxies sit in front of this server. Only used to
   * resolve the address the login backoff keys on — see `client-address.ts`.
   * Defaults to 0, which ignores `X-Forwarded-For` entirely.
   */
  trustedProxyHops?: number | undefined;
}

// ── Route handler factory ──────────────────────────────────────────────────

/**
 * Create the HTTP request listener that handles all `/api/*` routes as well
 * as static dashboard serving (React app or inline HTML fallback).
 *
 * Kept as a factory so the dependencies from the server setup closure are
 * explicitly visible — every closure reference is a named field.
 */
export function createHqRouter(
  deps: HqRouterDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const {
    host,
    listeningPort,
    trustedPublicOrigins,
    allowFileOrigin,
    mutableAuth,
    sessions,
    loginAttempts,
    clients,
    browsers,
    eventLog,
    transcripts,
    agentMessages,
    alertEngine,
    auditLog,
    persistence,
    dataDir,
    hqSessionTag,
    requireBrowserAuth,
    secureCookies,
    authorizeMailboxGateway,
    getMailboxGateway,
    getTokenStats,
    trustBoundary,
    bootstrapStore,
    applyAuthFile,
    trustedProxyHops = 0,
  } = deps;

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${listeningPort()}`);
      HqServerAuth.setHqSecurityHeaders(res);

      // ── Origin guard (DNS-rebinding / CSRF boundary) ───────────────
      if (
        !HqServerAuth.hasTrustedBrowserOrigin(
          req,
          host,
          listeningPort(),
          trustedPublicOrigins,
          allowFileOrigin,
        )
      ) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden: untrusted request origin' }));
        return;
      }

      // ── Auth gate for /api/* routes ────────────────────────────────
      if (
        url.pathname.startsWith('/api/') &&
        url.pathname !== '/api/auth/status' &&
        url.pathname !== '/api/login' &&
        url.pathname !== '/api/login/verify' &&
        url.pathname !== '/api/auth/bootstrap' &&
        HqServerAuth.hqAuthRequired(mutableAuth, requireBrowserAuth)
      ) {
        const auth = HqServerAuth.authenticateBrowserRequest(req, url, mutableAuth, sessions);
        if (!auth) {
          const tokenOnly = mutableAuth.browserTokens.size > 0 && !mutableAuth.passwordHash;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: tokenOnly ? 'INVALID_TOKEN' : 'UNAUTHORIZED',
                message: tokenOnly
                  ? 'A valid ?token= or Authorization: Bearer is required for HTTP access in browser token mode.'
                  : 'A valid browser token or password session is required.',
              },
            }),
          );
          return;
        }
      }

      // ── Static dashboard (React app, fallback inline HTML) ─────────
      const hqDistDir = resolveHqDistDir();
      const isApiOrWsPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/');
      if (hqDistDir !== null && !isApiOrWsPath) {
        const served = await serveHqStatic(req, res, url.pathname, hqDistDir);
        if (served.handled) return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HQ_HTML);
        return;
      }

      // ════════════════════════════════════════════════════════════════
      // HQ API routes
      // ════════════════════════════════════════════════════════════════

      if (url.pathname === '/api/auth/status' && req.method === 'GET') {
        await handleApiAuthStatus(
          req,
          res,
          url,
          mutableAuth,
          sessions,
          requireBrowserAuth,
          trustedPublicOrigins,
          secureCookies,
        );
        return;
      }

      // WS-102: the account-security surface (session list/revoke, auth audit,
      // TOTP enrollment) is gated on `auth.admin`, not merely on "authenticated".
      // The gate above proves a credential; this proves the credential is
      // allowed to change how HQ authenticates.
      if (
        (url.pathname === '/api/auth/audit' && req.method === 'GET') ||
        (url.pathname.startsWith('/api/auth/sessions') &&
          (req.method === 'GET' || req.method === 'DELETE')) ||
        (url.pathname.startsWith('/api/auth/totp/') && req.method === 'POST')
      ) {
        const auth = HqServerAuth.authenticateBrowserRequest(req, url, mutableAuth, sessions);
        if (auth !== undefined && !callerCanAdministerAuth(auth)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'AUTH_ADMIN_REQUIRED',
                message: "This endpoint requires the 'auth.admin' capability.",
              },
            }),
          );
          return;
        }
      }

      if (url.pathname === '/api/auth/audit' && req.method === 'GET') {
        handleApiAuthAudit(req, res, dataDir);
        return;
      }

      if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
        handleApiAuthSessions(req, res, mutableAuth, sessions);
        return;
      }

      if (url.pathname.startsWith('/api/auth/sessions') && req.method === 'DELETE') {
        await handleApiAuthSessionsRevoke(req, res, url, sessions);
        return;
      }

      if (url.pathname === '/api/login' && req.method === 'POST') {
        await handleApiLogin(
          req,
          res,
          mutableAuth,
          sessions,
          loginAttempts,
          secureCookies,
          trustedProxyHops,
        );
        return;
      }

      if (url.pathname === '/api/auth/bootstrap' && req.method === 'POST') {
        if (bootstrapStore) {
          await handleApiBootstrap(req, res, mutableAuth, sessions, secureCookies, bootstrapStore);
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'BOOTSTRAP_UNAVAILABLE',
                message: 'Bootstrap exchange is not enabled on this HQ server.',
              },
            }),
          );
        }
        return;
      }

      // WS-065: deliberately NOT in the gate's exemption list above — the gate
      // authenticating the Bearer token is exactly the proof this route needs.
      if (url.pathname === '/api/auth/upgrade' && req.method === 'POST') {
        await handleApiTokenUpgrade(req, res, url, mutableAuth, sessions, secureCookies);
        return;
      }

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        await handleApiLogout(req, res, mutableAuth, sessions, secureCookies);
        return;
      }

      if (url.pathname === '/api/login/verify' && req.method === 'POST') {
        await handleApiLoginVerify(
          req,
          res,
          url,
          mutableAuth,
          sessions,
          loginAttempts,
          dataDir,
          secureCookies,
          applyAuthFile,
          trustedProxyHops,
        );
        return;
      }

      if (url.pathname === '/api/auth/totp/setup' && req.method === 'POST') {
        await handleApiTotpSetup(req, res, mutableAuth, sessions, dataDir, applyAuthFile);
        return;
      }

      if (url.pathname === '/api/auth/totp/enable' && req.method === 'POST') {
        await handleApiTotpEnable(req, res, mutableAuth, sessions, dataDir, applyAuthFile);
        return;
      }

      if (url.pathname === '/api/auth/totp/disable' && req.method === 'POST') {
        await handleApiTotpDisable(
          req,
          res,
          mutableAuth,
          sessions,
          loginAttempts,
          dataDir,
          applyAuthFile,
          trustedProxyHops,
        );
        return;
      }

      if (
        url.pathname === '/api/auth/password' &&
        (req.method === 'POST' || req.method === 'DELETE')
      ) {
        await handleApiPassword(
          req,
          res,
          mutableAuth,
          sessions,
          dataDir,
          secureCookies,
          requireBrowserAuth,
          applyAuthFile,
        );
        return;
      }

      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            HqServerSnapshot.buildSnapshot(clients, { tokenStats: getTokenStats?.() }),
          ),
        );
        return;
      }

      if (url.pathname === '/api/system/update' && req.method === 'GET') {
        await handleApiSystemUpdate(res);
        return;
      }

      if (url.pathname === '/api/system/health' && req.method === 'GET') {
        await handleApiSystemHealth(res, clients, persistence, eventLog);
        return;
      }

      // ── Project-scoped mailbox gateway ────────────────────────────
      const mailboxGatewayMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/mailbox(?:\/(.*))?$/,
      );
      if (mailboxGatewayMatch) {
        await handleMailboxGateway(
          req,
          res,
          mailboxGatewayMatch,
          authorizeMailboxGateway,
          getMailboxGateway,
          dataDir,
        );
        return;
      }

      const projectKanbanMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/kanban$/);
      if (projectKanbanMatch && req.method === 'GET') {
        const projectId = HqServerUtils.decodePathSegment(projectKanbanMatch[1]!);
        if (projectId === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Invalid project id.' } }),
          );
          return;
        }
        const snapshot = await persistence.kanban.load(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot));
        return;
      }

      if (url.pathname.startsWith('/api/projects/') && req.method === 'GET') {
        await handleApiProjectDetail(req, res, url, clients);
        return;
      }

      // ── Fleet tree ────────────────────────────────────────────────
      if (url.pathname === '/api/fleet' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            HqServerSnapshot.buildSnapshot(clients, { tokenStats: getTokenStats?.() }),
          ),
        );
        return;
      }

      // ── Events ────────────────────────────────────────────────────
      if (url.pathname === '/api/events' && req.method === 'GET') {
        await handleApiEvents(req, res, persistence);
        return;
      }

      // ── Trends ────────────────────────────────────────────────────
      if (url.pathname === '/api/trends/cost' && req.method === 'GET') {
        await handleApiTrendsCost(req, res, persistence);
        return;
      }

      // ── Command ───────────────────────────────────────────────────
      if (url.pathname === '/api/command' && req.method === 'POST') {
        await handleApiCommand(
          req,
          res,
          url,
          mutableAuth,
          sessions,
          clients,
          browsers,
          auditLog,
          trustBoundary,
        );
        return;
      }

      // ── Mailbox send ──────────────────────────────────────────────
      if (url.pathname === '/api/mailbox-send' && req.method === 'POST') {
        await handleApiMailboxSend(
          req,
          res,
          mutableAuth,
          sessions,
          dataDir,
          getMailboxGateway,
          hqSessionTag,
        );
        return;
      }

      const mailboxActionMatch = url.pathname.match(/^\/api\/mailbox\/messages\/([^/]+)\/action$/);
      if (mailboxActionMatch && req.method === 'POST') {
        await handleMailboxAction(
          req,
          res,
          mailboxActionMatch,
          mutableAuth,
          sessions,
          dataDir,
          getMailboxGateway,
        );
        return;
      }

      // ── Commands audit ────────────────────────────────────────────
      if (url.pathname === '/api/commands' && req.method === 'GET') {
        await handleApiCommandsAudit(req, res, auditLog);
        return;
      }

      // ── Alerts ────────────────────────────────────────────────────
      if (url.pathname === '/api/alerts' && req.method === 'GET') {
        await handleApiAlerts(req, res, alertEngine);
        return;
      }

      // ── Sessions ──────────────────────────────────────────────────
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        await handleApiSessions(res);
        return;
      }

      const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (eventsMatch && req.method === 'GET') {
        await handleApiSessionEvents(req, res, eventsMatch, transcripts);
        return;
      }

      // ── Agent messages (session-scoped) ───────────────────────────
      const sessionAgentMsgMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/messages$/,
      );
      if (sessionAgentMsgMatch && req.method === 'GET') {
        await handleApiSessionAgentMessages(req, res, sessionAgentMsgMatch, agentMessages);
        return;
      }

      // ── Agent messages (legacy, un-scoped) ────────────────────────
      const agentMsgMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
      if (agentMsgMatch && req.method === 'GET') {
        await handleApiAgentMessages(req, res, agentMsgMatch, agentMessages);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'hq.http_handler_error',
          message: String(err),
          timestamp: new Date().toISOString(),
        }),
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  };
}
