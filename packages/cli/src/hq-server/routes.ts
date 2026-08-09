/**
 * HQ server — HTTP API route handlers.
 *
 * All routes for the HQ server's REST API live here, extracted from the
 * monolithic request handler in {@link startHqServerWithAuth}. A single
 * factory {@link createHqRouter} wires them into one request listener.
 *
 * @module hq-server/routes
 */

import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import * as path from 'node:path';
import type { createMailboxHttpRouter } from '@wrongstack/core/coordination';
import {
  type Mailbox,
  type MailboxHttpAccessDecision,
  type MailboxHttpRateLimiter,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import type {
  HqAlertEngine,
  HqCommand,
  HqCommandAuditEntry,
  HqCommandAuditLog,
  HqEventEnvelope,
  HqQueuedCommand,
  HqSnapshot,
  HqTimeseriesSample,
  HqTranscriptEntry,
} from '@wrongstack/core/hq';
import {
  type createHqPersistence,
  tokenHasCapability,
  validateHqCommand,
} from '@wrongstack/core/hq';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { WebSocket } from 'ws';
import { HQ_HTML } from '../hq-recovery-html.js';
import { resolveHqDistDir, serveHqStatic } from '../hq-static-serve.js';
import * as HqServerAuth from './auth.js';
import { resolveHqProjectRoot } from './project-root.js';
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
import { authorizeHqCommand } from './trust-boundary.js';
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
      setHqSecurityHeaders(res);

      // ── Origin guard (DNS-rebinding / CSRF boundary) ───────────────
      if (
        !hasTrustedBrowserOrigin(req, host, listeningPort(), trustedPublicOrigins, allowFileOrigin)
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
        hqAuthRequired(mutableAuth, requireBrowserAuth)
      ) {
        const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
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
        const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
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
        const projectId = decodePathSegment(projectKanbanMatch[1]!);
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

// ── Login rate-limit state (scoped to routes, mutable) ────────────────────

// ── Individual route handlers ──────────────────────────────────────────────

async function handleMailboxGateway(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  authorizeMailboxGateway: (
    req: http.IncomingMessage,
    projectDir: string,
  ) => MailboxHttpAccessDecision,
  getMailboxGateway: (projectDir: string) => HqRouterMailboxGateway,
  dataDir: string,
): Promise<void> {
  const projectId = decodePathSegment(match[1]!);
  if (projectId === null || projectId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'invalid projectId encoding' } }),
    );
    return;
  }
  const gatewayGlobalRoot = path.dirname(dataDir);
  const preliminaryAccess = authorizeMailboxGateway(_req, `project:${projectId}`);
  if (!preliminaryAccess.allowed) {
    res.writeHead(preliminaryAccess.status ?? 401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(preliminaryAccess.body));
    return;
  }
  const projectRoot = await resolveHqProjectRoot(gatewayGlobalRoot, { projectId });
  if (!projectRoot) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'NOT_FOUND', message: `Unknown project: ${projectId}` } }),
    );
    return;
  }
  const suffix = match[2];
  // Preserve the query string (e.g. `?sinceMs=…`) so the router's
  // `parseSinceMs` sees per-request overrides. Without this the HQ
  // gateway would forward the canonical path without the query and
  // the look-back filter would never engage — a silent contract
  // regression for clients that pass `?sinceMs=…` through HQ.
  const rawUrl = _req.url ?? '';
  const queryIndex = rawUrl.indexOf('?');
  const querySuffix = queryIndex === -1 ? '' : rawUrl.slice(queryIndex);
  const canonicalPath = suffix ? `/mailbox/${suffix}${querySuffix}` : `/mailbox${querySuffix}`;
  const projectDir = resolveProjectDir(projectRoot, gatewayGlobalRoot);
  await getMailboxGateway(projectDir).router.handle(_req, res, canonicalPath);
}

