/**
 * Mailbox gateway management and idle eviction for HQ server.
 *
 * @module hq-server/mailbox-gateway-manager
 */

import type { IncomingMessage } from 'node:http';
import * as path from 'node:path';
import {
  createMailboxHttpRouter,
  createProjectMailbox,
  MAILBOX_HTTP_DEFAULT_MAX_AGE_MS,
  MailboxEventEmitter,
  type MailboxHttpAccessDecision,
  MailboxHttpRateLimiter,
} from '@wrongstack/coordination';
import * as HqServerAuth from './auth.js';
import type { HqAuthState } from './auth-state.js';
import type {
  HqMailboxGatewayHealth,
  HqMailboxGatewayHealthEntry,
} from './mailbox-gateway-health.js';
import {
  authenticateBrowserRequest,
  type HqRouterMailboxGateway,
  isCookieAuth,
  isTokenAuth,
} from './routes.js';
import type { HqSessionEntry } from './types.js';
import { parseHqRequestUrl } from './utils.js';

interface MailboxGatewayManagerDeps {
  host: string;
  port: number;
  mutableAuth: HqAuthState['mutableAuth'];
  sessions: Map<string, HqSessionEntry>;
}

export class MailboxGatewayManager {
  readonly mailboxGateways = new Map<string, HqRouterMailboxGateway>();
  readonly mailboxGatewayLastUsed = new Map<string, number>();
  readonly mailboxGatewayRateLimiter = new MailboxHttpRateLimiter();
  private readonly rateLimitCleanupTimer: NodeJS.Timeout;
  private readonly sweepTimer: NodeJS.Timeout;

  private readonly MAILBOX_GATEWAY_IDLE_TTL_MS = 15 * 60_000;
  private readonly MAILBOX_GATEWAY_SWEEP_INTERVAL_MS = 60_000;

  constructor(private readonly deps: MailboxGatewayManagerDeps) {
    this.rateLimitCleanupTimer = setInterval(
      () => this.mailboxGatewayRateLimiter.cleanup(),
      120_000,
    );
    this.rateLimitCleanupTimer.unref?.();

    this.sweepTimer = setInterval(
      () => this.evictIdleGateways(),
      this.MAILBOX_GATEWAY_SWEEP_INTERVAL_MS,
    );
    this.sweepTimer.unref?.();
  }

