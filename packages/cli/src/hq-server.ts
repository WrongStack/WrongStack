/**
 * HQ server — the read-only command-center backend for `wstack --hq`.
 *
 * Single HTTP server, single port. Two WebSocket upgrade paths:
 *   /ws/client  — TUI/REPL/WebUI clients publish telemetry
 *   /ws/browser — HQ browser connects and receives snapshot + events
 *
 * @module hq-server
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  createMailboxHttpRouter,
  createProjectMailbox,
  getSharedProjectMailbox,
  MAILBOX_HTTP_DEFAULT_MAX_AGE_MS,
  MailboxEventEmitter,
  type MailboxHttpAccessDecision,
  MailboxHttpRateLimiter,
} from '@wrongstack/core/coordination';
import {
  createHqPersistence,
  type EnsureHqFirstRunAuthResult,
  type HqAlert,
  HqAlertEngine,
  type HqAlertRuleConfig,
  type HqCommandAuditEntry,
  HqCommandAuditLog,
  type HqEventEnvelope,
  type HqTranscriptEntry,
  toAlertMessage,
  watchHqAuthFile,
} from '@wrongstack/core/hq';
import { createCompatibilityTrustBoundary, type TrustBoundary } from '@wrongstack/core/security';
import { WebSocket, WebSocketServer } from 'ws';
import { HQ_HTML } from './hq-recovery-html.js';
import * as HqServerAuth from './hq-server/auth.js';
import { createHqAuthState } from './hq-server/auth-state.js';
import { prepareHqServerStart } from './hq-server/preflight.js';
import {
  agentMessageToEntry,
  agentRingKey,
  authenticateBrowserRequest,
  buildClientWsUrl,
  buildHttpUrl,
  createHqRouter,
  decodePathSegment,
  HQ_SESSION_COOKIE,
  type HqRouterDeps,
  type HqRouterMailboxGateway,
  hasTrustedBrowserOrigin,
  isTokenAuth,
  parseCookieHeader,
  parseHqSessionCookie,
  readLocalSubagentTranscript,
  sanitizeApiError,
} from './hq-server/routes.js';
import * as HqServerSnapshot from './hq-server/snapshot.js';
import {
  clearHqRuntimeMarker,
  writeHqRuntimeMarker,
  writeHqStartupInfo,
} from './hq-server/startup.js';
import type { ConnectedClient, TranscriptRing } from './hq-server/types.js';
import * as HqServerWs from './hq-server/ws.js';

export { HqInsecureExposureError } from '@wrongstack/core/hq';
export type { ConnectedClient, TranscriptRing };

// ── Re-exports for backward compatibility ──────────────────────────────────

export { HQ_HTML };
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3499;
export const MAX_EVENT_LOG = 5000;
export const MAX_NON_STRICT_PORT_SCAN = 50;
export const CLIENT_TTL_MS = 60_000;
export const CLIENT_CLEANUP_INTERVAL_MS = 30_000;
export const BROWSER_HEARTBEAT_INTERVAL_MS = 15_000;
export const SESSION_SNAPSHOT_TTL_MS = 30_000;

export {
  agentMessageToEntry,
  agentRingKey,
  decodePathSegment,
  readLocalSubagentTranscript,
  sanitizeApiError,
};

// ── Public interfaces ──────────────────────────────────────────────────────

export interface HqServerOptions {
  /** Policy authority for control-plane command enqueue decisions. */
  trustBoundary?: TrustBoundary | undefined;
  host?: string;
  port?: number;
  strictPort?: boolean;
  exactPort?: boolean;
  dataDir?: string;
  browserHeartbeatIntervalMs?: number;
  clientTtlMs?: number;
  clientCleanupIntervalMs?: number;
  sessionSnapshotTtlMs?: number;
  password?: string;
  allowInsecureOpen?: boolean;
  secureCookies?: boolean;
  requireBrowserAuth?: boolean;
  /**
   * Optional time-to-live (milliseconds) stamped on the first-run browser
   * and client tokens minted on a brand-new HQ data directory. Existing
   * auth.json files are not modified. When set, tokens carry an `expiresAt`
   * and the server refuses them past that timestamp; default is no expiry.
   *
   * Useful for short-lived deployments (CI, ephemeral relays) where a leaked
   * first-run token should not outlive the deployment window. Set via the
   * `--hq-token-ttl-ms` CLI flag.
   */
  tokenTtlMs?: number;
}

