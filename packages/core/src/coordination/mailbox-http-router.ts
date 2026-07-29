import type { IncomingMessage, ServerResponse } from 'node:http';

import type { MailboxEventEmitter } from './mailbox-events.js';
import type { MailboxCredentialVerifier } from './mailbox-credential-store.js';
import {
  authorizePersistedMailboxCredential,
  parseCredentialAuthorization,
  type MailboxHttpAccessDecision,
} from './mailbox-http-auth.js';
import {
  filterMailboxMessagesByTimestamp,
  MAILBOX_HTTP_MAX_AGE_CEILING_MS,
  MailboxHttpValidationError,
  parseSinceMs,
  requireString,
  type MailboxCheckInput,
  validateAck,
  validateAckMany,
  validateAgentHeartbeat,
  validateAgentRegistration,
  validateCheck,
  validateClientHeartbeat,
  validateClientRegistration,
  validateQuery,
  validateSend,
  validationError,
} from './mailbox-http-validation.js';
import type {
  ActorMailboxMessage,
  Mailbox,
  MailboxActorContext,
  MailboxAudience,
  MailboxCapability,
  MailboxMessage,
  MailboxMessageProjection,
  MailboxMessageType,
} from './mailbox-types.js';
import {
  hasMailboxCapability,
  isActionRequiredForActor,
  isMailboxMessageVisibleTo,
  sessionRecipient,
} from './mailbox-types.js';
import type { MailboxHttpRateLimiter } from './mailbox-http-rate-limit.js';
export {
  MAILBOX_HTTP_RATE_LIMIT_PER_MINUTE,
  MAILBOX_HTTP_RATE_LIMIT_WINDOW_MS,
  MailboxHttpRateLimiter,
} from './mailbox-http-rate-limit.js';

export const MAILBOX_HTTP_MAX_BODY_BYTES = 256 * 1024;

/**
 * Per-connection cap on unflushed SSE bytes. A consumer whose socket buffers
 * more than this is too slow (or dead) to keep up; we drop it rather than let
 * one stalled client grow the process's memory without bound.
 */
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

// Filter bounds shipped with the router: `MAILBOX_HTTP_DEFAULT_MAX_AGE_MS`
// is a 1-hour reference default callers may opt into via the `defaultMaxAgeMs`
// option; `MAILBOX_HTTP_MAX_AGE_CEILING_MS` is the per-request look-back
// ceiling at 7 days. The router does NOT enable a look-back automatically —
// leaving `defaultMaxAgeMs` `undefined` returns every retained message; the
// per-request `?sinceMs=0` URL query parameter remains the disable sentinel
// for the URL param.
export const MAILBOX_HTTP_DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
export { MAILBOX_HTTP_MAX_AGE_CEILING_MS };

export {
  authorizeMailboxBearerToken,
  authorizePersistedMailboxCredential,
  type MailboxHttpAccessDecision,
  type MailboxHttpCredentialDecision,
} from './mailbox-http-auth.js';

export interface MailboxHttpRouterOptions {
  mailbox: Mailbox;
  eventEmitter?: MailboxEventEmitter;
  authorize?: (
    request: IncomingMessage,
  ) => MailboxHttpAccessDecision | Promise<MailboxHttpAccessDecision>;
  /** Identity-scoped credential store for principal-based auth (GM-P0.6). */
  credentialStore?: MailboxCredentialVerifier;
  /** Project ID for credential-based auth project-scoping (GM-P0.9). */
  projectId?: string;
  rateLimiter?: MailboxHttpRateLimiter;
  maxBodyBytes?: number;
  /**
   * Server-default look-back window for mailbox routes that return
   * `MailboxMessage` records (`/mailbox/query`, `/mailbox/check`,
   * `/mailbox/events`).
   *
   * The filter is **opt-in**: leaving `defaultMaxAgeMs` `undefined`
   * (the default) leaves the filter disabled and every retained
   * message is eligible to be returned or streamed. Pass an explicit
   * non-negative integer (e.g. `60 * 60_000` for a 1-hour look-back,
   * or {@link MAILBOX_HTTP_DEFAULT_MAX_AGE_MS}) to activate it.
   *
   * Mail older than the resolved look-back is filtered out of JSON
   * responses and from SSE delivery so polling agents are never
   * flooded with stale mail. The library intentionally does NOT
   * enable a default look-back; host integrators that want the
   * 1-hour server default must opt in explicitly.
   *
   * Per-request override: callers may append `?sinceMs=<ms>` to the
   * request URL (the URL is rewritten by hosts that mount the router
   * below a prefix). `0` opts in to the full retained history (matches
   * the disable semantics of `defaultMaxAgeMs` below) and any positive
   * value above {@link MAILBOX_HTTP_MAX_AGE_CEILING_MS} is silently
   * clamped to that ceiling — this is a soft cap, not a hard rejection.
   *
   * Disabling the filter server-wide: pass `defaultMaxAgeMs` as
   * `undefined` (the default), any negative number (`-1` is the
   * canonical test-suite escape hatch), any non-finite value (`NaN`,
   * `Infinity`, `-Infinity`), or `0`. `0` here is reserved because
   * `now - 0` would otherwise map to the current instant and hide
   * every retained message; `resolveDefault()` therefore treats `0` as
   * equivalent to "disabled" via the same sentinel path as
   * `undefined` / negative / non-finite values. The per-request
   * `?sinceMs=0` URL parameter and the server-side `defaultMaxAgeMs=0`
   * option therefore share identical "no filter" semantics.
   */
  defaultMaxAgeMs?: number;
}

