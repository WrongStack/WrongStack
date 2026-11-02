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
import type {
  createMailboxHttpRouter,
  Mailbox,
  MailboxHttpAccessDecision,
  MailboxHttpRateLimiter,
} from '@wrongstack/coordination';
import type { TrustBoundary } from '@wrongstack/core/security';
import type {
  createHqPersistence,
  HqAlertEngine,
  HqCommandAuditLog,
  HqEventEnvelope,
  HqNotifier,
  HqSnapshot,
  HqTranscriptEntry,
} from '@wrongstack/hq';
import { hqHostHealthThresholds } from '@wrongstack/hq';
import type { WebSocket } from 'ws';
import { HQ_HTML } from '../hq-recovery-html.js';
import { resolveHqDistDir, serveHqStatic } from '../hq-static-serve.js';
import type { HqAlertSettings } from './alert-settings.js';
import * as HqServerAuth from './auth.js';
import type { HqMailboxGatewayHealth } from './mailbox-gateway-health.js';
import { handleApiOperatorSettings } from './routes/alert-settings-handlers.js';
import { dispatchHqAuthRoutes } from './routes/auth-dispatch.js';
import type { ApplyHqAuthFile } from './routes/auth-handlers.js';
import { handleApiCommand } from './routes/command-handlers.js';
import {
  handleApiEvents,
  handleApiForgetMachine,
  handleApiHealthHistory,
  handleApiMachineLabels,
  handleApiProjectDetail,
  handleApiProjectKanban,
  handleApiSessionHistory,
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
  handleApiMailboxHealth,
  handleApiSystemHealth,
  handleApiSystemUpdate,
} from './routes/system-handlers.js';
import * as HqServerSnapshot from './snapshot.js';
import * as HqServerUtils from './utils.js';

// ── Re-exports for hq-server.ts backward compat ────────────────────────────

export const hasTrustedBrowserOrigin = HqServerAuth.hasTrustedBrowserOrigin;
export const authenticateBrowserRequest = HqServerAuth.authenticateBrowserRequest;
export const isTokenAuth = HqServerAuth.isTokenAuth;
export const isCookieAuth = HqServerAuth.isCookieAuth;
export const parseHqSessionCookie = HqServerAuth.parseHqSessionCookie;

export const decodePathSegment = HqServerUtils.decodePathSegment;
export const sanitizeApiError = HqServerUtils.sanitizeApiError;
export const buildHttpUrl = HqServerUtils.buildHttpUrl;
export const buildBootstrapHttpUrl = HqServerUtils.buildBootstrapHttpUrl;
export const buildClientWsUrl = HqServerUtils.buildClientWsUrl;
export const agentRingKey = HqServerUtils.agentRingKey;
export const agentMessageToEntry = HqServerUtils.agentMessageToEntry;
export const readLocalSubagentTranscript = HqServerUtils.readLocalSubagentTranscript;

// ── Shared helpers used in routes ──────────────────────────────────────────