  authorizeMailboxGateway(req: IncomingMessage, projectDir: string): MailboxHttpAccessDecision {
    const requestUrl = parseHqRequestUrl(req.url, this.deps.host, this.deps.port);
    if (requestUrl === null) {
      return {
        allowed: false,
        status: 400,
        body: { error: { code: 'BAD_REQUEST', message: 'invalid request url' } },
      };
    }
    const auth = authenticateBrowserRequest(
      req,
      requestUrl,
      this.deps.mutableAuth,
      this.deps.sessions,
    );
    const tokenMode = this.deps.mutableAuth.browserTokens.size > 0;

    if (HqServerAuth.hqAuthRequired(this.deps.mutableAuth) && auth === undefined) {
      return {
        allowed: false,
        status: 401,
        body: { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } },
      };
    }
    const token = isTokenAuth(auth)
      ? this.deps.mutableAuth.browserTokenObjs.get(auth.token)
      : undefined;
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
  }

  getMailboxGateway(projectDir: string): HqRouterMailboxGateway {
    const existing = this.mailboxGateways.get(projectDir);
    if (existing) {
      this.mailboxGatewayLastUsed.set(projectDir, Date.now());
      return existing;
    }
    const eventEmitter = new MailboxEventEmitter();
    const mailbox = createProjectMailbox({ projectDir, eventEmitter });
    const router = createMailboxHttpRouter({
      mailbox,
      eventEmitter,
      rateLimiter: this.mailboxGatewayRateLimiter,
      authorize: (request) => this.authorizeMailboxGateway(request, projectDir),
      defaultMaxAgeMs: MAILBOX_HTTP_DEFAULT_MAX_AGE_MS,
    });
    const gateway = { mailbox, router };
    this.mailboxGateways.set(projectDir, gateway);
    this.mailboxGatewayLastUsed.set(projectDir, Date.now());
    return gateway;
  }

  private evictIdleGateways(): void {
    const cutoff = Date.now() - this.MAILBOX_GATEWAY_IDLE_TTL_MS;
    for (const [projectDir, gateway] of [...this.mailboxGateways]) {
      if ((this.mailboxGatewayLastUsed.get(projectDir) ?? 0) > cutoff) continue;
      if (gateway.router.hasActiveStreams()) continue;
      this.mailboxGateways.delete(projectDir);
      this.mailboxGatewayLastUsed.delete(projectDir);
      gateway.router.close();
      void gateway.mailbox.close().catch(() => undefined);
    }
  }

  /**
   * W2 #14 (RFC hq-improvements-2026-09.md): health snapshot for the cockpit
   * "Mailbox gateway" card.
   *
   * Per-gateway entry surfaces the three diagnostic facts an operator
   * needs:
   *
   *   - `projectId`: the **basename** of the project directory, matching
   *     the credential contract used by `mailbox-serve.ts:192` (where
   *     `path.basename(projectDir)` is the `projectId` key for mailbox
   *     data). HQ binds the gateway with the full filesystem path
   *     (`resolveHqProjectRoot(...)` from `mailbox-handlers.ts:90`), so
   *     reporting the basename here means the dashboard's projectId
   *     matches what other mailbox surfaces see.
   *   - `projectRoot`: the full filesystem path the manager actually
   *     binds against. Surfaced separately so operators can debug
   *     path-mismatch issues without grepping the source.
   *   - `hasActiveStreams`: whether the gateway has any open HTTP streams
   *     right now. A gateway with `false` is a candidate for the next
   *     idle eviction; one with `true` is being watched.
   *   - `lastUsedAt`: epoch ms of the most recent `getMailboxGateway()`
   *     call (or the last `authorizeMailboxGateway` hit that resolved to
   *     this gateway). Surfaced so the dashboard can render the same
   *     "fresh / quiet / stale" staleness buckets the publisher health
   *     tile uses.
   *   - `idleForMs`: convenience — `Date.now() - lastUsedAt`. `Infinity`
   *     when the gateway was never used (shouldn't happen, since
   *     `getMailboxGateway` always stamps `mailboxGatewayLastUsed`).
   *
   * The aggregate `actor` field is **explicitly absent** on the HQ mount:
   * `authorizeMailboxGateway` (L57-96) never attaches a `MailboxActorContext`
   * to its decision, because HQ is a read-mostly operator dashboard, not
   * a producer-side mailbox client. We surface this truth with a stable
   * `actorAttached: false` so the dashboard can render "no actor
   * context" honestly rather than papering over it.
   */
  getHealth(): HqMailboxGatewayHealth {
    const now = Date.now();
    const gateways: HqMailboxGatewayHealthEntry[] = [];
    for (const [projectDir, gateway] of this.mailboxGateways) {
      const lastUsed = this.mailboxGatewayLastUsed.get(projectDir);
      gateways.push({
        // projectId = basename(projectDir) — matches the credential contract.
        projectId: path.basename(projectDir),
        projectRoot: projectDir,
        hasActiveStreams: gateway.router.hasActiveStreams(),
        lastUsedAt: typeof lastUsed === 'number' ? lastUsed : null,
        idleForMs: typeof lastUsed === 'number' ? Math.max(0, now - lastUsed) : null,
      });
    }
    // Sort by projectId for stable dashboard rendering. The underlying Map
    // iteration order is insertion-order, which leaks the access pattern;
    // sorting makes the card stable across renders and across HQ restarts.
    gateways.sort((a, b) => a.projectId.localeCompare(b.projectId));
    return {
      gatewayCount: gateways.length,
      rateLimiterConfigured: true,
      // HQ's gateway manager never attaches a MailboxActorContext (see
      // authorizeMailboxGateway above). The dashboard renders this as
      // "no actor context" — that is the truthful HQ state, not a bug.
      actorAttached: false,
      gateways,
      sweepIntervalMs: this.MAILBOX_GATEWAY_SWEEP_INTERVAL_MS,
      idleTtlMs: this.MAILBOX_GATEWAY_IDLE_TTL_MS,
    };
  }

  close(): void {
    clearInterval(this.rateLimitCleanupTimer);
    clearInterval(this.sweepTimer);
    for (const { router } of this.mailboxGateways.values()) router.close();
  }
}