export interface MailboxHttpRouter {
  /**
   * Handle one canonical mailbox HTTP request. `routePath` lets a host mount
   * the protocol below another prefix while preserving the public
   * `/mailbox/*` route contract internally.
   */
  handle(request: IncomingMessage, response: ServerResponse, routePath?: string): Promise<void>;
  /** Close every active SSE stream owned by this router. Idempotent. */
  close(): void;
}

export function createMailboxHttpRouter(options: MailboxHttpRouterOptions): MailboxHttpRouter {
  const maxBodyBytes = options.maxBodyBytes ?? MAILBOX_HTTP_MAX_BODY_BYTES;
  // Coerce JSON-spread `null` to `undefined` so the documented "absent
  // means disabled" sentinel path at `resolveDefault()` is the single
  // source of truth — callers that JSON-decode `{ defaultMaxAgeMs: null }`
  // and spread it would otherwise leak `null` through, which `!Number.isFinite`
  // silently treats as a disable but the JSDoc only documents for
  // `undefined` / negative / non-finite / `0`. See JSDoc on
  // `MailboxHttpRouterOptions.defaultMaxAgeMs`.
  const defaultMaxAgeMs = options.defaultMaxAgeMs ?? undefined;
  const closeSseStreams = new Set<() => void>();

  // H1: Require projectId when credentialStore is configured.
  if (options.credentialStore !== undefined && options.projectId === undefined) {
    throw new TypeError('projectId is required when credentialStore is configured');
  }

  return {
    async handle(request, response, routePath): Promise<void> {
      try {
        const url = routePath ?? request.url ?? '/';
        const method = request.method ?? 'GET';

        // Health probes deliberately bypass auth and rate limiting. The route
        // reveals only process liveness and remains compatible with the
        // standalone bridge's lock-file probe.
        if (method === 'GET' && url === '/healthz') {
          writeJson(response, 200, { ok: true });
          return;
        }

        const customAccess = options.authorize
          ? await options.authorize(request)
          : undefined;
        let access: MailboxHttpAccessDecision = customAccess ?? { allowed: true };
        const presentedCredential = parseCredentialAuthorization(request);
        if (options.credentialStore !== undefined && presentedCredential !== undefined) {
          const persistedAccess = await authorizePersistedMailboxCredential(
            request,
            options.credentialStore,
          );
          if (!persistedAccess.allowed) {
            access = persistedAccess;
          } else if (persistedAccess.actor === undefined) {
            access = { allowed: false };
          } else if (access.allowed) {
            if (
              access.actor !== undefined &&
              (access.actor.actorId !== persistedAccess.actor.actorId ||
                access.actor.projectId !== persistedAccess.actor.projectId)
            ) {
              access = { allowed: false };
            } else {
              access = {
                ...access,
                // The persisted credential is authoritative for identity and
                // capabilities; a custom authorizer may hold a stale snapshot.
                actor: persistedAccess.actor,
                ...(access.rateLimitKey ?? persistedAccess.rateLimitKey
                  ? { rateLimitKey: access.rateLimitKey ?? persistedAccess.rateLimitKey }
                  : {}),
              };
            }
          }
        } else if (customAccess === undefined && options.credentialStore !== undefined) {
          access = { allowed: false };
        }
        if (
          access.allowed &&
          access.actor !== undefined &&
          options.projectId !== undefined &&
          access.actor.projectId !== options.projectId
        ) {
          writeJson(response, 403, {
            error: { code: 'FORBIDDEN', message: 'credential is scoped to a different project' },
          });
          return;
        }
        if (!access.allowed) {
          const forwardedFor = request.headers['x-forwarded-for'];
          const clientIp =
            (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ??
            request.socket?.remoteAddress ??
            'unknown';
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'mailbox.http_auth_failure',
              message: `Mailbox HTTP auth rejected for ${request.method ?? '?'} ${request.url ?? '?'} from ${clientIp}`,
              method: request.method,
              url: request.url,
              clientIp,
              timestamp: new Date().toISOString(),
            }),
          );
          writeJson(
            response,
            access.status ?? 401,
            access.body ?? {
              error: { code: 'UNAUTHORIZED', message: 'invalid or missing authorization credential' },
            },
          );
          return;
        }

        if (
          options.rateLimiter &&
          access.rateLimitKey !== undefined &&
          !options.rateLimiter.allow(access.rateLimitKey)
        ) {
          writeJson(response, 429, {
            error: {
              code: 'RATE_LIMITED',
              message: `rate limit exceeded: max ${options.rateLimiter.limit} requests per ${options.rateLimiter.windowMs / 1000}s`,
            },
          });
          return;
        }

        await dispatchMailboxRoute(
          options.mailbox,
          options.eventEmitter,
          request,
          response,
          method,
          url,
          maxBodyBytes,
          defaultMaxAgeMs,
          closeSseStreams,
          routePath,
          access.actor,
          options.credentialStore,
        );
      } catch (error) {
        const code =
          error instanceof MailboxHttpValidationError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
        const status = code === 'VALIDATION_ERROR' ? 400 : 500;
        writeJson(response, status, {
          error: {
            code,
            message: error instanceof Error ? error.message : 'unknown error',
          },
        });
      }
    },
    close(): void {
      for (const close of [...closeSseStreams]) close();
      closeSseStreams.clear();
    },
  };
}

