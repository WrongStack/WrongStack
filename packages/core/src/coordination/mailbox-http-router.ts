import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MailboxCredentialVerifier } from './mailbox-credential-store.js';
import type { MailboxEventEmitter } from './mailbox-events.js';
import {
  checkMailbox,
  eligibleRecipientsForActor,
  isMessageVisibleToActor,
  queryMessagesForActor,
  requiredCredentialCapability,
  requiredSendCapability,
  stripAggregateReceiptState,
  unreadCountForActor,
  visibleMessageIdsForActor,
} from './mailbox-http-actor-query.js';
import {
  authorizePersistedMailboxCredential,
  type MailboxHttpAccessDecision,
  parseCredentialAuthorization,
} from './mailbox-http-auth.js';

export type { MailboxHttpAccessDecision };
import type { MailboxHttpRateLimiter } from './mailbox-http-rate-limit.js';
import { createCredentialRevalidator, handleSse } from './mailbox-http-sse.js';
import {
  filterMailboxMessagesByTimestamp,
  MAILBOX_HTTP_MAX_AGE_CEILING_MS,
  MailboxHttpValidationError,
  parseSinceMs,
  requireString,
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
import type { Mailbox, MailboxActorContext } from './mailbox-types.js';
import { hasMailboxCapability } from './mailbox-types.js';

export {
  MAILBOX_HTTP_RATE_LIMIT_PER_MINUTE,
  MAILBOX_HTTP_RATE_LIMIT_WINDOW_MS,
  MailboxHttpRateLimiter,
} from './mailbox-http-rate-limit.js';

export const MAILBOX_HTTP_MAX_BODY_BYTES = 256 * 1024;
export const MAILBOX_HTTP_DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export { authorizeMailboxBearerToken, authorizePersistedMailboxCredential } from './mailbox-http-auth.js';;
export { MAILBOX_HTTP_MAX_AGE_CEILING_MS };

export interface MailboxHttpRouterOptions {
  mailbox: Mailbox;
  eventEmitter?: MailboxEventEmitter;
  authorize?: (
    request: IncomingMessage,
  ) => MailboxHttpAccessDecision | Promise<MailboxHttpAccessDecision>;
  credentialStore?: MailboxCredentialVerifier;
  projectId?: string;
  rateLimiter?: MailboxHttpRateLimiter;
  maxBodyBytes?: number;
  defaultMaxAgeMs?: number;
}

export interface MailboxHttpRouter {
  handle(request: IncomingMessage, response: ServerResponse, routePath?: string): Promise<void>;
  close(): void;
  hasActiveStreams(): boolean;
}

export function createMailboxHttpRouter(options: MailboxHttpRouterOptions): MailboxHttpRouter {
  const maxBodyBytes = options.maxBodyBytes ?? MAILBOX_HTTP_MAX_BODY_BYTES;
  const defaultMaxAgeMs = options.defaultMaxAgeMs ?? undefined;
  const closeSseStreams = new Set<() => void>();

  if (options.credentialStore !== undefined && options.projectId === undefined) {
    throw new TypeError('projectId is required when credentialStore is configured');
  }

  return {
    async handle(request, response, routePath): Promise<void> {
      try {
        const url = routePath ?? request.url ?? '/';
        const method = request.method ?? 'GET';

        if (method === 'GET' && url === '/healthz') {
          writeJson(response, 200, { ok: true });
          return;
        }

        const customAccess = options.authorize ? await options.authorize(request) : undefined;
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
                actor: persistedAccess.actor,
                ...((access.rateLimitKey ?? persistedAccess.rateLimitKey)
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
              error: {
                code: 'UNAUTHORIZED',
                message: 'invalid or missing authorization credential',
              },
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
    hasActiveStreams(): boolean {
      return closeSseStreams.size > 0;
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
  if (routePath !== undefined && routePath.indexOf('?') === 0) {
    throw validationError(`routePath must not start with '?' (got ${JSON.stringify(routePath)})`);
  }
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);

  if (actor !== undefined) {
    const requiredCapability = requiredCredentialCapability(method, path);
    if (requiredCapability === undefined) {
      writeJson(response, 403, {
        error: {
          code: 'FORBIDDEN',
          message: `credential access is not permitted for ${method} ${path}`,
        },
      });
      return;
    }
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
    const input = validateSend(
      await readJsonBody(request, maxBodyBytes),
      actor?.actorId,
      actor?.sessionId,
    );
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
    if (
      actorProjectionRequired &&
      (query.unreadBy !== undefined || query.incompleteOnly === true)
    ) {
      query.unreadBy = actor.actorId;
      query.readerRole = actor.role;
    }
    if (actor !== undefined) query.includeReceiptState = true;
    const messages =
      selfScoped && actor !== undefined
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
      const modifiesReceipts =
        checkInput.markRead !== false ||
        checkInput.completed === true ||
        checkInput.outcome !== undefined;
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
    const projectedAck =
      actor !== undefined && !hasMailboxCapability(actor, 'mail.admin.receipts') && updated !== null
        ? stripAggregateReceiptState(updated, actor.actorId)
        : updated;
    writeJson(response, 200, { updated: projectedAck });
    return;
  }
  if (method === 'POST' && path === '/mailbox/ack-many') {
    const input = validateAckMany(await readJsonBody(request, maxBodyBytes), actor?.actorId);
    if (actor !== undefined) {
      const requestedIds = new Set(input.acks.map((ack) => ack.messageId));
      const visibleIds = await visibleMessageIdsForActor(mailbox, actor, [...requestedIds]);
      if (visibleIds.size !== requestedIds.size) {
        writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'message not found' } });
        return;
      }
      input.acks = input.acks.map((ack) => ({ ...ack, readerId: actor.actorId }));
    }
    const updated = await mailbox.ackMany(input);
    const projectedMany =
      actor !== undefined && !hasMailboxCapability(actor, 'mail.admin.receipts')
        ? updated.map((message) => stripAggregateReceiptState(message, actor.actorId))
        : updated;
    writeJson(response, 200, { updated: projectedMany, count: projectedMany.length });
    return;
  }
  if (method === 'POST' && path === '/mailbox/unread-count') {
    const body = await readJsonBody(request, maxBodyBytes);
    const count =
      actor === undefined
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
    const input = validateAgentHeartbeat(await readJsonBody(request, maxBodyBytes), actor);
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