export interface HqStartupConnectionInfo {
  dataDir: string;
  browserUrl: string;
  clientUrl: string;
  clientEnv: {
    WRONGSTACK_HQ_URL: string;
    WRONGSTACK_HQ_TOKEN?: string;
  };
  createdAuth: boolean;
  browserTokenMode: boolean;
  passwordMode: boolean;
}

export type HqFirstRunSetup = HqStartupConnectionInfo;

export interface HqServerHandle {
  host: string;
  port: number;
  firstRunSetup?: HqFirstRunSetup;
  trustPublicOrigin(origin: string): void;
  close(): Promise<void>;
}

// ── Server entry points ────────────────────────────────────────────────────

export async function startHqServer(options: HqServerOptions = {}): Promise<HqServerHandle> {
  const { host, port, dataDir, firstRunAuth } = await prepareHqServerStart(options, {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
  });
  return startHqServerWithAuth(options, host, port, dataDir, firstRunAuth);
}

function startHqServerWithAuth(
  options: HqServerOptions,
  host: string,
  port: number,
  dataDir: string,
  firstRunAuth: EnsureHqFirstRunAuthResult,
): Promise<HqServerHandle> {
  const trustBoundary =
    options.trustBoundary ??
    createCompatibilityTrustBoundary({ policyId: 'hq-trusted-host-compat-v1' });
  const authFile = firstRunAuth.authFile;

  const authState = createHqAuthState(authFile, dataDir);
  const { mutableAuth } = authState;

  console.warn(
    JSON.stringify({
      level: 'info',
      event: 'hq.startup',
      message: 'WrongStack HQ starting',
      dataDir,
      host,
      port,
      operatorPolicyActive: authFile.redactionPolicy !== undefined,
      browserTokenMode: mutableAuth.browserTokens.size > 0,
      clientTokenMode: mutableAuth.clientTokens.size > 0,
      passwordMode: mutableAuth.passwordHash !== undefined,
      timestamp: new Date().toISOString(),
    }),
  );

  return new Promise((resolve, reject) => {
    const trustedPublicOrigins = new Set<string>();
    let listeningPort = port;
    const clients = new Map<WebSocket, ConnectedClient>();
    const browsers = new Set<WebSocket>();
    const sessions = new Map<string, { createdAt: number }>();
    const eventLog: HqEventEnvelope[] = [];
    const transcripts = new Map<string, TranscriptRing>();
    const agentMessages = new Map<string, HqTranscriptEntry[]>();
    const mailboxGateways = new Map<string, HqRouterMailboxGateway>();
    const mailboxGatewayRateLimiter = new MailboxHttpRateLimiter();
    const mailboxGatewayRateLimitCleanup = setInterval(
      () => mailboxGatewayRateLimiter.cleanup(),
      120_000,
    );
    mailboxGatewayRateLimitCleanup.unref?.();

    // ── Login rate limiting ────────────────────────────────────────────────
    const loginAttempts = new Map<
      string,
      { count: number; blockedUntil: number; lastAttempt: number }
    >();
    const LOGIN_ATTEMPT_RETENTION_MS = 15 * 60_000;

    // ── Browser-session lifecycle ──────────────────────────────────────────
    const HQ_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const SESSION_CLEANUP_INTERVAL_MS = 60_000;
    const sessionCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - HQ_SESSION_MAX_AGE_MS;
      for (const [id, session] of sessions) {
        if (session.createdAt < cutoff) sessions.delete(id);
      }
      const now = Date.now();
      for (const [ip, entry] of loginAttempts) {
        if (now - entry.lastAttempt > LOGIN_ATTEMPT_RETENTION_MS) loginAttempts.delete(ip);
      }
    }, SESSION_CLEANUP_INTERVAL_MS);
    sessionCleanupTimer.unref?.();

    // ── Persistence ────────────────────────────────────────────────────────
    const persistence = createHqPersistence(dataDir);
    const auditLog = new HqCommandAuditLog(1000, (entry) => persistence.commandLog.append(entry));

    // One-shot startup housekeeping: purge stale client registrations from
    // every known project's mailbox.
    //
    // Each `getSharedProjectMailbox` here *starts* that project's mailbox
    // daemon if it isn't already running, and the shared wrapper keeps its IPC
    // connection open for the life of this process. Leaving them open pinned
    // every daemon alive permanently: `mailbox-project-server`'s idle-stop is
    // gated on `clients.size === 0`, so one lingering connection per project
    // defeats it. Measured on a machine with 165 project directories: 165
    // resident daemons at ~63 MB each, ~10.4 GB, none of which had ever served
    // a request after this sweep. Closing each mailbox releases the connection
    // so idle daemons shut themselves down on their own 5-minute timer.
    void (async () => {
      const projectsDir = path.join(path.dirname(dataDir), 'projects');
      const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const projectDir = path.join(projectsDir, entry.name);
            // Sweep only projects whose daemon is actually running.
            //
            // `getSharedProjectMailbox` *starts* a daemon when none is live,
            // so an unconditional sweep turns HQ startup into one spawn per
            // project directory — measured at 165 on a real machine. Metadata
            // presence alone is not enough of a filter either: a daemon that
            // was killed rather than stopped leaves its file behind, and 163
            // of those 165 were exactly that.
            //
            // A dead owner has no clients to purge (its registrations died
            // with it), so skipping costs nothing; clear the orphaned file
            // while we are here so it stops advertising a daemon that is gone.
            const metadataPath = path.join(projectDir, '.mailbox-server.json');
            const ownerPid = await fs
              .readFile(metadataPath, 'utf8')
              .then((raw) => (JSON.parse(raw) as { pid?: number }).pid)
              .catch(() => undefined);
            if (ownerPid === undefined) return;
            let ownerAlive = false;
            try {
              process.kill(ownerPid, 0);
              ownerAlive = true;
            } catch {
              ownerAlive = false;
            }
            if (!ownerAlive) {
              await fs.rm(metadataPath, { force: true }).catch(() => {});
              return;
            }
            const mailbox = getSharedProjectMailbox(projectDir);
            try {
              await Promise.all([mailbox.getAgentStatuses(), mailbox.purgeClients()]);
            } finally {
              await mailbox.close().catch(() => {});
            }
          }),
      );
    })().catch(() => {});
    const hqSessionTag = randomUUID().slice(0, 8);

    const authorizeMailboxGateway = (
      req: http.IncomingMessage,
      projectDir: string,
    ): MailboxHttpAccessDecision => {
      const requestUrl = new URL(req.url ?? '/', `http://${host}:${port}`);
      const auth = authenticateBrowserRequest(req, requestUrl, mutableAuth, sessions);
      const tokenMode = mutableAuth.browserTokens.size > 0;
      const passwordMode = mutableAuth.passwordHash !== undefined;
      if ((tokenMode || passwordMode) && auth === undefined) {
        return {
          allowed: false,
          status: 401,
          body: { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } },
        };
      }
      const token = isTokenAuth(auth) ? mutableAuth.browserTokenObjs.get(auth.token) : undefined;
      const canUseMailbox =
        auth === 'cookie' ||
        !tokenMode ||
        token?.capabilities === undefined ||
        token.capabilities.includes('control.enqueue');
      if (!canUseMailbox) {
        return {
          allowed: false,
          status: 403,
          body: {
            error: {
              code: 'FORBIDDEN',
              message: 'forbidden: token lacks control.enqueue capability',
            },
          },
        };
      }
      const identity = isTokenAuth(auth) ? auth.id : auth === 'cookie' ? 'cookie' : 'open';
      return { allowed: true, rateLimitKey: `hq:${identity}:${projectDir}` };
    };

    const getMailboxGateway = (projectDir: string): HqRouterMailboxGateway => {
      const existing = mailboxGateways.get(projectDir);
      if (existing) return existing;
      const eventEmitter = new MailboxEventEmitter();
      const mailbox = createProjectMailbox({ projectDir, eventEmitter });
      const router = createMailboxHttpRouter({
        mailbox,
        eventEmitter,
        rateLimiter: mailboxGatewayRateLimiter,
        authorize: (request) => authorizeMailboxGateway(request, projectDir),
        // Wire the 1h look-back that the router's docs promise at
        // mailbox-http-router.ts:25-32 / :47-62. The router itself is
        // opt-in (L146-152): without this option, every retained
        // message would be returned. Per-request opt-in to the full
        // history remains available via `?sinceMs=0`.
        defaultMaxAgeMs: MAILBOX_HTTP_DEFAULT_MAX_AGE_MS,
      });
      const gateway = { mailbox, router };
      mailboxGateways.set(projectDir, gateway);
      return gateway;
    };

    // ── Alerting ───────────────────────────────────────────────────────────
    const alertEngine = new HqAlertEngine({
      onAlert: (alert) => {
        const msg = toAlertMessage(alert);
        const data = JSON.stringify(msg);
        for (const ws of browsers) {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        }
      },
      onPersist: (alert) => persistence.alertLog.append(alert),
    });
    void persistence.eventLog.hydrate().catch(() => undefined);
    void persistence.timeseries.load().catch(() => undefined);
    persistence.eventLog
      .recent(MAX_EVENT_LOG)
      .then((prior) => {
        for (let i = prior.length - 1; i >= 0; i--) eventLog.push(prior[i]!);
      })
      .catch(() => {});
    persistence.alertLog
      .readAll()
      .then((prior) => {
        alertEngine.seed(prior as readonly HqAlert[]);
      })
      .catch(() => {});
    persistence.commandLog
      .readAll()
      .then((prior) => {
        auditLog.seed(prior as readonly HqCommandAuditEntry[]);
      })
      .catch(() => {});

    const timeseriesFlushTimer = setInterval(() => {
      persistence.timeseries.flush();
    }, 60_000);
    timeseriesFlushTimer.unref?.();

    const snapshotBroadcaster = HqServerSnapshot.createSnapshotBroadcaster(
      clients,
      browsers,
      persistence,
    );
    snapshotBroadcaster.currentSerialized();

    const stopAlertEngine = alertEngine.startPeriodic(
      () => HqServerSnapshot.buildSnapshot(clients, { tokenStats: authState.tokenStats() }),
      (): HqAlertRuleConfig | undefined => mutableAuth.alertRules,
    );

    // ── Stale client cleanup ───────────────────────────────────────────────
    const clientTtlMs = options.clientTtlMs ?? CLIENT_TTL_MS;
    const sessionSnapshotTtlMs = options.sessionSnapshotTtlMs ?? SESSION_SNAPSHOT_TTL_MS;
    const cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - clientTtlMs;
      const sessionCutoff = Date.now() - sessionSnapshotTtlMs;
      let changed = false;
      for (const [ws, client] of clients.entries()) {
        if (new Date(client.lastSeenAt).getTime() < cutoff) {
          ws.terminate();
          clients.delete(ws);
          changed = true;
          continue;
        }
        const expiredSessions = new Set<string>();
        for (const [sessionId, tracked] of client.sessions.entries()) {
          if (tracked.receivedAt < sessionCutoff) {
            client.sessions.delete(sessionId);
            client.mcpSnapshots.delete(sessionId);
            expiredSessions.add(sessionId);
            changed = true;
          }
        }
        for (const [runId, fleet] of client.fleets) {
          if (fleet.sessionId !== undefined && expiredSessions.has(fleet.sessionId)) {
            client.fleets.delete(runId);
            changed = true;
          }
        }
        if (
          client.capabilities.includes('session.summary') &&
          client.sessions.size === 0 &&
          Date.now() - Date.parse(client.connectedAt) > sessionSnapshotTtlMs
        ) {
          ws.terminate();
          clients.delete(ws);
          changed = true;
        }
      }
      if (changed) snapshotBroadcaster.broadcast();
    }, options.clientCleanupIntervalMs ?? CLIENT_CLEANUP_INTERVAL_MS);
    // Match sibling timers (sessionCleanup/timeseriesFlush/browserHeartbeat): do
    // not keep the Node event loop alive purely for the stale-client sweep.
    cleanupTimer.unref?.();

    // ══════════════════════════════════════════════════════════════════════
    // HTTP server with extracted route handlers
    // ══════════════════════════════════════════════════════════════════════
    const routerDeps: HqRouterDeps = {
      trustBoundary,
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
      mailboxGateways,
      mailboxGatewayRateLimiter,
      alertEngine,
      auditLog,
      persistence,
      dataDir,
      hqSessionTag,
      requireBrowserAuth: options.requireBrowserAuth,
      secureCookies: options.secureCookies,
      authorizeMailboxGateway,
      getMailboxGateway,
      getTokenStats: () => authState.tokenStats(),
    };
    const handleRequest = createHqRouter(routerDeps);

    const httpServer: HttpServer = http.createServer((req, res) => {
      void handleRequest(req, res);
    });

    // ── WebSocket ──────────────────────────────────────────────────────────
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });

    const browserHeartbeatTimer = setInterval(() => {
      const heartbeat = JSON.stringify({
        type: 'hq.heartbeat',
        serverTime: new Date().toISOString(),
      });
      for (const browser of browsers) {
        if (browser.readyState === WebSocket.OPEN) browser.send(heartbeat);
      }
    }, options.browserHeartbeatIntervalMs ?? BROWSER_HEARTBEAT_INTERVAL_MS);
    browserHeartbeatTimer.unref?.();

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      const pathname = url.pathname;

      if (pathname !== '/ws/client' && pathname !== '/ws/browser') {
        socket.destroy();
        return;
      }

      if (!hasTrustedBrowserOrigin(req, host, listeningPort, trustedPublicOrigins)) {
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
        pathname === '/ws/browser' ? mutableAuth.browserTokens : mutableAuth.clientTokens;
      const needsAuth =
        pathname === '/ws/browser'
          ? options.requireBrowserAuth ||
            tokenSet.size > 0 ||
            mutableAuth.passwordHash !== undefined
          : tokenSet.size > 0;
      if (needsAuth) {
        const supplied = url.searchParams.get('token') ?? '';
        const tokenValid = HqServerAuth.timingSafeTokenMatch(tokenSet, supplied) !== undefined;
        const cookieValid =
          pathname === '/ws/browser' &&
          mutableAuth.passwordHash !== undefined &&
          mutableAuth.cookieSecret !== undefined &&
          (() => {
            const cookies = parseCookieHeader(req.headers.cookie);
            const raw = cookies[HQ_SESSION_COOKIE];
            if (!raw) return false;
            const sessionId = parseHqSessionCookie(raw, mutableAuth.cookieSecret!);
            return sessionId !== undefined && sessions.has(sessionId);
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

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, pathname);
      });
    });

    wss.on('connection', (ws: WebSocket, req: http.IncomingMessage, pathname: string) => {
      if (pathname === '/ws/browser') {
        HqServerWs.handleBrowser(ws, snapshotBroadcaster, browsers);
      } else {
        const token = new URL(req.url ?? '/', `http://${host}:${port}`).searchParams.get('token');
        HqServerWs.handleClient(
          ws,
          clients,
          browsers,
          eventLog,
          {
            ...(token ? { token: mutableAuth.clientTokenObjs.get(token) } : {}),
            getOperatorPolicy: () => mutableAuth.operatorPolicyOverride,
          },
          snapshotBroadcaster,
          transcripts,
          agentMessages,
          persistence,
          auditLog,
        );
      }
    });

    // ── Live auth.json reload ──────────────────────────────────────────────
    const authWatcher = watchHqAuthFile(
      dataDir,
      (next) => {
        authState.apply(next);
        if (
          options.requireBrowserAuth &&
          mutableAuth.browserTokens.size === 0 &&
          mutableAuth.passwordHash === undefined
        ) {
          sessions.clear();
          for (const browser of browsers) browser.close(1008, 'Browser authentication removed');
        }
        console.warn(
          JSON.stringify({
            level: 'info',
            event: 'hq.auth.reloaded',
            message: 'HQ auth.json reloaded',
            browserTokenCount: mutableAuth.browserTokens.size,
            clientTokenCount: mutableAuth.clientTokens.size,
            passwordMode: mutableAuth.passwordHash !== undefined,
            alertRulesActive: mutableAuth.alertRules !== undefined,
            timestamp: new Date().toISOString(),
          }),
        );
      },
      {
        warn: (msg) =>
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'hq.auth.reload_failed',
              message: msg,
              timestamp: new Date().toISOString(),
            }),
          ),
      },
    );

    // ── Listen ─────────────────────────────────────────────────────────────
    let bindAttempts = 0;
    const listen = (nextPort: number): void => {
      httpServer.listen(nextPort, host);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      if (
        err.code === 'EADDRINUSE' &&
        !options.strictPort &&
        !options.exactPort &&
        bindAttempts < MAX_NON_STRICT_PORT_SCAN
      ) {
        bindAttempts += 1;
        listen(port + bindAttempts);
      } else {
        authWatcher.close();
        snapshotBroadcaster.close();
        wss.close();
        reject(err);
      }
    };

    httpServer.on('error', onError);
    listen(port);
    httpServer.once('listening', () => {
      void (async () => {
        httpServer.removeListener('error', onError);
        const addr = httpServer.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        listeningPort = actualPort;

        const browserToken =
          firstRunAuth.browserToken?.token ??
          authFile.browserTokens?.find((t) => t.token.trim().length > 0)?.token;
        const clientToken =
          firstRunAuth.clientToken?.token ??
          authFile.clientTokens?.find((t) => t.token.trim().length > 0)?.token;
        const hqUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
        await writeHqRuntimeMarker(dataDir, hqUrl).catch(() => {});

        const startupInfo: HqStartupConnectionInfo = {
          dataDir,
          browserUrl: buildHttpUrl(host, actualPort, browserToken),
          clientUrl: buildClientWsUrl(host, actualPort, clientToken),
          clientEnv: {
            WRONGSTACK_HQ_URL: hqUrl,
            ...(clientToken ? { WRONGSTACK_HQ_TOKEN: clientToken } : {}),
          },
          createdAuth: firstRunAuth.created,
          browserTokenMode: mutableAuth.browserTokens.size > 0,
          passwordMode: mutableAuth.passwordHash !== undefined,
        };

        let closed = false;
        const handle: HqServerHandle = {
          host,
          port: actualPort,
          firstRunSetup: startupInfo,
          trustPublicOrigin: (origin) => {
            const parsed = new URL(origin);
            if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
              throw new TypeError(
                'Trusted HQ public origin must be an exact HTTPS origin without a path.',
              );
            }
            trustedPublicOrigins.add(parsed.origin.toLowerCase());
          },
          close: () =>
            new Promise<void>((res) => {
              if (closed) {
                res();
                return;
              }
              closed = true;
              clearInterval(cleanupTimer);
              clearInterval(browserHeartbeatTimer);
              clearInterval(timeseriesFlushTimer);
              clearInterval(mailboxGatewayRateLimitCleanup);
              clearInterval(sessionCleanupTimer);
              stopAlertEngine();
              authWatcher.close();
              snapshotBroadcaster.close();
              persistence.timeseries.flush();
              for (const ws of browsers) ws.close(1001, 'HQ shutting down');
              for (const ws of clients.keys()) ws.close(1001, 'HQ shutting down');
              wss.close();
              for (const { router } of mailboxGateways.values()) router.close();
              httpServer.close(() => {
                const mailboxCloses = [...mailboxGateways.values()].map(({ mailbox }) =>
                  mailbox.close().catch(() => undefined),
                );
                mailboxGateways.clear();
                void Promise.all([
                  ...mailboxCloses,
                  persistence.eventLog.drain(),
                  persistence.snapshotStore.drain(),
                  persistence.timeseries.drain(),
                  persistence.kanban.drain(),
                ])
                  .then(() => clearHqRuntimeMarker(dataDir, hqUrl))
                  .catch(() => undefined)
                  .finally(() => res());
              });
            }),
        };

        writeHqStartupInfo((line) => console.log(line.trimEnd()), {
          host,
          port: actualPort,
          firstRunSetup: startupInfo,
        });
        resolve(handle);
      })();
    });
  });
}
