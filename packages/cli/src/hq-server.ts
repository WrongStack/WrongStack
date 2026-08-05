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
  type HqTranscriptEntry,
  hqTokenKey,
  hqTokenVerifier,
  mintHqCookieSecret,
  mutateHqAuthFile,
  toAlertMessage,
  watchHqAuthFile,
} from '@wrongstack/core/hq';
import { createCompatibilityTrustBoundary, type TrustBoundary } from '@wrongstack/core/security';
import { isLoopbackHost } from '@wrongstack/core/hq';
import { WebSocket, WebSocketServer } from 'ws';
import { HQ_HTML } from './hq-recovery-html.js';
import * as HqServerAuth from './hq-server/auth.js';
import { createHqAuthState } from './hq-server/auth-state.js';
import { LoginAttemptStore } from './hq-server/login-attempt-store.js';
import { prepareHqServerStart } from './hq-server/preflight.js';
import {
  agentMessageToEntry,
  agentRingKey,
  authenticateBrowserRequest,
  buildBootstrapHttpUrl,
  buildClientWsUrl,
  buildHttpUrl,
  createHqRouter,
  decodePathSegment,
  type HqRouterDeps,
  type HqRouterMailboxGateway,
  hasTrustedBrowserOrigin,
  isCookieAuth,
  isTokenAuth,
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
import type { ConnectedClient, HqSessionEntry, TranscriptRing } from './hq-server/types.js';
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
   * Trust `Origin: file://` on the HTTP and WebSocket surfaces, for serving the
   * HQ dashboard from a local file in air-gapped use. Default false.
   *
   * Off by default because the Host check does not contain a `file:` page — it
   * can aim at the real HQ authority — so trusting it unconditionally let any
   * locally-opened HTML file clear HQ's only cross-origin control (WS-081).
   * Enable only when you actually serve the dashboard that way.
   */
  allowFileOrigin?: boolean;
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
  /**
   * How many trusted reverse proxies sit between a browser and this server.
   * Controls which address the login backoff keys on (WS-106).
   *
   * Default `0`: `X-Forwarded-For` is ignored entirely and the socket peer is
   * used — correct for a direct bind, and the only safe default, because the
   * header is client-supplied and honouring it unasked would let an attacker
   * mint a fresh rate-limit identity per request.
   *
   * Set it to the real hop count when HQ runs behind a tunnel or relay
   * (`--hq-public-url`, `--hq-require-browser-auth`). Without it every request
   * arrives from the tunnel's own address, so all users share one backoff
   * bucket: one attacker locks out everyone, and a distributed attacker is not
   * limited per-source at all. `1` covers the common single-tunnel case.
   *
   * Only the rightmost `n` forwarded entries are ever read — see
   * `hq-server/client-address.ts`. Set via `--hq-trusted-proxy-hops`.
   */
  trustedProxyHops?: number;
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
  const authFile = firstRunAuth.authFile;

  // WS-010 / WS-101: `assessHqExposure` runs once at startup, so removing the
  // last credential on a live non-loopback bind silently opened HQ — including
  // POST /api/command — to the whole network. Re-assess after EVERY change to
  // the live credential set and latch an auth floor when the verdict is a
  // refusal, so the surface fails closed rather than opening.
  //
  // This hook is why `HqAuthState.apply` is the only projection: the reload
  // watcher and the in-process mutation routes (`DELETE /api/auth/password`,
  // the TOTP endpoints) both go through it, so neither can remove a credential
  // without the floor being re-evaluated in the same tick. The mutation routes
  // used to run their own copy of the projection and never touched the floor.
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

  const authState = createHqAuthState(authFile, dataDir, {
    onApplied: (live) => reassessExposureFloor(live),
  });
  const { mutableAuth } = authState;

  // Provision a cookie-signing secret for token-only mode so bootstrap
  // exchange can produce signed session cookies without a password.
  if (!mutableAuth.cookieSecret && mutableAuth.browserTokens.size > 0) {
    const secret = mintHqCookieSecret();
    const next = await mutateHqAuthFile(dataDir, (current) => ({
      ...current,
      cookieSecret: secret,
    }));
    // Through `apply`, not a direct field write. Nothing here changes the
    // credential set, so the floor verdict cannot move — but this is the one
    // remaining place that persists auth.json outside the route handlers, and
    // leaving it as the single exception to "every mutation goes through the
    // projection" is how the second projection got written in the first place.
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

  // Bootstrap code store for one-time token-to-cookie exchange.
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
      timestamp: new Date().toISOString(),
    }),
  );

  return new Promise((resolve, reject) => {
    const trustedPublicOrigins = new Set<string>();
    let listeningPort = port;
    const clients = new Map<WebSocket, ConnectedClient>();
    const browsers = new Set<WebSocket>();
    const sessions = new Map<string, HqSessionEntry>();
    const eventLog: HqEventEnvelope[] = [];
    const transcripts = new Map<string, TranscriptRing>();
    const agentMessages = new Map<string, HqTranscriptEntry[]>();
    const mailboxGateways = new Map<string, HqRouterMailboxGateway>();
    // Idle-TTL eviction for mailbox gateways (RAM-leak audit 2026-07-31, HIGH).
    // Each gateway holds a persistent IPC connection that keeps the project's
    // mailbox daemon alive (its idle-stop is gated on clients.size === 0), so a
    // gateway that is never evicted pins one ~63 MB daemon for the HQ lifetime.
    // The daemon self-stops ~5 min after its last connection closes, so a
    // 15-minute idle window bounds the pin to ~20 minutes after last use.
    const MAILBOX_GATEWAY_IDLE_TTL_MS = 15 * 60_000;
    const MAILBOX_GATEWAY_SWEEP_INTERVAL_MS = 60_000;
    const mailboxGatewayLastUsed = new Map<string, number>();
    const mailboxGatewayRateLimiter = new MailboxHttpRateLimiter();
    const mailboxGatewayRateLimitCleanup = setInterval(
      () => mailboxGatewayRateLimiter.cleanup(),
      120_000,
    );
    mailboxGatewayRateLimitCleanup.unref?.();

    // ── Login rate limiting (persistent across restarts) ──────────────────
    const loginAttempts = new LoginAttemptStore(dataDir);
    void loginAttempts.load();

    // ── Browser-session lifecycle ──────────────────────────────────────────
    const HQ_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const HQ_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000; // 30 min idle → evict
    const SESSION_CLEANUP_INTERVAL_MS = 60_000;
    // Pending-2FA sessions are short-lived (5 min TTL, same as the verify
    // endpoint enforces). They must not linger until the 7-day max-age sweep,
    // or a valid-password attacker can grow the sessions Map unboundedly.
    const PENDING_2FA_TTL_MS = 5 * 60_000;
    const sessionCleanupTimer = setInterval(() => {
      const now = Date.now();
      const maxAgeCutoff = now - HQ_SESSION_MAX_AGE_MS;
      const idleCutoff = now - HQ_SESSION_IDLE_TIMEOUT_MS;
      const pending2faCutoff = now - PENDING_2FA_TTL_MS;
      for (const [id, session] of sessions) {
        // Absolute max age (7 days from creation)
        if (session.createdAt < maxAgeCutoff) {
          sessions.delete(id);
          continue;
        }
        // Pending-2FA sessions: evict past their 5-minute TTL. The verify
        // endpoint also checks this on access, but without a sweep they
        // accumulate until the 7-day max-age.
        if (session.pending2fa) {
          if (session.createdAt < pending2faCutoff) sessions.delete(id);
          continue;
        }
        // Idle timeout (30 min since last activity) for fully-authenticated
        // sessions.
        if (session.lastSeenAt < idleCutoff) {
          sessions.delete(id);
        }
      }
      for (const [ip, entry] of loginAttempts.entries()) {
        if (now - entry.lastAttempt > 15 * 60_000) loginAttempts.delete(ip);
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
      // Was `tokenMode || passwordMode`, which ignored the WS-010 fail-closed
      // latch — so a live revocation or an all-expired token file turned this
      // mailbox gateway back into an open surface (WS-077).
      if (HqServerAuth.hqAuthRequired(mutableAuth) && auth === undefined) {
        return {
          allowed: false,
          status: 401,
          body: { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } },
        };
      }
      const token = isTokenAuth(auth) ? mutableAuth.browserTokenObjs.get(auth.token) : undefined;
      const canUseMailbox = isCookieAuth(auth)
        ? auth.capabilities === undefined || auth.capabilities.includes('control.enqueue')
        : isTokenAuth(auth)
          ? token?.capabilities === undefined || !!token?.capabilities.includes('control.enqueue')
          : !tokenMode;
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
      const identity = isTokenAuth(auth) ? auth.id : isCookieAuth(auth) ? 'cookie' : 'open';
      return { allowed: true, rateLimitKey: `hq:${identity}:${projectDir}` };
    };

    const getMailboxGateway = (projectDir: string): HqRouterMailboxGateway => {
      const existing = mailboxGateways.get(projectDir);
      if (existing) {
        mailboxGatewayLastUsed.set(projectDir, Date.now());
        return existing;
      }
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
      mailboxGatewayLastUsed.set(projectDir, Date.now());
      return gateway;
    };

    // Evict gateways idle past the TTL, releasing their IPC connection so the
    // project mailbox daemon can idle-stop itself. A router with an open SSE
    // stream is never evicted — it is retried on the next sweep. A later
    // request recreates the gateway lazily (same path as the first touch).
    const evictIdleMailboxGateways = (): void => {
      const cutoff = Date.now() - MAILBOX_GATEWAY_IDLE_TTL_MS;
      for (const [projectDir, gateway] of [...mailboxGateways]) {
        if ((mailboxGatewayLastUsed.get(projectDir) ?? 0) > cutoff) continue;
        if (gateway.router.hasActiveStreams()) continue;
        mailboxGateways.delete(projectDir);
        mailboxGatewayLastUsed.delete(projectDir);
        gateway.router.close();
        void gateway.mailbox.close().catch(() => undefined);
      }
    };
    const mailboxGatewaySweepTimer = setInterval(
      evictIdleMailboxGateways,
      MAILBOX_GATEWAY_SWEEP_INTERVAL_MS,
    );
    mailboxGatewaySweepTimer.unref?.();

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
          // Heartbeat-timeout: capture the lost client before deletion so
          // the leader-deposed detector can emit `peer.rehydrate` /
          // `peer.lost` if this client was the project's leader.
          const lostClient = client;
          ws.terminate();
          clients.delete(ws);
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
          // Session-summary TTL eviction: same leader-loss detection as
          // heartbeat-timeout (the leader is gone even if the socket is
          // still alive; from the project's perspective the leader is
          // unreachable).
          const lostClient = client;
          ws.terminate();
          clients.delete(ws);
          HqServerWs.detectLeaderLoss(lostClient, clients, browsers, 'heartbeat-timeout', {
            eventLog,
            persistence,
          });
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
      allowFileOrigin: options.allowFileOrigin,
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
      // Single projection + single floor evaluation, shared with the reload
      // watcher below. See `createHqAuthState`'s `onApplied` hook.
      applyAuthFile: (next) => authState.apply(next),
      trustedProxyHops: options.trustedProxyHops ?? 0,
      bootstrapStore,
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

      if (
        !hasTrustedBrowserOrigin(
          req,
          host,
          listeningPort,
          trustedPublicOrigins,
          options.allowFileOrigin,
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
        pathname === '/ws/browser' ? mutableAuth.browserTokens : mutableAuth.clientTokens;
      // Both arms previously open-coded a `tokenSet.size > 0` test that ignored
      // the WS-010 fail-closed latch. The WebSocket is the highest-value surface
      // here — /ws/browser streams transcripts and telemetry, /ws/client lets a
      // peer register as a fleet session — and it was the one gate WS-010 never
      // reached (WS-077).
      const needsAuth =
        pathname === '/ws/browser'
          ? HqServerAuth.hqAuthRequired(mutableAuth, options.requireBrowserAuth)
          : HqServerAuth.hqClientAuthRequired(mutableAuth);
      if (needsAuth) {
        let supplied = url.searchParams.get('token') ?? '';
        // M5: reject query-string tokens on non-loopback browser WS upgrades.
        // The token leaks through proxy logs, browser history, and Referer.
        // Browsers on non-loopback should authenticate via the session cookie
        // (checked below). /ws/client is programmatic-only and always uses
        // tokens in the URL since cookies aren't a practical mechanism there.
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
                message: 'Browser token in WS query rejected on non-loopback — use session cookie instead.',
                timestamp: new Date().toISOString(),
              }),
            );
            supplied = '';
          }
        }
        const tokenValid = HqServerAuth.timingSafeTokenMatch(tokenSet, supplied) !== undefined;
        const cookieValid =
          pathname === '/ws/browser' &&
          mutableAuth.cookieSecret !== undefined &&
          (() => {
            const raw = HqServerAuth.readHqSessionCookie(req.headers.cookie);
            if (!raw) return false;
            const sessionId = parseHqSessionCookie(raw, mutableAuth.cookieSecret!);
            if (sessionId === undefined) return false;
            const session = sessions.get(sessionId);
            if (!session || Date.now() - session.createdAt >= HqServerAuth.HQ_SESSION_MAX_AGE_MS)
              return false;
            // Idle timeout on WS too — a stolen cookie shouldn't stay live
            // indefinitely without activity.
            const now2 = Date.now();
            if (!session.pending2fa && now2 - session.lastSeenAt > HqServerAuth.HQ_SESSION_IDLE_TIMEOUT_MS)
              return false;
            // Bump lastSeenAt (sliding refresh).
            session.lastSeenAt = now2;
            // Pending 2FA: the password was correct but the TOTP code has not
            // been verified yet. Reject the WebSocket upgrade so 2FA cannot
            // be bypassed via /ws/browser.
            if (session.pending2fa) return false;
            // For token-origin sessions, verify the source token is still live.
            if (session.kind === 'token' && session.tokenId !== undefined) {
              return [...mutableAuth.browserTokenObjs.values()].some(
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

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, pathname);
      });
    });

    wss.on('connection', (ws: WebSocket, req: http.IncomingMessage, pathname: string) => {
      if (pathname === '/ws/browser') {
        HqServerWs.handleBrowser(ws, snapshotBroadcaster, browsers, eventLog);
      } else {
        const token = new URL(req.url ?? '/', `http://${host}:${port}`).searchParams.get('token');
        HqServerWs.handleClient(
          ws,
          clients,
          browsers,
          eventLog,
          {
            // WS-044: `clientTokenObjs` is keyed on `hqTokenKey` — the verifier —
            // so the presented secret is hashed before lookup. Indexing with the
            // raw value silently returned undefined, which downgraded a scoped
            // token to "no capabilities record" at the capability gate.
            ...(token ? { token: mutableAuth.clientTokenObjs.get(hqTokenVerifier(token)) } : {}),
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
        // `apply` re-latches `requireAuthFloor` through the `onApplied` hook
        // installed above — the operator can restore service by minting a
        // token or setting a password; both clear it on the next apply.
        authState.apply(next);
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

        const clientToken =
          firstRunAuth.clientToken?.token ??
          authFile.clientTokens?.find((t) => t.token.trim().length > 0)?.token;
        const hqUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
        await writeHqRuntimeMarker(dataDir, hqUrl).catch(() => {});

        // Build the browser URL with a one-time bootstrap code (in the
        // fragment) when a browser token exists. The code is exchanged for
        // a session cookie on first load and never appears in HTTP traffic.
        //
        // WS-044: this used to resolve the token record by looking up the
        // browser token's CLEARTEXT secret, which only worked because the
        // secret sat in `auth.json`. The code is built from the token's id and
        // capabilities — the secret was never an input — so it now takes the
        // first live browser record directly, preferring a just-minted one.
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
              clearInterval(mailboxGatewaySweepTimer);
              clearInterval(sessionCleanupTimer);
              void loginAttempts.flush();
              stopAlertEngine();
              authWatcher.close();
              snapshotBroadcaster.close();
              bootstrapStore.clear();
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
                mailboxGatewayLastUsed.clear();
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
