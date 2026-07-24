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
import * as path from 'node:path';
import type * as http from 'node:http';
import type { WebSocket } from 'ws';
import type { TrustBoundary } from '@wrongstack/core/security';
import { buildTranscriptFromEvents, type createHqPersistence, DEFAULT_HQ_REDACTION_POLICY, deriveHqProjectId, hashHqPassword, isLoopbackHost, mintHqCookieSecret, mutateHqAuthFile, resolveHqDataDir, tokenHasCapability, validateHqCommand, verifyHqPassword } from '@wrongstack/core/hq';
import type { HqSnapshot, HqAlertEngine, HqAlertRuleConfig, HqCommand, HqCommandAuditEntry, HqCommandAuditLog, HqEventEnvelope, HqQueuedCommand, HqRedactionPolicy, HqTimeseriesSample, HqToken, HqTranscriptEntry } from '@wrongstack/core/hq';
import type { createMailboxHttpRouter } from '@wrongstack/core/coordination';
import { type GlobalMailbox, type MailboxHttpAccessDecision, type MailboxHttpRateLimiter, resolveProjectDir } from '@wrongstack/core/coordination';
import { HQ_HTML } from '../hq-recovery-html.js';
import { resolveHqDistDir, serveHqStatic } from '../hq-static-serve.js';
import * as HqServerAuth from './auth.js';
import * as HqServerSnapshot from './snapshot.js';
import * as HqServerUtils from './utils.js';
import { authorizeHqCommand } from './trust-boundary.js';
import {
  handleApiAlerts,
  handleApiCommandsAudit,
  handleApiSystemHealth,
  handleApiSystemUpdate,
} from './routes/system-handlers.js';

// ── Re-exports for hq-server.ts backward compat ────────────────────────────

export const setHqSecurityHeaders = HqServerAuth.setHqSecurityHeaders;
export const hasTrustedBrowserOrigin = HqServerAuth.hasTrustedBrowserOrigin;
export const authenticateBrowserRequest = HqServerAuth.authenticateBrowserRequest;
export const isTokenAuth = HqServerAuth.isTokenAuth;
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
export const buildClientWsUrl = HqServerUtils.buildClientWsUrl;
export const agentRingKey = HqServerUtils.agentRingKey;
export const agentMessageToEntry = HqServerUtils.agentMessageToEntry;
export const readLocalSubagentTranscript = HqServerUtils.readLocalSubagentTranscript;
export const lanIPv4Addresses = HqServerUtils.lanIPv4Addresses;
export const hqRuntimeMarkerPath = HqServerUtils.hqRuntimeMarkerPath;

// ── Shared helpers used in routes ──────────────────────────────────────────

import type {
  ConnectedClient,
  HqRouterMutableAuth,
  HqSnapshotBroadcaster,
  ProjectDetail,
  TranscriptRing,
} from './types.js';

export type {
  ConnectedClient,
  HqSnapshotBroadcaster,
  ProjectDetail,
  TranscriptRing,
};

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  return address !== undefined && isLoopbackHost(address);
}

// ── Router dependency interface ────────────────────────────────────────────

export interface HqRouterMailboxGateway {
  mailbox: GlobalMailbox;
  router: ReturnType<typeof createMailboxHttpRouter>;
}

export interface HqRouterDeps {
  trustBoundary: TrustBoundary;
  host: string;
  listeningPort: number;
  trustedPublicOrigins: Set<string>;
  mutableAuth: HqRouterMutableAuth;
  sessions: Map<string, { createdAt: number }>;
  loginAttempts: Map<string, { count: number; blockedUntil: number; lastAttempt: number }>;
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
}

// ── Route handler factory ──────────────────────────────────────────────────

/**
 * Create the HTTP request listener that handles all `/api/*` routes as well
 * as static dashboard serving (React app or inline HTML fallback).
 *
 * Kept as a factory so the dependencies from the server setup closure are
 * explicitly visible — every closure reference is a named field.
 */