async function handleApiProjectDetail(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  clients: Map<WebSocket, ConnectedClient>,
): Promise<void> {
  const projectId = decodePathSegment(url.pathname.slice('/api/projects/'.length));
  if (projectId === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'invalid projectId encoding' } }),
    );
    return;
  }
  if (!projectId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'projectId is required' } }));
    return;
  }
  const detail = HqServerSnapshot.buildProjectDetail(clients, projectId);
  if (!detail) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'NOT_FOUND', message: `Unknown project: ${projectId}` } }),
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(detail));
}

async function handleApiEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  persistence: ReturnType<typeof createHqPersistence>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
  const limit = Math.min(5000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
  const typeFilter = url.searchParams.get('type') ?? undefined;
  const events = await persistence.eventLog.recent(limit, typeFilter);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events, total: events.length }));
}

async function handleApiTrendsCost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  persistence: ReturnType<typeof createHqPersistence>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawSince = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
  const since = Number.isFinite(rawSince) ? rawSince : 0;
  const samples: HqTimeseriesSample[] = await persistence.timeseries.read(since);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ samples }));
}

async function handleApiCommand(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  auditLog: HqCommandAuditLog,
  trustBoundary: TrustBoundary,
): Promise<void> {
  const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
  if (hqAuthRequired(mutableAuth) && !auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const canEnqueue = callerCanEnqueue(auth, mutableAuth);
  if (!canEnqueue) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden: token lacks control.enqueue capability' }));
    return;
  }

  let body: { clientId?: string; type?: string; payload?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as {
      clientId?: string;
      type?: string;
      payload?: unknown;
    };
  } catch (error) {
    writeInvalidBody(res, error);
    return;
  }
  if (typeof body.clientId !== 'string' || typeof body.type !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing clientId or type' }));
    return;
  }

  let target: ConnectedClient | undefined;
  for (const c of clients.values()) {
    if (c.clientId === body.clientId) {
      target = c;
      break;
    }
  }
  if (target === undefined) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'client not connected', clientId: body.clientId }));
    return;
  }
  if (!target.capabilities.includes('control.receive')) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'client does not accept control commands',
        clientId: body.clientId,
      }),
    );
    return;
  }

  const commandId = randomUUID();
  const queued: HqQueuedCommand = {
    commandId,
    type: body.type,
    createdAt: new Date().toISOString(),
    payload: body.payload ?? {},
    requiresAck: true,
  };
  const validated: HqCommand | null = validateHqCommand(queued);
  if (validated === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unrecognized or malformed command', type: body.type }));
    return;
  }

  if (
    validated.type === 'run-command' &&
    !tokenHasCapability(target.authToken, 'control.execute')
  ) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'forbidden: target client token lacks control.execute capability',
      }),
    );
    return;
  }

  const enqueuedBy = isCookieAuth(auth)
    ? (auth.tokenId ?? 'password-session')
    : isTokenAuth(auth)
      ? auth.id
      : 'open-mode';
  const authorization = await authorizeHqCommand({
    boundary: trustBoundary,
    command: validated,
    commandId,
    enqueuedBy,
    authMethod: isCookieAuth(auth) ? 'session' : 'bearer-token',
    target,
  });
  if (!authorization.allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `command denied: ${authorization.reason}` }));
    return;
  }

  target.commandQueue.push(queued);
  if (target.commandQueue.length > 200)
    target.commandQueue.splice(0, target.commandQueue.length - 200);

  const auditEntry: HqCommandAuditEntry = {
    commandId,
    type: validated.type,
    clientId: target.clientId,
    enqueuedBy,
    enqueuedAt: queued.createdAt,
    status: 'queued',
  };
  auditLog.record(auditEntry);
  HqServerSnapshot.broadcastCommandStatus(auditEntry, browsers);

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ commandId, queued: true, clientId: target.clientId }));
}

