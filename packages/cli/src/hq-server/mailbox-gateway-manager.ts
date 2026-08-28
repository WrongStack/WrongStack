/**
 * Mailbox gateway management and idle eviction for HQ server.
 *
 * @module hq-server/mailbox-gateway-manager
 */

import type { IncomingMessage } from 'node:http';
import {
  createMailboxHttpRouter,
  createProjectMailbox,
  MAILBOX_HTTP_DEFAULT_MAX_AGE_MS,
  MailboxEventEmitter,
  type MailboxHttpAccessDecision,
  MailboxHttpRateLimiter,
} from '@wrongstack/core/coordination';
import * as HqServerAuth from './auth.js';
import type { HqAuthState } from './auth-state.js';
import {
  authenticateBrowserRequest,
  type HqRouterMailboxGateway,
  isCookieAuth,
  isTokenAuth,
} from './routes.js';
import type { HqSessionEntry } from './types.js';

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

  authorizeMailboxGateway(
    req: IncomingMessage,
    projectDir: string,
  ): MailboxHttpAccessDecision {
    const requestUrl = new URL(req.url ?? '/', `http://${this.deps.host}:${this.deps.port}`);
    const auth = authenticateBrowserRequest(req, requestUrl, this.deps.mutableAuth, this.deps.sessions);
    const tokenMode = this.deps.mutableAuth.browserTokens.size > 0;

    if (HqServerAuth.hqAuthRequired(this.deps.mutableAuth) && auth === undefined) {
      return {
        allowed: false,
        status: 401,
        body: { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } },
      };
    }
    const token = isTokenAuth(auth) ? this.deps.mutableAuth.browserTokenObjs.get(auth.token) : undefined;
    const canUseMailbox = isCookieAuth(auth)
      ? auth.capabilities === undefined || auth.capabilities.includes('control.enqueue')
      : isTokenAuth(auth)
        ? token?.capabilities === undefined || !(!token?.capabilities.includes('control.enqueue'))
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

  close(): void {
    clearInterval(this.rateLimitCleanupTimer);
    clearInterval(this.sweepTimer);
    for (const { router } of this.mailboxGateways.values()) router.close();
  }
}