async function dispatchMailboxRoute(
  mailbox: Mailbox,
  eventEmitter: MailboxEventEmitter | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: string,
  maxBodyBytes: number,
  defaultMaxAgeMs: number | undefined,
  closeSseStreams: Set<() => void>,
  routePath?: string,
  actor?: MailboxActorContext,
  credentialStore?: MailboxCredentialVerifier,
): Promise<void> {
  // The look-back window is a per-route concern — only the routes that
  // return `MailboxMessage` records (query, check, events) care. We
  // resolve it lazily inside each handler so a malformed `?sinceMs=…`
  // on an unknown route still surfaces as 404 NOT_FOUND rather than
  // being shadowed by a 400 VALIDATION_ERROR.
  //
  // The dispatched `url` may carry a query string (routePath-as-mounted
  // by hosts, or `?sinceMs=…` for the per-request override). Strip the
  // `?…` portion before matching the canonical route table; the full
  // `url` is still available to `parseSinceMs()` and the 404 message.
  //
  // Contract: `routePath` may carry an OPTIONAL per-request query
  // string (e.g. `?sinceMs=0`) — hosts mount the canonical routes at
  // a prefix and the query is forwarded verbatim so the router's
  // `parseSinceMs()` sees the override. Only a literal `?` at position
  // 0 of the resolved URL is rejected: that signals the request URL
  // itself (or the rewritten routePath) starts with a query character,
  // which is always a host-side mistake. Mid-path `?` segments from a
  // sloppy prefix (e.g. `/api?token=…`) would still be misparsed, so
  // hosts must mount the router below a path-only prefix.
  //
  // Note: a `?` in the *resolved* URL is legitimate when the request
  // URL (or the per-request `?sinceMs=…` override) carries one.
  if (routePath !== undefined && routePath.indexOf('?') === 0) {
    throw validationError(`routePath must not start with '?' (got ${JSON.stringify(routePath)})`);
  }
  // Hosts may legitimately append a per-request query (e.g. `?sinceMs=0`)
  // to the rewritten route path. Strip it here so the canonical route
  // table matches the path-only form; the full `url` (path + query) is
  // still passed to `parseSinceMs()` for per-request overrides.
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);

  if (actor !== undefined) {
    const requiredCapability = requiredCredentialCapability(method, path);
    if (requiredCapability === undefined) {
      writeJson(response, 403, {
        error: { code: 'FORBIDDEN', message: `credential access is not permitted for ${method} ${path}` },
      });
      return;
    }
    // Send capabilities depend on the validated message type, so that route is
    // intentionally authorized after body parsing. All other routes have one
    // static capability and can be denied before consuming the request body.
    if (path !== '/mailbox/send' && !hasMailboxCapability(actor, requiredCapability)) {
      writeJson(response, 403, {
        error: {
          code: 'FORBIDDEN',
          message: `credential lacks required capability "${requiredCapability}"`,
        },
      });
      return;
    }
  }

  if (method === 'POST' && path === '/mailbox/send') {
    const input = validateSend(await readJsonBody(request, maxBodyBytes), actor?.actorId);
    if (actor !== undefined) {
      const requiredCapability = requiredSendCapability(input.type);
      if (requiredCapability === undefined || !hasMailboxCapability(actor, requiredCapability)) {
        writeJson(response, 403, {
          error: {
            code: 'FORBIDDEN',
            message:
              requiredCapability === undefined
                ? `credential cannot send message type "${input.type}"`
                : `credential lacks required capability "${requiredCapability}"`,
          },
        });
        return;
      }
      input.from = actor.actorId;
    }
    writeJson(response, 201, await mailbox.send(input));
    return;
  }
  if (method === 'POST' && path === '/mailbox/query') {
    const queryContext = parseSinceMs(url, defaultMaxAgeMs);
    if ('error' in queryContext) {
      writeJson(response, 400, { error: queryContext.error });
      return;
    }
    const query = validateQuery(await readJsonBody(request, maxBodyBytes));
    const selfScoped = actor !== undefined && !hasMailboxCapability(actor, 'mail.read.all');
    const actorProjectionRequired =
      actor !== undefined && !hasMailboxCapability(actor, 'mail.admin.receipts');
    if (actorProjectionRequired && (query.unreadBy !== undefined || query.incompleteOnly === true)) {
      // Any non-receipt-admin response is actor-relative, even when the actor
      // may read all message bodies. Never let it select another actor's state.
      query.unreadBy = actor.actorId;
      query.readerRole = actor.role;
    }
    if (actor !== undefined) query.includeReceiptState = true;
    const messages = selfScoped && actor !== undefined
      ? await queryMessagesForActor(mailbox, actor, query)
      : await mailbox.query(query);
    const filtered = filterMailboxMessagesByTimestamp(messages, queryContext.minTimestampIso);
    const projected =
      actorProjectionRequired && actor !== undefined
        ? filtered.map((message) => stripAggregateReceiptState(message, actor.actorId))
        : filtered;
    writeJson(response, 200, { data: projected, count: projected.length });
    return;
  }
  if (method === 'POST' && path === '/mailbox/check') {
    const queryContext = parseSinceMs(url, defaultMaxAgeMs);
    if ('error' in queryContext) {
      writeJson(response, 400, { error: queryContext.error });
      return;
    }
    const checkInput = validateCheck(await readJsonBody(request, maxBodyBytes), actor?.actorId);
    if (actor !== undefined) {
      // `checkMailbox()` marks messages read unless the caller explicitly opts out.
      const modifiesReceipts =
        checkInput.markRead !== false || checkInput.completed === true || checkInput.outcome !== undefined;
      if (modifiesReceipts && !hasMailboxCapability(actor, 'mail.ack.self')) {
        writeJson(response, 403, {
          error: {
            code: 'FORBIDDEN',
            message: 'capability "mail.ack.self" required for this operation',
          },
        });
        return;
      }
      checkInput.agentId = actor.actorId;
      delete checkInput.baseId;
    }
    const actorProjectionRequired =
      actor !== undefined && !hasMailboxCapability(actor, 'mail.admin.receipts');
    const result = await checkMailbox(
      mailbox,
      checkInput,
      queryContext.minTimestampIso,
      actor !== undefined,
      actor === undefined ? undefined : eligibleRecipientsForActor(actor),
      actor?.role,
    );
    const projected =
      actorProjectionRequired && actor !== undefined
        ? result.data.map((message) => stripAggregateReceiptState(message, actor.actorId))
        : result.data;
    writeJson(response, 200, { data: projected, count: projected.length });
    return;
  }
  if (method === 'POST' && path === '/mailbox/ack') {
    const input = validateAck(await readJsonBody(request, maxBodyBytes), actor?.actorId);
    if (actor !== undefined) {
      input.readerId = actor.actorId;
      if (!(await isMessageVisibleToActor(mailbox, input.messageId, actor))) {
        writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'message not found' } });
        return;
      }
    }
    const updated = await mailbox.ack(input);
    const projectedAck = actor !== undefined && !hasMailboxCapability(actor, 'mail.admin.receipts') && updated !== null
      ? stripAggregateReceiptState(updated, actor.actorId)
      : updated;
    writeJson(response, 200, { updated: projectedAck });
    return;
  }
  if (method === 'POST' && path === '/mailbox/ack-many') {
    const input = validateAckMany(await readJsonBody(request, maxBodyBytes), actor?.actorId);
    if (actor !== undefined) {
      const requestedIds = new Set(input.acks.map((ack) => ack.messageId));
      const visibleIds = new Set(
        (await queryVisibleMessagesForActor(mailbox, actor))
          .filter((message) => requestedIds.has(message.id))
          .map((message) => message.id),
      );
      if (visibleIds.size !== requestedIds.size) {
        writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'message not found' } });
        return;
      }
      input.acks = input.acks.map((ack) => ({ ...ack, readerId: actor.actorId }));
    }
    const updated = await mailbox.ackMany(input);
    const projectedMany = actor !== undefined && !hasMailboxCapability(actor, 'mail.admin.receipts')
      ? updated.map((message) => stripAggregateReceiptState(message, actor.actorId))
      : updated;
    writeJson(response, 200, { updated: projectedMany, count: projectedMany.length });
    return;
  }
  if (method === 'POST' && path === '/mailbox/unread-count') {
    const body = await readJsonBody(request, maxBodyBytes);
    const count = actor === undefined
      ? await mailbox.unreadCount(requireString(body, 'forAgentId'))
      : await unreadCountForActor(mailbox, actor);
    writeJson(response, 200, { count });
    return;
  }
  if (method === 'POST' && path === '/mailbox/agents/register') {
    const input = validateAgentRegistration(await readJsonBody(request, maxBodyBytes), actor);
    await mailbox.registerAgent(input);
    writeJson(response, 200, { ok: true });
    return;
  }
  if (method === 'POST' && path === '/mailbox/agents/heartbeat') {
    const input = validateAgentHeartbeat(await readJsonBody(request, maxBodyBytes), actor?.actorId);
    if (actor !== undefined) input.agentId = actor.actorId;
    await mailbox.heartbeat(input);
    writeJson(response, 200, { ok: true });
    return;
  }
  if (method === 'POST' && path === '/mailbox/register-client') {
    await mailbox.registerClient(
      validateClientRegistration(await readJsonBody(request, maxBodyBytes)),
    );
    writeJson(response, 200, { ok: true });
    return;
  }
  if (method === 'POST' && path === '/mailbox/heartbeat') {
    await mailbox.clientHeartbeat(
      validateClientHeartbeat(await readJsonBody(request, maxBodyBytes)),
    );
    writeJson(response, 200, { ok: true });
    return;
  }
  if (method === 'POST' && path === '/mailbox/purge-clients') {
    writeJson(response, 200, { ok: true, purged: await mailbox.purgeClients() });
    return;
  }
  if (method === 'GET' && path === '/mailbox/agents') {
    const agents = await mailbox.getAgentStatuses();
    writeJson(response, 200, { data: agents, count: agents.length });
    return;
  }
  if (method === 'GET' && path === '/mailbox/agents/online') {
    const agents = await mailbox.getOnlineAgents();
    writeJson(response, 200, { data: agents, count: agents.length });
    return;
  }
  if (method === 'GET' && path === '/mailbox/events' && eventEmitter) {
    const queryContext = parseSinceMs(url, defaultMaxAgeMs);
    if ('error' in queryContext) {
      writeJson(response, 400, { error: queryContext.error });
      return;
    }
    handleSse(
      request,
      response,
      eventEmitter,
      queryContext.minTimestampIso,
      closeSseStreams,
      actor !== undefined && !hasMailboxCapability(actor, 'mail.events.all') ? actor : undefined,
      actor === undefined || credentialStore === undefined
        ? undefined
        : createCredentialRevalidator(request, credentialStore, actor),
    );
    return;
  }

  writeJson(response, 404, {
    error: { code: 'NOT_FOUND', message: `no route for ${method} ${url}` },
  });
}

