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
import { getSharedProjectMailbox } from '@wrongstack/core/coordination';
import {
  assessHqExposure,
  createHqPersistence,
  type EnsureHqFirstRunAuthResult,
  type HqAlert,
  HqAlertEngine,
  type HqAlertRuleConfig,
  HqBootstrapCodeStore,
  type HqCommandAuditEntry,
  HqCommandAuditLog,
  type HqEventEnvelope,
  type HqToken,
  type HqTranscriptEntry,
  hqTokenKey,
  mintHqCookieSecret,
  mutateHqAuthFile,
  shouldCloseBrowserSocket,
  toAlertMessage,
  watchHqAuthFile,
} from '@wrongstack/core/hq';
import { createCompatibilityTrustBoundary, type TrustBoundary } from '@wrongstack/core/security';
import { WebSocket, WebSocketServer } from 'ws';
import { HQ_HTML } from './hq-recovery-html.js';
import { createHqAuthState } from './hq-server/auth-state.js';
import { createHqIpAllowlist } from './hq-server/ip-allowlist.js';
import { LoginAttemptStore } from './hq-server/login-attempt-store.js';
import { MailboxGatewayManager } from './hq-server/mailbox-gateway-manager.js';
import { prepareHqServerStart } from './hq-server/preflight.js';
import {
  agentMessageToEntry,
  agentRingKey,
  buildBootstrapHttpUrl,
  buildClientWsUrl,
  buildHttpUrl,
  createHqRouter,
  decodePathSegment,
  type HqRouterDeps,
  readLocalSubagentTranscript,
  sanitizeApiError,
} from './hq-server/routes.js';
import { createHqServerShutdown } from './hq-server/server-lifecycle.js';
import { createHqSocketCredentialEnforcer } from './hq-server/socket-credentials.js';
import * as HqServerSnapshot from './hq-server/snapshot.js';
import { writeHqRuntimeMarker, writeHqStartupInfo } from './hq-server/startup.js';
import type { ConnectedClient, HqSessionEntry, TranscriptRing } from './hq-server/types.js';
import { handleHqConnection, handleHqUpgrade } from './hq-server/upgrade-handler.js';
import * as HqServerWs from './hq-server/ws.js';

export { HqInsecureExposureError } from '@wrongstack/core/hq';
export type { ConnectedClient, TranscriptRing };

// ── Re-exports for backward compatibility ──────────────────────────────────

export { HQ_HTML };
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3499;
export const MAX_EVENT_LOG = 5000;
const MAX_NON_STRICT_PORT_SCAN = 50;
const CLIENT_TTL_MS = 60_000;
const CLIENT_CLEANUP_INTERVAL_MS = 30_000;
const BROWSER_HEARTBEAT_INTERVAL_MS = 15_000;
const SESSION_SNAPSHOT_TTL_MS = 30_000;

export {
  agentMessageToEntry,
  agentRingKey,
  decodePathSegment,
  readLocalSubagentTranscript,
  sanitizeApiError,
};

// ── Public interfaces ──────────────────────────────────────────────────────

interface HqServerOptions {
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
  /** Keep an existing Settings-managed password instead of reapplying the startup secret. */
  bootstrapPasswordOnly?: boolean;
  allowInsecureOpen?: boolean;
  secureCookies?: boolean;
  requireBrowserAuth?: boolean;
  allowFileOrigin?: boolean;
  tokenTtlMs?: number;
  trustedProxyHops?: number;
  /** Optional exact-IP/CIDR admission list. Empty/absent means unrestricted. */
  ipAllowlist?: readonly string[];
}

// Public HQ server handle types live in a dedicated leaf module so callers (notably
// `subcommands/handlers/hq.ts`) can depend on the public types without pulling in
// the HQ server implementation. See `./hq-server/handle-types.ts`.
import type { HqServerHandle, HqStartupConnectionInfo } from './hq-server/handle-types.js';

export type {
  HqFirstRunSetup,
  HqServerHandle,
  HqStartupConnectionInfo,
} from './hq-server/handle-types.js';