import { resolveSocketAddress } from './client-address.js';
import type { HqIpAllowlist } from './ip-allowlist.js';
import type { LoginAttemptStore } from './login-attempt-store.js';
import type {
  ConnectedClient,
  HqRouterMutableAuth,
  HqSessionEntry,
  TranscriptRing,
} from './types.js';

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
  /**
   * W2 #14 (RFC hq-improvements-2026-09.md): mailbox gateway manager used
   * by `/api/health/mailbox` to surface the cockpit "Mailbox gateway"
   * card. Same manager that owns `mailboxGateways` and
   * `mailboxGatewayRateLimiter` — passed explicitly so the handler can
   * call `getHealth()` without reaching into a closure.
   */
  // Structural, not `MailboxGatewayManager`: importing that type closed a
  // 2-member type cycle back to ./mailbox-gateway-manager.js, which imports
  // from this module. Same dependency-leaf recipe as routes/system-handlers.ts.
  mailboxManager: {
    getHealth(): HqMailboxGatewayHealth;
  };
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
  bootstrapStore?: import('@wrongstack/hq').HqBootstrapCodeStore | undefined;
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
  /** TCP-peer allowlist shared by HTTP and WebSocket admission. */
  ipAllowlist?: HqIpAllowlist | undefined;
  /** Notification channels (`/api/notify*`); absent in embedded routers. */
  notifier?: HqNotifier | undefined;
  /** Alert thresholds, budgets and snoozes (`/api/alerts/settings`, rule snoozes). */
  alertSettings?: HqAlertSettings | undefined;
  /** Re-broadcast the snapshot after the machine roster changed. */
  onMachinesChanged?: (() => void) | undefined;
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
    mailboxManager,
    getTokenStats,
    trustBoundary,
    bootstrapStore,
    applyAuthFile,
    trustedProxyHops = 0,
    ipAllowlist,
    onMachinesChanged,
    notifier,
    alertSettings,
  } = deps;

  // `/api/snapshot` and `/api/fleet` serve the same tree, roster included.
  const fleetSnapshot = (): HqSnapshot =>
    HqServerSnapshot.buildSnapshot(clients, {
      tokenStats: getTokenStats?.(),
      roster: persistence.machines,
      history: persistence.sessionHistory,
      healthHistory: persistence.healthHistory,
      healthThresholds: hqHostHealthThresholds(alertSettings?.config() ?? {}),
    });
  const writeFleetSnapshot = (res: http.ServerResponse): void => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fleetSnapshot()));
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${listeningPort()}`);
      HqServerAuth.setHqSecurityHeaders(res);

      // Evaluate the real TCP peer before origin/auth. Forwarded headers are
      // deliberately irrelevant here: on a wildcard bind they are supplied
      // by the caller and therefore cannot be an admission credential.
      if (ipAllowlist && !ipAllowlist.allows(resolveSocketAddress(req))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden: source IP is not allowed' }));
        return;
      }

      // Minimal liveness/readiness endpoint for container supervisors. It is
      // intentionally data-free and still sits behind the TCP-peer allowlist.
      if (url.pathname === '/healthz' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // ── Origin guard (DNS-rebinding / CSRF boundary) ───────────────
      if (
        !HqServerAuth.hasTrustedBrowserOrigin(
          req,
          host,
          listeningPort(),
          trustedPublicOrigins,
          allowFileOrigin,
          // WS-SEC-06: tells the guard whether anything else can authenticate
          // this request. In open mode a missing Origin is only acceptable on
          // a loopback bind.
          HqServerAuth.hqAuthRequired(mutableAuth, requireBrowserAuth),
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
        url.pathname !== '/api/mobile/login' &&
        url.pathname !== '/api/mobile/login/verify' &&
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

      const authDeps = {
        mutableAuth,
        sessions,
        loginAttempts,
        dataDir,
        requireBrowserAuth,
        trustedPublicOrigins,
        secureCookies,
        trustedProxyHops,
        bootstrapStore,
        applyAuthFile,
      };
      if (await dispatchHqAuthRoutes(req, res, url, authDeps)) return;

      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        writeFleetSnapshot(res);
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

      // ── Mailbox gateway health (W2 #14) ──────────────────────────────
      // GET only. The handler is a synchronous wrapper over
      // `MailboxGatewayManager.getHealth()`; auth is gated by
      // `requireBrowserAuth` upstream in the router, not duplicated here.
      if (url.pathname === '/api/health/mailbox' && req.method === 'GET') {
        handleApiMailboxHealth(res, mailboxManager);
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

      if (await handleApiProjectKanban(req, res, url, persistence)) return;
      if (handleApiSessionHistory(req, res, url, persistence)) return;
      if (handleApiHealthHistory(req, res, url, persistence)) return;

      const machineTokens = { dataDir, applyAuthFile };
      const operator = { notifier, alertSettings, mutableAuth, sessions, machineTokens };
      if (await handleApiOperatorSettings(req, res, url, operator)) return;

      if (url.pathname.startsWith('/api/projects/') && req.method === 'GET') {
        await handleApiProjectDetail(req, res, url, clients);
        return;
      }

      // ── Fleet tree ────────────────────────────────────────────────
      if (url.pathname === '/api/fleet' && req.method === 'GET') {
        writeFleetSnapshot(res);
        return;
      }

      // ── Events ────────────────────────────────────────────────────
      if (url.pathname === '/api/events' && req.method === 'GET') {
        await handleApiEvents(req, res, persistence, clients);
        return;
      }

      // ── Machines: forget one that is offline ──────────────────────
      const machineMatch = url.pathname.match(/^\/api\/machines\/([^/]+)$/);
      if (machineMatch && req.method === 'DELETE') {
        handleApiForgetMachine(req, res, url, machineMatch[1]!, {
          mutableAuth,
          sessions,
          roster: persistence.machines,
          healthHistory: persistence.healthHistory,
          refresh: fleetSnapshot,
          onChanged: onMachinesChanged,
        });
        return;
      }

      // ── Machines: operator labels ─────────────────────────────────
      const labelsMatch = url.pathname.match(/^\/api\/machines\/([^/]+)\/labels$/);
      if (labelsMatch) {
        await handleApiMachineLabels(req, res, url, labelsMatch[1]!, {
          mutableAuth,
          sessions,
          roster: persistence.machines,
          refresh: fleetSnapshot,
          onChanged: onMachinesChanged,
        });
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