function stripAggregateReceiptState(
  message: MailboxMessage,
  actorId: string,
): ActorMailboxMessage {
  const projection = message as Partial<MailboxMessageProjection>;
  const actorState = projection.recipientState?.[actorId];
  const readByMe = actorState?.readAt !== undefined || actorId in message.readBy;
  const completedByMe = actorState?.completedAt !== undefined;
  const legacyGlobalCompletion = projection.legacyGlobalCompletion === true;
  const visible = { ...message } as Record<string, unknown>;
  delete visible['readBy'];
  delete visible['completed'];
  delete visible['completedBy'];
  delete visible['completedAt'];
  delete visible['outcome'];
  delete visible['recipientState'];
  delete visible['legacyGlobalCompletion'];

  return {
    ...visible,
    readByMe,
    completedByMe,
    actionRequiredForMe: isActionRequiredForActor(message, {
      completedByMe,
      legacyGlobalCompletion,
    }),
    ...(actorState?.outcome !== undefined ? { myOutcome: actorState.outcome } : {}),
    ...(legacyGlobalCompletion ? { legacyGlobalCompletion: true } : {}),
  } as ActorMailboxMessage;
}

function eligibleRecipientsForActor(actor: MailboxActorContext): string[] {
  return [...new Set([
    actor.actorId,
    ...actor.recipientAliases,
    ...(actor.sessionId === undefined ? [] : [sessionRecipient(actor.sessionId)]),
  ])];
}