export function createHqRouter(deps: HqRouterDeps): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const {
    host,
    listeningPort,
    trustedPublicOrigins,
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
  } = deps;

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${listeningPort}`);
      setHqSecurityHeaders(res);

      // ── Origin guard (DNS-rebinding / CSRF boundary) ───────────────
      if (!hasTrustedBrowserOrigin(req, host, listeningPort, trustedPublicOrigins)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden: untrusted request origin' }));
        return;
      }

      // ── Auth gate for /api/* routes ────────────────────────────────
      if (
        url.pathname.startsWith('/api/') &&
        url.pathname !== '/api/auth/status' &&
        url.pathname !== '/api/login' &&
        (requireBrowserAuth ||
          mutableAuth.browserTokens.size > 0 ||
          mutableAuth.passwordHash)
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
        await handleApiAuthStatus(req, res, url, mutableAuth, sessions, requireBrowserAuth, trustedPublicOrigins, secureCookies);
        return;
      }

      if (url.pathname === '/api/login' && req.method === 'POST') {
        await handleApiLogin(req, res, mutableAuth, sessions, loginAttempts, secureCookies);
        return;
      }

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        await handleApiLogout(req, res, mutableAuth, sessions, secureCookies);
        return;
      }

      if (url.pathname === '/api/auth/password' && (req.method === 'POST' || req.method === 'DELETE')) {
        await handleApiPassword(req, res, mutableAuth, sessions, dataDir, secureCookies, requireBrowserAuth);
        return;
      }

      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(HqServerSnapshot.buildSnapshot(clients, { tokenStats: getTokenStats?.() })));
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
        await handleMailboxGateway(req, res, mailboxGatewayMatch, authorizeMailboxGateway, getMailboxGateway, dataDir);
        return;
      }

      const projectKanbanMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/kanban$/);
      if (projectKanbanMatch && req.method === 'GET') {
        const projectId = decodePathSegment(projectKanbanMatch[1]!);
        if (projectId === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Invalid project id.' } }));
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
        res.end(JSON.stringify(HqServerSnapshot.buildSnapshot(clients, { tokenStats: getTokenStats?.() })));
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
        await handleApiMailboxSend(req, res, mutableAuth, sessions, dataDir, getMailboxGateway, hqSessionTag);
        return;
      }

      const mailboxActionMatch = url.pathname.match(
        /^\/api\/mailbox\/messages\/([^/]+)\/action$/,
      );
      if (mailboxActionMatch && req.method === 'POST') {
        await handleMailboxAction(req, res, mailboxActionMatch, mutableAuth, sessions, dataDir, getMailboxGateway);
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
        await handleApiSessionAgentMessages(req, res, sessionAgentMsgMatch, agentMessages, transcripts);
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

async function handleApiAuthStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, { createdAt: number }>,
  requireBrowserAuth: boolean | undefined,
  trustedPublicOrigins: Set<string>,
  secureCookies: boolean | undefined,
): Promise<void> {
  const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
  const openMode =
    mutableAuth.browserTokens.size === 0 && mutableAuth.passwordHash === undefined;
  const localOpenMode = openMode && !requireBrowserAuth && isLoopbackRequest(req);
  const publicOrigin = trustedPublicOrigins.values().next().value;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      tokenMode: mutableAuth.browserTokens.size > 0,
      passwordMode: mutableAuth.passwordHash !== undefined,
      publicRelay: requireBrowserAuth === true || publicOrigin !== undefined,
      ...(publicOrigin !== undefined ? { publicOrigin } : {}),
      secureCookies: secureCookies === true,
      loggedIn: auth !== undefined || localOpenMode,
      authKind:
        auth === 'cookie'
          ? 'password'
          : isTokenAuth(auth)
            ? 'token'
            : localOpenMode
              ? 'open'
              : undefined,
    }),
  );
}

async function handleApiLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, { createdAt: number }>,
  loginAttempts: Map<string, { count: number; blockedUntil: number; lastAttempt: number }>,
  secureCookies: boolean | undefined,
): Promise<void> {
  if (!mutableAuth.passwordHash) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'PASSWORD_NOT_CONFIGURED',
          message: 'Password login is not enabled on this HQ server.',
        },
      }),
    );
    return;
  }

  const clientIp = req.socket.remoteAddress ?? 'unknown';
  const existing = loginAttempts.get(clientIp);
  if (existing && existing.blockedUntil > Date.now()) {
    const retryAfter = Math.ceil((existing.blockedUntil - Date.now()) / 1000);
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
    });
    res.end(
      JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many failed login attempts. Retry after ${retryAfter} seconds.`,
        },
      }),
    );
    return;
  }

  let body: { password?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as { password?: unknown };
  } catch (error) {
    writeInvalidBody(res, error);
    return;
  }

  if (typeof body.password !== 'string' || body.password.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'password is required' } }),
    );
    return;
  }

  const ok = await verifyHqPassword(body.password, mutableAuth.passwordHash);
  if (!ok || !mutableAuth.cookieSecret) {
    const prev = loginAttempts.get(clientIp);
    const count = (prev?.count ?? 0) + 1;
    const backoffMs = Math.min(2 ** count * 1000, 16_000);
    loginAttempts.set(clientIp, {
      count,
      blockedUntil: Date.now() + backoffMs,
      lastAttempt: Date.now(),
    });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'INVALID_PASSWORD', message: 'Invalid password.' } }),
    );
    return;
  }

  loginAttempts.delete(clientIp);
  const sessionId = randomUUID();
  sessions.set(sessionId, { createdAt: Date.now() });
  setHqSessionCookie(
    res,
    serializeHqSessionCookie(sessionId, mutableAuth.cookieSecret),
    secureCookies,
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ loggedIn: true }));
}