async function handleApiMailboxSend(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  dataDir: string,
  getMailboxGateway: (projectDir: string) => HqRouterMailboxGateway,
  hqSessionTag: string,
): Promise<void> {
  const auth = authenticateBrowserRequest(
    _req,
    new URL(_req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  // This route enqueues a message into a LIVE agent session — a control-plane
  // write. It had no 401 branch at all and leaned entirely on callerCanEnqueue,
  // which returned true whenever the browser-token set was empty. A missing
  // credential and an insufficient capability are distinct failures and must
  // not collapse into one status (WS-077).
  if (hqAuthRequired(mutableAuth) && !auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }));
    return;
  }
  const canEnqueue = callerCanEnqueue(auth, mutableAuth);
  if (!canEnqueue) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden: token lacks control.enqueue capability' }));
    return;
  }

  let mbody: {
    sessionId?: string;
    projectId?: string;
    type?: string;
    to?: string;
    subject?: string;
    body?: string;
    priority?: string;
    audience?: string;
  };
  try {
    mbody = JSON.parse(await readRequestBody(_req));
  } catch (error) {
    writeInvalidBody(res, error);
    return;
  }
  if (typeof mbody.type !== 'string' || typeof mbody.body !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing type or body' }));
    return;
  }
  if (typeof mbody.sessionId !== 'string' && typeof mbody.projectId !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing sessionId or projectId' }));
    return;
  }
  if (mbody.audience !== undefined && mbody.audience !== 'all' && mbody.audience !== 'leaders') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'audience must be all or leaders' }));
    return;
  }

  const mbGlobalRoot = path.dirname(dataDir);
  const projectRoot = await resolveHqProjectRoot(mbGlobalRoot, {
    sessionId: mbody.sessionId,
    projectId: mbody.projectId,
  });
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'could not resolve target project mailbox' }));
    return;
  }

  const to = typeof mbody.to === 'string' ? mbody.to : 'leader';
  const subject = typeof mbody.subject === 'string' ? mbody.subject : 'HQ prompt';
  const priority = mbody.priority === 'high' ? 'high' : mbody.priority === 'low' ? 'low' : 'normal';
  const audience = mbody.audience === 'leaders' ? 'leaders' : 'all';
  const mailboxType =
    mbody.type === 'queue'
      ? 'note'
      : [
            'note',
            'ask',
            'assign',
            'steer',
            'btw',
            'broadcast',
            'status',
            'result',
            'review',
          ].includes(mbody.type)
        ? (mbody.type as
            | 'note'
            | 'ask'
            | 'assign'
            | 'steer'
            | 'btw'
            | 'broadcast'
            | 'status'
            | 'result'
            | 'review')
        : undefined;
  if (mailboxType === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'unrecognized or malformed mailbox message',
        type: mbody.type,
      }),
    );
    return;
  }
  if (
    (mailboxType === 'assign' || mailboxType === 'steer') &&
    (to === '*' || to.trim().toLowerCase() === 'all')
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `${mailboxType} requires a specific recipient` }));
    return;
  }

  try {
    const projectDir = resolveProjectDir(projectRoot, mbGlobalRoot);
    const mailbox = getMailboxGateway(projectDir).mailbox;
    const from = `hq@${hqSessionTag}`;
    const deliveryTo = mailboxType === 'broadcast' ? 'all' : to;
    const sent = await mailbox.send({
      from,
      to: deliveryTo,
      type: mailboxType,
      subject,
      body: mbody.body,
      priority,
      audience,
    });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        delivered: true,
        messageId: sent?.id,
        to: sent?.to ?? deliveryTo,
        type: mailboxType,
        audience,
      }),
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    // WS-066: `String(err)` here forwarded the raw throw — absolute paths and
    // whatever the mailbox layer quoted back — to the browser, while the
    // sibling mailbox-action route two functions down already sanitized.
    res.end(JSON.stringify({ error: 'mailbox write failed', detail: sanitizeApiError(err) }));
  }
}

/**
 * Does this authenticated caller hold `control.enqueue`?
 *
 * WS-012: this predicate was inlined at two call sites with a subtly different
 * unauthenticated fallback (`!inBrowserTokenMode` vs
 * `mutableAuth.browserTokens.size === 0` — equivalent, but drifting), and a
 * third route, `POST /api/mailbox/messages/:id/action`, skipped it entirely:
 * its auth parameters were `_`-prefixed to mark them deliberately unused. That
 * left mailbox mutation (mark-read, acknowledge, reopen, soft-delete, restore)
 * reachable by any authenticated caller regardless of capability.
 *
 * One helper so the three cannot diverge again.
 */