async function queryMessagesForActor(
  mailbox: Mailbox,
  actor: MailboxActorContext,
  query: Parameters<Mailbox['query']>[0],
): Promise<MailboxMessage[]> {
  const eligibleRecipients = new Set(eligibleRecipientsForActor(actor));
  const requestedRecipient = query.to;
  if (requestedRecipient !== undefined && !eligibleRecipients.has(requestedRecipient)) return [];

  const recipients = requestedRecipient === undefined
    ? [...eligibleRecipients]
    : [requestedRecipient];
  const batches = await Promise.all(
    recipients.map((to) => mailbox.query({ ...query, to })),
  );
  const seen = new Set<string>();
  const visible = batches.flat().filter((message) => {
    if (seen.has(message.id)) return false;
    if (!isMailboxMessageVisibleTo(message, actor.actorId, actor.role)) return false;
    seen.add(message.id);
    return true;
  });
  visible.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return visible.slice(0, query.limit ?? 50);
}

async function queryVisibleMessagesForActor(
  mailbox: Mailbox,
  actor: MailboxActorContext,
): Promise<MailboxMessage[]> {
  return queryMessagesForActor(mailbox, actor, {
    readerRole: actor.role,
    limit: Number.MAX_SAFE_INTEGER,
    includeReceiptState: true,
  });
}