async function handleApiLogout(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, { createdAt: number }>,
  secureCookies: boolean | undefined,
): Promise<void> {
  const auth = authenticateBrowserRequest(req, new URL(req.url ?? '/', 'http://localhost'), mutableAuth, sessions);
  if (auth === 'cookie') {
    const cookies = parseCookieHeader(req.headers.cookie);
    const raw = cookies[HQ_SESSION_COOKIE];
    if (raw) {
      const sessionId = parseHqSessionCookie(raw, mutableAuth.cookieSecret ?? '');
      if (sessionId) sessions.delete(sessionId);
    }
  }
  clearHqSessionCookie(res, secureCookies);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ loggedIn: false }));
}

async function handleApiPassword(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, { createdAt: number }>,
  dataDir: string,
  secureCookies: boolean | undefined,
  requireBrowserAuth: boolean | undefined,
): Promise<void> {
  const auth = authenticateBrowserRequest(req, new URL(req.url ?? '/', 'http://localhost'), mutableAuth, sessions);
  const localOpenBootstrap =
    auth === undefined &&
    req.method === 'POST' &&
    mutableAuth.browserTokens.size === 0 &&
    mutableAuth.passwordHash === undefined &&
    isLoopbackRequest(req);
  if (auth === undefined && !localOpenBootstrap) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'AUTH_REQUIRED',
          message: 'A browser token or password session is required to manage the password.',
        },
      }),
    );
    return;
  }

  let body: { currentPassword?: unknown; newPassword?: unknown } = {};
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }),
    );
    return;
  }

  if (auth === 'cookie' && mutableAuth.passwordHash !== undefined) {
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (
      !currentPassword ||
      !(await verifyHqPassword(currentPassword, mutableAuth.passwordHash))
    ) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is invalid.' },
        }),
      );
      return;
    }
  }

  if (req.method === 'DELETE') {
    if (requireBrowserAuth && mutableAuth.browserTokens.size === 0) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'BROWSER_AUTH_REQUIRED',
            message:
              'Cannot remove the only browser authentication method while a public relay is active.',
          },
        }),
      );
      return;
    }
    const next = await mutateHqAuthFile(dataDir, (current) => {
      const updated = { ...current };
      delete updated.passwordHash;
      delete updated.cookieSecret;
      return updated;
    });
    applyAuthFile(mutableAuth, next);
    sessions.clear();
    clearHqSessionCookie(res, secureCookies);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        passwordMode: false,
        tokenMode: mutableAuth.browserTokens.size > 0,
        loggedIn: auth !== 'cookie' && isTokenAuth(auth),
      }),
    );
    return;
  }

  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (newPassword.length < 8 || newPassword.length > 1024) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'INVALID_PASSWORD', message: 'New password must be between 8 and 1024 characters.' },
      }),
    );
    return;
  }

  const passwordHash = await hashHqPassword(newPassword);
  const cookieSecret = mintHqCookieSecret();
  const next = await mutateHqAuthFile(dataDir, (current) => ({
    ...current,
    passwordHash,
    cookieSecret,
  }));
  applyAuthFile(mutableAuth, next);
  sessions.clear();

  if (auth === 'cookie' || localOpenBootstrap) {
    const sessionId = randomUUID();
    sessions.set(sessionId, { createdAt: Date.now() });
    setHqSessionCookie(
      res,
      serializeHqSessionCookie(sessionId, cookieSecret),
      secureCookies,
    );
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      passwordMode: true,
      tokenMode: mutableAuth.browserTokens.size > 0,
      loggedIn: true,
    }),
  );
}