// ── Server entry points ────────────────────────────────────────────────────

export async function startHqServer(options: HqServerOptions = {}): Promise<HqServerHandle> {
  const { host, port, dataDir, firstRunAuth } = await prepareHqServerStart(options, {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
  });
  return startHqServerWithAuth(options, host, port, dataDir, firstRunAuth);
}

async function startHqServerWithAuth(
  options: HqServerOptions,
  host: string,
  port: number,
  dataDir: string,
  firstRunAuth: EnsureHqFirstRunAuthResult,
): Promise<HqServerHandle> {
  const trustBoundary =
    options.trustBoundary ??
    createCompatibilityTrustBoundary({ policyId: 'hq-trusted-host-compat-v1' });
  const ipAllowlist = createHqIpAllowlist(options.ipAllowlist);
  const authFile = firstRunAuth.authFile;

  const reassessExposureFloor = (live: typeof mutableAuth): void => {
    const exposure = assessHqExposure({
      host,
      hasBrowserTokens: live.browserTokens.size > 0,
      hasPassword: live.passwordHash !== undefined,
      allowInsecure: options.allowInsecureOpen,
    });
    const previousFloor = live.requireAuthFloor === true;
    live.requireAuthFloor = exposure.kind === 'refuse';
    if (live.requireAuthFloor && !previousFloor) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'hq.auth.open_mode_refused',
          message:
            'Last HQ credential removed while bound to a non-loopback address. ' +
            'Refusing to serve unauthenticated: requests will return 401 until a ' +
            'token or password is configured, or HQ is restarted with --host 127.0.0.1.',
          host,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };

  // W4 #15: the revocation handler needs the browser socket set, which is
  // constructed further down — so it is late-bound here rather than
  // reordering the whole server start-up around one callback.
  let revokeBrowserSessions:
    | ((keys: readonly string[], ids: readonly string[]) => void)
    | undefined;

  const authState = createHqAuthState(authFile, dataDir, {
    onApplied: (live) => reassessExposureFloor(live),
    onTokensRevoked: (keys, ids) => revokeBrowserSessions?.(keys, ids),
    requireBrowserAuth: options.requireBrowserAuth,
  });
  const { mutableAuth } = authState;

  // Chimera/SEC: load lockout state BEFORE the server starts listening. The
  // old fire-and-forget `void load()` inside the executor below let requests
  // race the disk read on restart — a locked-out IP could slip logins in
  // during the gap. Awaiting here is cheap (single small JSON read) and makes
  // "server is answering" imply "lockout state is live".
  const loginAttempts = new LoginAttemptStore(dataDir);
  await loginAttempts.load();

  if (!mutableAuth.cookieSecret && mutableAuth.browserTokens.size > 0) {
    const secret = mintHqCookieSecret();
    const next = await mutateHqAuthFile(dataDir, (current) => ({
      ...current,
      cookieSecret: secret,
    }));
    authState.apply(next);
    console.warn(
      JSON.stringify({
        level: 'info',
        event: 'hq.cookie_secret_provisioned',
        message: 'Cookie signing secret provisioned for token-mode bootstrap exchange.',
        timestamp: new Date().toISOString(),
      }),
    );
  }

  const bootstrapStore = new HqBootstrapCodeStore();

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
      ipAllowlistActive: ipAllowlist !== undefined,
      ipAllowlistRules: ipAllowlist?.entries.length ?? 0,
      timestamp: new Date().toISOString(),
    }),
  );

  return new Promise((resolve, reject) => {
    const trustedPublicOrigins = new Set<string>();
    let listeningPort = port;
    const clients = new Map<WebSocket, ConnectedClient>();
    const clientSocketTokens = new Map<WebSocket, HqToken | undefined>();
    // W4 #15 follow-on: which session authorized each open browser socket, so
    // the revocation close loop can target the affected browsers instead of
    // every browser. Populated at connection time by the upgrade handoff.
    const browserSocketSessions = new Map<WebSocket, string>();
    const browsers = new Set<WebSocket>();
    const sessions = new Map<string, HqSessionEntry>();
    // W4 #15: a revoked browser token has to evacuate sockets that are ALREADY
    // open — failing the next handshake is not enough, because an open socket
    // never presents its credential again and would keep streaming telemetry.
    const socketCredentials = createHqSocketCredentialEnforcer({
      mutableAuth,
      sessions,
      browsers,
      browserSocketSessions,
      clientSocketTokens,
    });
    revokeBrowserSessions = (keys, ids) => socketCredentials.announceRevokedTokens(keys, ids);
    const eventLog: HqEventEnvelope[] = [];
    const transcripts = new Map<string, TranscriptRing>();
    const agentMessages = new Map<string, HqTranscriptEntry[]>();

    const mailboxManager = new MailboxGatewayManager({
      host,
      port,
      mutableAuth,
      sessions,
    });

    const HQ_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const HQ_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
    const SESSION_CLEANUP_INTERVAL_MS = 60_000;
    const PENDING_2FA_TTL_MS = 5 * 60_000;
    const sessionCleanupTimer = setInterval(() => {
      const now = Date.now();
      const maxAgeCutoff = now - HQ_SESSION_MAX_AGE_MS;
      const idleCutoff = now - HQ_SESSION_IDLE_TIMEOUT_MS;
      const pending2faCutoff = now - PENDING_2FA_TTL_MS;
      for (const [id, session] of sessions) {
        if (session.createdAt < maxAgeCutoff) {
          sessions.delete(id);
          // Max age is absolute, unlike the idle cutoff below: a socket still
          // streaming on a session that has outlived it must go too.
          socketCredentials.closeSessionSockets(id, 'Browser session expired');
          continue;
        }
        if (session.pending2fa) {
          if (session.createdAt < pending2faCutoff) sessions.delete(id);
          continue;
        }
        if (session.lastSeenAt < idleCutoff) {
          sessions.delete(id);
        }
      }
      for (const [ip, entry] of loginAttempts.entries()) {
        if (now - entry.lastAttempt > 15 * 60_000) loginAttempts.delete(ip);
      }
    }, SESSION_CLEANUP_INTERVAL_MS);
    sessionCleanupTimer.unref?.();

    const persistence = createHqPersistence(dataDir);
    const auditLog = new HqCommandAuditLog(1000, (entry) => persistence.commandLog.append(entry));

    void (async () => {
      const projectsDir = path.join(path.dirname(dataDir), 'projects');
      const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const projectDir = path.join(projectsDir, entry.name);
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
      // W4 #7: the ring is the read path for `/api/commands`, so the browser
      // snapshot's latency roll-up is computed from the same window.
      { commandAudit: () => auditLog.recent(200) },
    );
    snapshotBroadcaster.currentSerialized();

    const stopAlertEngine = alertEngine.startPeriodic(
      () => HqServerSnapshot.buildSnapshot(clients, { tokenStats: authState.tokenStats() }),
      (): HqAlertRuleConfig | undefined => mutableAuth.alertRules,
    );

    const clientTtlMs = options.clientTtlMs ?? CLIENT_TTL_MS;
    const sessionSnapshotTtlMs = options.sessionSnapshotTtlMs ?? SESSION_SNAPSHOT_TTL_MS;
    const cleanupTimer = setInterval(() => {
      socketCredentials.sweepExpiredSocketCredentials();
      const cutoff = Date.now() - clientTtlMs;
      const sessionCutoff = Date.now() - sessionSnapshotTtlMs;
      let changed = false;
      for (const [ws, client] of clients.entries()) {
        if (new Date(client.lastSeenAt).getTime() < cutoff) {
          const lostClient = client;
          ws.terminate();
          clients.delete(ws);
          HqServerWs.failUndeliveredCommands(lostClient, browsers, auditLog);
          HqServerWs.detectLeaderLoss(lostClient, clients, browsers, 'heartbeat-timeout', {
            eventLog,
            persistence,
          });
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
          const lostClient = client;
          ws.terminate();
          clients.delete(ws);
          HqServerWs.failUndeliveredCommands(lostClient, browsers, auditLog);
          // This is a server-side session-summary TTL reap, NOT a missed
          // heartbeat: the branch above already returned for a genuinely
          // stale `lastSeenAt`, so this client is still heartbeating — it is
          // dropped because it has held zero session snapshots past the TTL.
          // Labeling it 'heartbeat-timeout' (the literal this branch used to
          // pass) made every peer.rehydrate/peer.lost banner claim a heartbeat
          // failure that never happened. 'crash' is the closest truthful
          // existing reason for an abrupt, non-graceful server-side loss.
          HqServerWs.detectLeaderLoss(lostClient, clients, browsers, 'crash', {
            eventLog,
            persistence,
          });
          changed = true;
        }
      }
      if (changed) snapshotBroadcaster.broadcast();
    }, options.clientCleanupIntervalMs ?? CLIENT_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();

    const routerDeps: HqRouterDeps = {
      trustBoundary,
      host,
      listeningPort: () => listeningPort,
      trustedPublicOrigins,
      allowFileOrigin: options.allowFileOrigin,
      mutableAuth,
      sessions,
      loginAttempts,
      clients,
      browsers,
      eventLog,
      transcripts,
      agentMessages,
      mailboxGateways: mailboxManager.mailboxGateways,
      mailboxGatewayRateLimiter: mailboxManager.mailboxGatewayRateLimiter,
      mailboxManager,
      alertEngine,
      auditLog,
      persistence,
      dataDir,
      hqSessionTag,
      requireBrowserAuth: options.requireBrowserAuth,
      secureCookies: options.secureCookies,
      authorizeMailboxGateway: (req, projectDir) =>
        mailboxManager.authorizeMailboxGateway(req, projectDir),
      getMailboxGateway: (projectDir) => mailboxManager.getMailboxGateway(projectDir),
      getTokenStats: () => authState.tokenStats(),
      applyAuthFile: (next) => authState.apply(next),
      trustedProxyHops: options.trustedProxyHops ?? 0,
      ipAllowlist,
      bootstrapStore,
    };
    const handleRequest = createHqRouter(routerDeps);

    // WS-2026-09-15-02: an open `/ws/browser` socket never presents its cookie
    // again, so deleting the session that authorized it has to close it here.
    // The auth.json watcher cannot do this for in-process mutations: password
    // change/removal, TOTP enable, session revoke and logout all apply the new
    // auth state BEFORE the watcher runs, so its before/after diff is empty and
    // its close loop never fires. Wrapping every HTTP request is the one choke
    // point those routes — and any future one — share, without threading a
    // callback through each handler. Only sockets bound to a session that this
    // request window removed are closed; bare `?token=` sockets and sessions
    // expired by the periodic sweep (not an HTTP request) are left alone.
    const closeSocketsOfRemovedSessions = (before: ReadonlySet<string>): void => {
      for (const [browser, sessionId] of browserSocketSessions) {
        if (!before.has(sessionId) || sessions.has(sessionId)) continue;
        if (browser.readyState === WebSocket.OPEN) {
          browser.close(1008, 'Browser session revoked');
        }
      }
    };

    const httpServer: HttpServer = http.createServer((req, res) => {
      const sessionsBefore = sessions.size > 0 ? new Set(sessions.keys()) : undefined;
      void handleRequest(req, res).finally(() => {
        if (sessionsBefore !== undefined) closeSocketsOfRemovedSessions(sessionsBefore);
      });
    });

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

    const upgradeDeps = {
      host,
      port,
      listeningPort: () => listeningPort,
      trustedPublicOrigins,
      allowFileOrigin: options.allowFileOrigin,
      requireBrowserAuth: options.requireBrowserAuth,
      mutableAuth,
      sessions,
      clients,
      clientSocketTokens,
      browserSocketSessions,
      browsers,
      eventLog,
      transcripts,
      agentMessages,
      persistence,
      auditLog,
      snapshotBroadcaster,
      wss,
      ipAllowlist,
    };

    httpServer.on('upgrade', (req, socket, head) => {
      handleHqUpgrade(req, socket, head, upgradeDeps);
    });

    wss.on('connection', (ws: WebSocket, req: http.IncomingMessage, pathname: string) => {
      handleHqConnection(ws, req, pathname, upgradeDeps);
    });

    const authWatcher = watchHqAuthFile(
      dataDir,
      (next) => {
        const previousBrowserTokens = mutableAuth.browserTokens;
        const previousPasswordHash = mutableAuth.passwordHash;
        const previousCookieSecret = mutableAuth.cookieSecret;
        authState.apply(next);

        const browserTokensChanged =
          previousBrowserTokens.size !== mutableAuth.browserTokens.size ||
          [...previousBrowserTokens].some((token) => !mutableAuth.browserTokens.has(token));
        const passwordChanged = previousPasswordHash !== mutableAuth.passwordHash;
        const cookieSecretChanged = previousCookieSecret !== mutableAuth.cookieSecret;
        if (browserTokensChanged || passwordChanged || cookieSecretChanged) {
          const liveBrowserTokenIds = new Set(
            [...mutableAuth.browserTokenObjs.values()].map((token) => token.id),
          );
          const revokedSessionIds = new Set<string>();
          for (const [sessionId, session] of sessions) {
            if (
              passwordChanged ||
              cookieSecretChanged ||
              (session.kind === 'token' &&
                (session.tokenId === undefined || !liveBrowserTokenIds.has(session.tokenId)))
            ) {
              sessions.delete(sessionId);
              revokedSessionIds.add(sessionId);
            }
          }
          // Close only the browsers whose OWN session died; the predicate owns
          // the fail-closed rule for sockets with no recorded session. A
          // password or cookie-secret change deletes every session above, so
          // that case still closes everything, as it must.
          for (const browser of browsers) {
            if (shouldCloseBrowserSocket(browserSocketSessions.get(browser), revokedSessionIds)) {
              browser.close(1008, 'Browser authentication changed');
            }
          }
        }

        socketCredentials.closeUnauthorizedClientSockets();
        if (
          (options.requireBrowserAuth || mutableAuth.requireAuthFloor) &&
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

        const clientToken =
          firstRunAuth.clientToken?.token ??
          authFile.clientTokens?.find((t) => t.token.trim().length > 0)?.token;
        const hqUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
        await writeHqRuntimeMarker(dataDir, hqUrl).catch(() => {});

        const browserTokenObj =
          (firstRunAuth.browserToken !== undefined
            ? mutableAuth.browserTokenObjs.get(hqTokenKey(firstRunAuth.browserToken))
            : undefined) ?? mutableAuth.browserTokenObjs.values().next().value;
        let browserUrl: string;
        if (browserTokenObj) {
          const code = bootstrapStore.issue({
            tokenId: browserTokenObj.id,
            ...(browserTokenObj.capabilities !== undefined
              ? { capabilities: browserTokenObj.capabilities }
              : {}),
          });
          browserUrl = buildBootstrapHttpUrl(host, actualPort, code);
        } else {
          browserUrl = buildHttpUrl(host, actualPort);
        }

        const startupInfo: HqStartupConnectionInfo = {
          dataDir,
          browserUrl,
          clientUrl: buildClientWsUrl(host, actualPort, clientToken),
          clientEnv: {
            WRONGSTACK_HQ_URL: hqUrl,
            ...(clientToken ? { WRONGSTACK_HQ_TOKEN: clientToken } : {}),
          },
          createdAuth: firstRunAuth.created,
          browserTokenMode: mutableAuth.browserTokens.size > 0,
          passwordMode: mutableAuth.passwordHash !== undefined,
        };

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
          close: createHqServerShutdown({
            cleanupTimer,
            browserHeartbeatTimer,
            timeseriesFlushTimer,
            sessionCleanupTimer,
            loginAttempts,
            stopAlertEngine,
            authWatcher,
            snapshotBroadcaster,
            bootstrapStore,
            persistence,
            browsers,
            clients,
            wss,
            mailboxManager,
            httpServer,
            dataDir,
            hqUrl,
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