async function unreadCountForActor(
  mailbox: Mailbox,
  actor: MailboxActorContext,
): Promise<number> {
  const messages = await queryMessagesForActor(mailbox, actor, {
    unreadBy: actor.actorId,
    readerRole: actor.role,
    includeReceiptState: true,
    limit: Number.MAX_SAFE_INTEGER,
  });
  return messages.filter((message) => !isMessageCompletedForActor(message, actor.actorId)).length;
}

function isMessageCompletedForActor(message: MailboxMessage, actorId: string): boolean {
  const projection = message as Partial<MailboxMessageProjection>;
  if (projection.legacyGlobalCompletion === true) return true;
  const recipientState = projection.recipientState;
  const actorState = recipientState?.[actorId];
  if (actorState !== undefined) return actorState.completedAt !== undefined;
  if (recipientState !== undefined && Object.keys(recipientState).length > 0) return false;
  return message.completed === true;
}

async function isMessageVisibleToActor(
  mailbox: Mailbox,
  messageId: string,
  actor: MailboxActorContext,
): Promise<boolean> {
  const messages = await queryVisibleMessagesForActor(mailbox, actor);
  return messages.some((message) => message.id === messageId);
}

function requiredSendCapability(type: MailboxMessageType): MailboxCapability | undefined {
  if (type === 'control') return undefined;
  if (type === 'steer') return 'mail.send.directive';
  if (type === 'ask' || type === 'assign' || type === 'review') {
    return 'mail.send.actionable';
  }
  return 'mail.send.informational';
}