async function handleMailboxGateway(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  authorizeMailboxGateway: (req: http.IncomingMessage, projectDir: string) => MailboxHttpAccessDecision,
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
  const canonicalPath = suffix
    ? `/mailbox/${suffix}${querySuffix}`
    : `/mailbox${querySuffix}`;
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
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'projectId is required' } }),
    );
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
  sessions: Map<string, { createdAt: number }>,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  auditLog: HqCommandAuditLog,
  trustBoundary: TrustBoundary,
): Promise<void> {
  const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
  const inBrowserTokenMode = mutableAuth.browserTokens.size > 0;
  const inPasswordMode = mutableAuth.passwordHash !== undefined;
  if ((inBrowserTokenMode || inPasswordMode) && !auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const tokenObj = isTokenAuth(auth)
    ? mutableAuth.browserTokenObjs.get(auth.token)
    : undefined;
  const canEnqueue =
    auth === 'cookie' ||
    !inBrowserTokenMode ||
    tokenObj?.capabilities === undefined ||
    tokenObj.capabilities.includes('control.enqueue');
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
    res.end(
      JSON.stringify({ error: 'unrecognized or malformed command', type: body.type }),
    );
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

  const enqueuedBy = auth === 'cookie' ? 'password-session' : (tokenObj?.id ?? 'open-mode');
  const authorization = await authorizeHqCommand({
    boundary: trustBoundary,
    command: validated,
    commandId,
    enqueuedBy,
    authMethod: auth === 'cookie' ? 'session' : 'bearer-token',
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
  sessions: Map<string, { createdAt: number }>,
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
  const token = isTokenAuth(auth) ? mutableAuth.browserTokenObjs.get(auth.token) : undefined;
  const canEnqueue =
    auth === 'cookie' ||
    mutableAuth.browserTokens.size === 0 ||
    token?.capabilities === undefined ||
    token.capabilities.includes('control.enqueue');
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
  const priority =
    mbody.priority === 'high' ? 'high' : mbody.priority === 'low' ? 'low' : 'normal';
  const audience = mbody.audience === 'leaders' ? 'leaders' : 'all';
  const mailboxType =
    mbody.type === 'queue'
      ? 'note'
      : ['note', 'ask', 'assign', 'steer', 'btw', 'broadcast', 'status', 'result', 'review'].includes(
            mbody.type,
          )
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
    res.end(JSON.stringify({ error: 'mailbox write failed', detail: String(err) }));
  }
}

async function handleMailboxAction(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  _mutableAuth: HqRouterMutableAuth,
  _sessions: Map<string, { createdAt: number }>,
  dataDir: string,
  getMailboxGateway: (projectDir: string) => HqRouterMailboxGateway,
): Promise<void> {
  const MAILBOX_ACTIONS = [
    'mark-read',
    'acknowledge',
    'reopen',
    'soft-delete',
    'restore',
  ] as const;

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
  if (typeof abody.readerId !== 'string' || abody.readerId.length === 0) {
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
    const readerId = abody.readerId;
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

async function handleApiSessions(res: http.ServerResponse): Promise<void> {
  const { SessionRegistry } = await import('@wrongstack/core/storage');
  const globalRoot = path.dirname(resolveHqDataDir());
  try {
    const registry = new SessionRegistry(globalRoot);
    const sessions = (await registry.list()) as unknown as Array<Record<string, unknown>>;
    const result = sessions
      .filter((s: { status?: string }) => s.status !== 'stale')
      .map((s: Record<string, unknown>) => ({
        sessionId: s.sessionId,
        projectSlug: s.projectSlug,
        projectName: s.projectName,
        projectRoot: s.projectRoot,
        workingDir: s.workingDir,
        status: s.status,
        pid: s.pid,
        startedAt: s.startedAt,
        lastHeartbeatAt: s.lastHeartbeatAt,
        agentCount: s.agentCount,
        agents: (s.agents as Array<Record<string, unknown>>).map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          currentTool: a.currentTool,
          iterations: a.iterations,
          toolCalls: a.toolCalls,
          lastActivityAt: a.lastActivityAt,
        })),
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

async function handleApiSessionEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  transcripts: Map<string, TranscriptRing>,
): Promise<void> {
  const { SessionRegistry, DefaultSessionStore } = await import('@wrongstack/core/storage');
  const { resolveWstackPaths } = await import('@wrongstack/core/utils');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const full = url.searchParams.get('full') === '1';
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
  const limit = Math.min(5000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
  const sessionId = decodePathSegment(match[1]!);
  if (sessionId === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid sessionId encoding' }));
    return;
  }

  const globalRoot = path.dirname(resolveHqDataDir());
  try {
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId).catch(() => null);

    let entries: HqTranscriptEntry[] = [];
    let source: 'disk' | 'stream' = 'stream';
    let status: string | undefined;
    let clientType: string | undefined;
    let projectName: string | undefined;

    if (entry && 'projectRoot' in entry) {
      const paths = resolveWstackPaths({ projectRoot: (entry as { projectRoot: string }).projectRoot, globalRoot });
      const store = new DefaultSessionStore({ dir: paths.projectSessions });
      const data = await store.load(sessionId).catch(() => null);
      if (data) {
        entries = buildTranscriptFromEvents(
          (data.events as unknown[]).map((e) => e as Record<string, unknown>),
        );
        source = 'disk';
        status = (entry as { status?: string }).status;
        clientType = (entry as { clientType?: string }).clientType;
        projectName = (entry as { projectName?: string }).projectName;
      }
    }

    if (entries.length === 0) {
      const ring = transcripts.get(sessionId);
      if (!ring && !entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      entries = ring ? ring.entries : [];
      source = 'stream';
      if (entry) {
        status = (entry as { status?: string }).status;
        clientType = (entry as { clientType?: string }).clientType;
        projectName = (entry as { projectName?: string }).projectName;
      }
    }

    const total = entries.length;
    const tail = full ? entries : entries.slice(-limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sessionId,
        source,
        ...(status !== undefined ? { status } : {}),
        ...(clientType !== undefined ? { clientType } : {}),
        ...(projectName !== undefined ? { projectName } : {}),
        total,
        entries: tail,
      }),
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

async function handleApiSessionAgentMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  agentMessages: Map<string, HqTranscriptEntry[]>,
  _transcripts: Map<string, TranscriptRing>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const sid = decodePathSegment(match[1]!);
  const aid = decodePathSegment(match[2]!);
  if (sid === null || aid === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session or agent id encoding' }));
    return;
  }
  const full = url.searchParams.get('full') === '1';
  const disk = await readLocalSubagentTranscript(sid, aid);
  const source: 'disk' | 'stream' = disk !== null ? 'disk' : 'stream';
  const all =
    disk !== null
      ? disk
      : (agentMessages.get(agentRingKey(sid, aid)) ?? agentMessages.get(aid) ?? []);
  const entries = full ? all : all.slice(-200);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({ subagentId: aid, sessionId: sid, source, total: all.length, entries }),
  );
}

async function handleApiAgentMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  agentMessages: Map<string, HqTranscriptEntry[]>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = decodePathSegment(match[1]!);
  if (id === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid agent id encoding' }));
    return;
  }
  const full = url.searchParams.get('full') === '1';
  const merged: HqTranscriptEntry[] = [];
  for (const [key, ring] of agentMessages) {
    if (key === id || key.endsWith(`::${id}`)) merged.push(...ring);
  }
  merged.sort((a, b) => a.ts.localeCompare(b.ts));
  const entries = full ? merged : merged.slice(-200);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ subagentId: id, total: merged.length, entries }));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveHqProjectRoot(
  globalRoot: string,
  ids: { sessionId?: string | undefined; projectId?: string | undefined },
): Promise<string | undefined> {
  // Dynamic import to avoid pulling in SessionRegistry at module level
  const fn = async (): Promise<string | undefined> => {
    const { SessionRegistry } = await import('@wrongstack/core/storage');
    try {
      const registry = new SessionRegistry(globalRoot);
      if (typeof ids.sessionId === 'string') {
        const entry = await registry.get(ids.sessionId).catch(() => null);
        if (entry?.projectRoot) return entry.projectRoot;
      }
      if (typeof ids.projectId === 'string') {
        const { createHash } = await import('node:crypto');
        const all = await registry.list().catch(() => []);
        const projectIds = new Map<string, string>();
        const projectIdForRoot = (projectRoot: string): string => {
          const cached = projectIds.get(projectRoot);
          if (cached !== undefined) return cached;
          const derived = deriveHqProjectId(projectRoot);
          projectIds.set(projectRoot, derived);
          return derived;
        };
        const match = all.find(
          (e: { projectSlug?: string; projectRoot: string }) =>
            e.projectSlug === ids.projectId ||
            projectIdForRoot(e.projectRoot) === ids.projectId ||
            createHash('sha256').update(e.projectRoot).digest('hex').slice(0, 12) === ids.projectId,
        );
        if (match) return match.projectRoot;
      }
    } catch {
      /* fall through */
    }
    return undefined;
  };
  return fn();
}

function applyAuthFile(
  mutableAuth: HqRouterMutableAuth,
  next: {
    browserTokens?: Array<{ token: string; id: string; capabilities?: string[] }>;
    clientTokens?: Array<HqToken>;
    redactionPolicy?: Partial<HqRedactionPolicy>;
    passwordHash?: string;
    cookieSecret?: string;
    alertRules?: HqAlertRuleConfig;
  },
): void {
  mutableAuth.operatorPolicy = {
    ...DEFAULT_HQ_REDACTION_POLICY,
    ...(next.redactionPolicy ?? {}),
  };
  mutableAuth.operatorPolicyOverride = next.redactionPolicy;
  mutableAuth.browserTokens = new Set((next.browserTokens ?? []).map((t) => t.token));
  mutableAuth.clientTokens = new Set((next.clientTokens ?? []).map((t) => t.token));
  mutableAuth.browserTokenObjs = new Map(
    (next.browserTokens ?? []).map((t) => [t.token, { id: t.id, ...(t.capabilities !== undefined ? { capabilities: t.capabilities } : {}) }]),
  );
  mutableAuth.clientTokenObjs = new Map(
    (next.clientTokens ?? []).map((token: HqToken) => [token.token, token]),
  );
  mutableAuth.passwordHash = next.passwordHash;
  mutableAuth.cookieSecret = next.cookieSecret;
  mutableAuth.alertRules = next.alertRules;
}