function callerCanEnqueue(
  auth: ReturnType<typeof authenticateBrowserRequest>,
  mutableAuth: HqRouterMutableAuth,
): boolean {
  if (isCookieAuth(auth)) {
    return (
      auth.tokenId === undefined ||
      auth.capabilities === undefined ||
      auth.capabilities.includes('control.enqueue')
    );
  }
  if (isTokenAuth(auth)) {
    return auth.capabilities === undefined || auth.capabilities.includes('control.enqueue');
  }
  // No credential presented at all: only legitimate when HQ genuinely has no
  // auth configured. This previously tested `browserTokens.size === 0` alone,
  // so an all-expired token file or a live revocation (requireAuthFloor) read
  // as "open mode" and this returned true — unauthenticated enqueue into
  // running agents via /api/mailbox-send (WS-077).
  return !hqAuthRequired(mutableAuth);
}

async function handleMailboxAction(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  dataDir: string,
  getMailboxGateway: (projectDir: string) => HqRouterMailboxGateway,
): Promise<void> {
  // WS-012: this route mutates mailbox state (mark-read, acknowledge, reopen,
  // soft-delete, restore) but performed no capability check at all — its auth
  // parameters were `_`-prefixed as deliberately unused, unlike its three
  // siblings which all gate on control.enqueue.
  const auth = authenticateBrowserRequest(
    _req,
    new URL(_req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  if (hqAuthRequired(mutableAuth) && !auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (!callerCanEnqueue(auth, mutableAuth)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden: token lacks control.enqueue capability' }));
    return;
  }
  const MAILBOX_ACTIONS = ['mark-read', 'acknowledge', 'reopen', 'soft-delete', 'restore'] as const;

  let abody: {
    action?: string;
    readerId?: string;
    sessionId?: string;
    projectId?: string;
  };
  try {
    abody = JSON.parse(await readRequestBody(_req));
  } catch (error) {
    writeInvalidBody(res, error);
    return;
  }
  const mailId = decodePathSegment(match[1]!);
  if (mailId === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid mailId encoding' }));
    return;
  }
  const action = MAILBOX_ACTIONS.find((a) => a === abody.action);
  if (action === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unrecognized action', action: abody.action }));
    return;
  }
  // WS-012: readerId is written into the mailbox as "who acknowledged this".
  // Taking it from the request body let any caller attribute an acknowledgement
  // to someone else. Derive it from the authenticated identity when there is
  // one and fall back to the body only in open mode, where there is no identity
  // to derive.
  const authenticatedReaderId = isCookieAuth(auth)
    ? (auth.tokenId ?? 'hq-password-session')
    : isTokenAuth(auth)
      ? auth.id
      : undefined;
  const resolvedReaderId = authenticatedReaderId ?? abody.readerId;
  if (typeof resolvedReaderId !== 'string' || resolvedReaderId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing readerId' }));
    return;
  }
  if (typeof abody.sessionId !== 'string' && typeof abody.projectId !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing sessionId or projectId' }));
    return;
  }

  const actGlobalRoot = path.dirname(dataDir);
  const projectRoot = await resolveHqProjectRoot(actGlobalRoot, {
    sessionId: abody.sessionId,
    projectId: abody.projectId,
  });
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'could not resolve target project mailbox' }));
    return;
  }

  try {
    const { actionToAckInput } = await import('@wrongstack/core/coordination');
    const projectDir = resolveProjectDir(projectRoot, actGlobalRoot);
    const mailbox = getMailboxGateway(projectDir).mailbox;
    const readerId = resolvedReaderId;
    const message =
      action === 'soft-delete'
        ? await mailbox.softDelete(mailId, readerId)
        : action === 'restore'
          ? await mailbox.restore(mailId)
          : await mailbox.ack(actionToAckInput(action, { action, mailId, readerId }));
    if (message === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'message not found', mailId }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ action, mailId, message: null, changed: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'mailbox action failed',
        detail: sanitizeApiError(err),
      }),
    );
  }
}