function requiredCredentialCapability(
  method: string,
  path: string,
): MailboxCapability | undefined {
  if (method === 'POST' && path === '/mailbox/send') return 'mail.send.informational';
  if (method === 'POST' && (path === '/mailbox/query' || path === '/mailbox/check')) {
    return 'mail.read.self';
  }
  if (method === 'POST' && (path === '/mailbox/ack' || path === '/mailbox/ack-many')) {
    return 'mail.ack.self';
  }
  if (method === 'POST' && path === '/mailbox/unread-count') return 'mail.read.self';
  if (method === 'POST' && path === '/mailbox/agents/register') {
    return 'mail.presence.register.self';
  }
  if (method === 'POST' && path === '/mailbox/agents/heartbeat') {
    return 'mail.presence.heartbeat.self';
  }
  if (method === 'GET' && (path === '/mailbox/agents' || path === '/mailbox/agents/online')) {
    return 'mail.presence.read';
  }
  if (method === 'GET' && path === '/mailbox/events') return 'mail.events.self';
  return undefined;
}

/**
 * Pull a timestamp off an SSE event for the staleness-filter check.
 *
 * SSE events arrive in two shapes:
 *   - Top-level `{ timestamp: string, ... }` — produced by
 *     `MailboxEventEmitter` directly when a single mail is forwarded.
 *   - Nested `{ messageSent: { timestamp: string, ... }, ... }` —
 *     produced when a peer bridge forwards a messageSent replay event.
 *
 * `messageSent` and `ackUpdated` are the documented nested shapes today;
 * if new shapes are added, extend the `nestedKeys` set below. Returns
 * `undefined` for any non-object event or when no recognised timestamp
 * field is present, in which case the filter is skipped (preserves the
 * pre-filter behaviour: drop nothing we cannot classify).
 */
function extractEventTimestamp(event: unknown): string | undefined {
  for (const record of mailboxEventRecords(event)) {
    const timestamp = record['timestamp'];
    if (typeof timestamp === 'string') return timestamp;
  }
  return undefined;
}

function isEventOlderThan(event: unknown, minTimestampIso: string): boolean {
  const eventTimestamp = extractEventTimestamp(event);
  if (eventTimestamp === undefined) return false;
  return eventTimestamp < minTimestampIso;
}

function mailboxEventRecords(event: unknown): Record<string, unknown>[] {
  if (event === null || typeof event !== 'object') return [];
  const record = event as Record<string, unknown>;
  const records = [record];
  // Keep this bounded to the documented one-level envelopes. Recursive walking
  // would allow unrelated nested objects to accidentally satisfy visibility.
  for (const key of ['messageSent', 'ackUpdated'] as const) {
    const nested = record[key];
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      records.push(nested as Record<string, unknown>);
    }
  }
  return records;
}

function isMailboxEventVisibleToActor(event: unknown, actor: MailboxActorContext): boolean {
  for (const record of mailboxEventRecords(event)) {
    const from = record['from'];
    const to = record['to'];
    const audience = record['audience'];
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (audience !== undefined && audience !== 'all' && audience !== 'leaders') continue;
    const addressedToActor =
      from === actor.actorId ||
      to === actor.actorId ||
      to === '*' ||
      actor.recipientAliases.has(to) ||
      (actor.sessionId !== undefined && to === `@session:${actor.sessionId}`);
    if (
      addressedToActor &&
      isMailboxMessageVisibleTo(
        { audience: audience as MailboxAudience | undefined },
        actor.actorId,
        actor.role,
      )
    ) {
      return true;
    }
  }
  return false;
}

function createCredentialRevalidator(
  request: IncomingMessage,
  store: MailboxCredentialVerifier,
  actor: MailboxActorContext,
): () => Promise<boolean> {
  const parsed = parseCredentialAuthorization(request);
  if (parsed === undefined) return async () => false;
  return async () => {
    const validation = await store.verifyPersisted(parsed.credentialId, parsed.secret);
    return validation.valid &&
      validation.credential?.principalId === actor.actorId &&
      validation.credential.projectId === actor.projectId;
  };
}

function handleSse(
  request: IncomingMessage,
  response: ServerResponse,
  eventEmitter: MailboxEventEmitter,
  minTimestampIso: string | undefined,
  closeSseStreams: Set<() => void>,
  actor?: MailboxActorContext,
  revalidateCredential?: () => Promise<boolean>,
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write(': connected\n\n');

  // `close` is forward-referenced by the subscribe callback (which may fire
  // before the rest of the setup runs), so declare its dependencies first.
  let closed = false;
  let unsubscribe: () => void = () => {};
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (keepAlive !== undefined) clearInterval(keepAlive);
    unsubscribe();
    closeSseStreams.delete(close);
    try {
      response.end();
    } catch {
      // The client already closed the stream.
    }
  };

  let deliveryChain = Promise.resolve();
  const enqueue = (operation: () => Promise<void>): void => {
    if (revalidateCredential === undefined) {
      void operation();
      return;
    }
    deliveryChain = deliveryChain.then(operation, operation);
  };

  unsubscribe = eventEmitter.subscribe((event) => {
    enqueue(async () => {
      if (closed) return;
      try {
        if (revalidateCredential !== undefined && !(await revalidateCredential())) {
          close();
          return;
        }
        // The stream may have closed while persisted credential I/O was in flight.
        if (closed) return;
        // SSE events carry a `timestamp` field at the top level. Some event
        // shapes (e.g. `messageSent`) wrap the timestamp inside a nested
        // payload — `extractEventTimestamp()` walks one level into the known
        // nested shape so a long-lived SSE subscriber is not flooded by
        // bulk historical mail forwarded by another bridge whose outer
        // timestamp is fresh but whose nested timestamp is stale.
        if (minTimestampIso !== undefined && isEventOlderThan(event, minTimestampIso)) {
          return;
        }
        if (
          actor !== undefined &&
          !isMailboxEventVisibleToActor(event, actor)
        ) {
          return;
        }
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        // Backpressure guard: `write()`'s return value was previously ignored, so
        // a slow or stalled consumer made Node buffer every event in memory
        // without bound. Once the unflushed backlog exceeds the cap, drop this
        // one consumer rather than let a single dead client grow the process.
        if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
          close();
        }
      } catch {
        close();
      }
    });
  });
  keepAlive = setInterval(() => {
    enqueue(async () => {
      if (closed) return;
      try {
        if (revalidateCredential !== undefined && !(await revalidateCredential())) {
          close();
          return;
        }
        // The stream may have closed while persisted credential I/O was in flight.
        if (closed) return;
        response.write(': keepalive\n\n');
      } catch {
        close();
      }
    });
  }, 15_000);

  closeSseStreams.add(close);
  request.once('close', close);
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const lengthHeader = request.headers['content-length'];
  if (typeof lengthHeader === 'string') {
    const declared = Number.parseInt(lengthHeader, 10);
    if (Number.isInteger(declared) && declared > maxBodyBytes) {
      throw validationError(`request body too large: ${declared} bytes (max ${maxBodyBytes})`);
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw validationError(`request body too large: > ${maxBodyBytes} bytes`);
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw validationError(
      `invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function checkMailbox(
  mailbox: Mailbox,
  input: MailboxCheckInput,
  minTimestampIso: string | undefined,
  includeReceiptState = false,
  eligibleRecipients?: readonly string[],
  readerRole?: string,
): Promise<{ data: MailboxMessage[]; count: number }> {
  const limit = input.limit ?? 20;
  const markRead = input.markRead ?? true;
  const completed = input.completed ?? false;
  const targets = eligibleRecipients ?? (
    input.baseId !== undefined && input.baseId !== input.agentId
      ? [input.agentId, input.baseId]
      : [input.agentId]
  );
  const batches = await Promise.all(
    targets.map((to) =>
      mailbox.query({
        to,
        unreadBy: input.agentId,
        readerRole,
        limit,
        includeReceiptState,
      }),
    ),
  );
  // Apply the staleness filter up-front so a `?sinceMs=0` call cannot
  // ack messages that the filter then drops from the response — the
  // response set and the ack-set must stay in lock-step. The same
  // cut-off is reused by `/mailbox/query` and `/mailbox/events`.
  const withinWindow = filterMailboxMessagesByTimestamp(batches.flat(), minTimestampIso);
  const seen = new Set<string>();
  const messages = withinWindow
    .filter((message) => {
      if (seen.has(message.id) || message.from === input.agentId) return false;
      if (!isMailboxMessageVisibleTo(message, input.agentId, readerRole)) return false;
      seen.add(message.id);
      return true;
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
  const data =
    markRead || completed
      ? await mailbox.ackMany({
          acks: messages.map((message) => ({
            messageId: message.id,
            readerId: input.agentId,
            read: markRead,
            completed,
            outcome: completed ? input.outcome : undefined,
          })),
        })
      : messages;
  return { data, count: data.length };
}
