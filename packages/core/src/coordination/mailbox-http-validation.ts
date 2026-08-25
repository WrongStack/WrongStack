import { MAILBOX_MAX_ACK_BATCH, MAILBOX_MAX_QUERY_LIMIT } from './mailbox-constants.js';
import { resolveSendType } from './mailbox-message-codec.js';
import type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  ClientHeartbeatInput,
  ClientRegistrationInput,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxActorContext,
  MailboxAudience,
  MailboxMessage,
  MailboxMessageType,
  MailboxQuery,
  MailboxSendInput,
} from './mailbox-types.js';
import { MAILBOX_TYPE_PROPERTIES, normalizeRecipient } from './mailbox-types.js';

export const MAILBOX_HTTP_MAX_AGE_CEILING_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The request bounds live in `mailbox-constants.ts` because they are not an
// HTTP concern — they bound work in the store, and every untrusted boundary
// (this router, the boundary codecs in `mailbox-codecs.ts`) has to apply the
// same ceiling. A second copy here is how the two validation modules drifted
// apart in the first place.
export {
  MAILBOX_MAX_ACK_BATCH,
  MAILBOX_MAX_QUERY_LIMIT,
} from './mailbox-constants.js';

export class MailboxHttpValidationError extends Error {}

export interface MailboxCheckInput {
  agentId: string;
  baseId?: string;
  limit?: number;
  markRead?: boolean;
  completed?: boolean;
  outcome?: string;
}

export type SinceResolution =
  | { minTimestampIso: string | undefined }
  | { error: { code: 'VALIDATION_ERROR'; message: string } };

export function validationError(message: string): MailboxHttpValidationError {
  return new MailboxHttpValidationError(message);
}

export function requireString(object: unknown, key: string): string {
  if (typeof object !== 'object' || object === null) {
    throw validationError('expected JSON object body');
  }
  const value = (object as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`field "${key}" is required (string)`);
  }
  return value;
}

function requireNumber(object: unknown, key: string): number {
  if (typeof object !== 'object' || object === null) {
    throw validationError('expected JSON object body');
  }
  const value = (object as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw validationError(`field "${key}" is required (integer)`);
  }
  return value;
}

function optionalString(object: unknown, key: string): string | undefined {
  if (typeof object !== 'object' || object === null) return undefined;
  const value = (object as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (value === null) {
    throw validationError(`field "${key}" must not be null when present`);
  }
  if (typeof value !== 'string') {
    throw validationError(`field "${key}" must be a string when present`);
  }
  return value;
}

function optionalNumber(object: unknown, key: string): number | undefined {
  if (typeof object !== 'object' || object === null) return undefined;
  const value = (object as Record<string, unknown>)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') {
    throw validationError(`field "${key}" must be a number when present`);
  }
  return value;
}

function optionalBoolean(object: unknown, key: string): boolean | undefined {
  if (typeof object !== 'object' || object === null) return undefined;
  const value = (object as Record<string, unknown>)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw validationError(`field "${key}" must be a boolean when present`);
  }
  return value;
}

/**
 * Resolves the look-back window for one HTTP request.
 *
 * Behaviour matrix:
 *
 *   - Default disabled (`defaultMaxAgeMs = -1`, the test-suite escape hatch):
 *     filter is off, every message regardless of age is retained.
 *   - Default enabled with no per-request override: filter is `now - defaultMaxAgeMs`.
 *   - Per-request `?sinceMs=N`:
 *       N = 0 -> no filter (retain everything currently held).
 *       N > 0 -> filter is `now - min(N, MAILBOX_HTTP_MAX_AGE_CEILING_MS)`.
 *       N out of range, NaN, non-integer, or non-numeric -> `400 VALIDATION_ERROR`.
 *
 * Returns the resolved cut-off as an ISO-8601 string suitable for
 * lexicographic comparison against `MailboxMessage.timestamp` (every
 * timestamp in the mailbox store is UTC-encoded, so string comparison
 * is monotonic).
 */
export function parseSinceMs(url: string, defaultMaxAgeMs: number | undefined): SinceResolution {
  // The router dispatches by `url` (which is the rewritten `routePath`
  // when the host mounts the router below a prefix, or the raw
  // `request.url`). Strip the optional query string before scanning for
  // the `sinceMs` parameter.
  //
  // Invariant: `routePath` provided by hosts never contains a literal `?`
  // - the router's canonical `/mailbox/*` routes are fixed strings without
  // query characters. `indexOf('?')` therefore always locates the true
  // query boundary, so any `?`-containing suffix is the entire query
  // string and any `&`-separated pairs belong to the query, not to a
  // forged prefix.
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return resolveDefault(defaultMaxAgeMs, Date.now());
  const params = new URLSearchParams(url.slice(queryStart + 1));
  if (!params.has('sinceMs')) return resolveDefault(defaultMaxAgeMs, Date.now());

  const raw = params.get('sinceMs');
  if (raw === null || raw === undefined || raw === '') {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'query parameter "sinceMs" is required (integer in milliseconds) when present',
      },
    };
  }
  // Only digits are accepted; the URLSearchParams parser already rejects
  // `?sinceMs=abc` (it's string-coerced) but explicit guard prevents
  // accidental floats like `1.5` or padded forms slipping through.
  if (!/^\d+$/.test(raw)) {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'query parameter "sinceMs" must be a non-negative integer (milliseconds)',
      },
    };
  }
  const requestedMs = Number(raw);
  if (!Number.isFinite(requestedMs) || requestedMs > Number.MAX_SAFE_INTEGER) {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: `query parameter "sinceMs" is out of range (max ${Number.MAX_SAFE_INTEGER})`,
      },
    };
  }
  const now = Date.now();
  if (requestedMs === 0) return { minTimestampIso: undefined };
  const effectiveMs = Math.min(requestedMs, MAILBOX_HTTP_MAX_AGE_CEILING_MS);
  return { minTimestampIso: new Date(now - effectiveMs).toISOString() };
}

function resolveDefault(defaultMaxAgeMs: number | undefined, now: number): SinceResolution {
  // Sentinel values that disable the look-back filter entirely:
  //   - undefined caller (`defaultMaxAgeMs` never assigned)
  //   - any non-finite number (`NaN`, `Infinity`, `-Infinity`)
  //   - any negative number (the test-suite escape hatch, e.g. `-1`)
  //   - exactly `0` - reserved because `now - 0` would otherwise map
  //     to the current instant and hide every retained message; the
  //     JSDoc on `MailboxHttpRouterOptions.defaultMaxAgeMs` calls this
  //     out as equivalent to "disabled".
  if (
    defaultMaxAgeMs === undefined ||
    !Number.isFinite(defaultMaxAgeMs) ||
    defaultMaxAgeMs < 0 ||
    defaultMaxAgeMs === 0
  ) {
    return { minTimestampIso: undefined };
  }
  return { minTimestampIso: new Date(now - defaultMaxAgeMs).toISOString() };
}

export function filterMailboxMessagesByTimestamp(
  messages: readonly MailboxMessage[],
  minTimestampIso: string | undefined,
): MailboxMessage[] {
  if (minTimestampIso === undefined) return messages.slice();
  return messages.filter((message) => message.timestamp >= minTimestampIso);
}

/**
 * Valid types derived from the canonical MAILBOX_TYPE_PROPERTIES table.
 * Stays in sync automatically as the type union evolves.
 */
const VALID_TYPES = new Set(Object.keys(MAILBOX_TYPE_PROPERTIES) as MailboxMessageType[]);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high']);
const VALID_AUDIENCES = new Set<MailboxAudience>(['all', 'leaders']);
const RESERVED_FROM_IDS = new Set([
  'leader',
  'fleet',
  'hq',
  'mailbox-bridge',
  'mailbox-bridge-watchdog',
  'tech-stack-consumer',
  '*',
]);
const RESERVED_READER_IDS = new Set([
  'leader',
  'fleet',
  'hq',
  'mailbox-bridge',
  'mailbox-bridge-watchdog',
  'tech-stack-consumer',
]);

function validateReaderId(id: string): void {
  const base = id.split('@')[0]!.toLowerCase();
  if (RESERVED_READER_IDS.has(base)) {
    throw validationError(`"readerId" must not use reserved internal agent id "${base}"`);
  }
}

function rejectConflictingIdentity(
  object: Record<string, unknown>,
  key: string,
  expected: string,
): void {
  const supplied = object[key];
  if (supplied !== undefined && supplied !== expected) {
    throw validationError(`field "${key}" conflicts with authenticated identity`);
  }
}

function rejectConflictingOptionalIdentity(
  object: Record<string, unknown>,
  key: string,
  expected: string | undefined,
): void {
  const supplied = object[key];
  if (supplied !== undefined && supplied !== expected) {
    throw validationError(`field "${key}" conflicts with authenticated identity`);
  }
}

function rejectUnexpectedIdentity(object: Record<string, unknown>, key: string): void {
  if (object[key] !== undefined) {
    throw validationError(`field "${key}" is not accepted for credential-authenticated requests`);
  }
}

export function validateSend(
  body: unknown,
  actorId?: string,
  actorSessionId?: string,
): MailboxSendInput {
  if (typeof body !== 'object' || body === null) {
    throw validationError('expected JSON object body');
  }
  const object = body as Record<string, unknown>;
  if (actorId !== undefined) rejectConflictingIdentity(object, 'from', actorId);
  const type = requireString(object, 'type');
  if (!VALID_TYPES.has(type as MailboxMessageType)) {
    throw validationError(`field "type" must be one of ${[...VALID_TYPES].join(', ')}`);
  }
  const priority = optionalString(object, 'priority');
  if (priority !== undefined && !VALID_PRIORITIES.has(priority)) {
    throw validationError(`field "priority" must be one of ${[...VALID_PRIORITIES].join(', ')}`);
  }
  const audience = optionalString(object, 'audience');
  if (audience !== undefined && !VALID_AUDIENCES.has(audience as MailboxAudience)) {
    throw validationError(`field "audience" must be one of ${[...VALID_AUDIENCES].join(', ')}`);
  }
  const from = actorId ?? requireString(object, 'from');
  if (actorId === undefined) {
    const fromBase = from.split('@')[0]!.toLowerCase();
    if (RESERVED_FROM_IDS.has(fromBase)) {
      throw validationError(
        `field "from" must not use reserved internal agent id "${fromBase}" - external agents must use their own identity`,
      );
    }
  }
  // `@session` is a documented alias, but it can only be expanded against a
  // session id. A credential-authenticated actor has one; a bearer-token
  // operator does not. Without one, `normalizeRecipient` throws a bare
  // `TypeError` from `sessionRecipient('')` — which is NOT a
  // `MailboxHttpValidationError`, so the router's catch classified it as
  // INTERNAL_ERROR and answered a documented recipient alias with a 500.
  // Expand it when we can, and refuse it as a 400 with a usable message when
  // we cannot.
  const rawTo = requireString(object, 'to');
  let to: string;
  try {
    to = normalizeRecipient(rawTo, actorSessionId);
  } catch {
    throw validationError(
      'field "to" cannot use the "@session" alias on this connection: no session is bound to the ' +
        'caller. Address a specific agent id, a base alias, "*", or an explicit "@session:<id>".',
    );
  }

  // Cross-field (type, to) validation must use the same canonical recipient
  // that is forwarded to and persisted by the mailbox.
  try {
    resolveSendType(type as MailboxMessageType, to);
  } catch (err) {
    throw validationError(`field "type" is invalid: ${(err as Error).message}`);
  }

  const result: MailboxSendInput = {
    from,
    to,
    type: type as MailboxSendInput['type'],
    subject: requireString(object, 'subject'),
    body: requireString(object, 'body'),
    priority: priority as MailboxSendInput['priority'],
    ...(audience !== undefined ? { audience: audience as MailboxSendInput['audience'] } : {}),
  };
  const replyTo = optionalString(object, 'replyTo');
  if (replyTo !== undefined) result.replyTo = replyTo;
  const ttlMs = optionalNumber(object, 'ttlMs');
  if (ttlMs !== undefined) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) {
      throw validationError('field "ttlMs" must be a positive integer when present');
    }
    result.ttlMs = ttlMs;
  }
  return result;
}

export function validateQuery(body: unknown): MailboxQuery {
  if (typeof body !== 'object' || body === null) {
    throw validationError('expected JSON object body');
  }
  const object = body as Record<string, unknown>;
  const result: MailboxQuery = {};
  const to = optionalString(object, 'to');
  const from = optionalString(object, 'from');
  const unreadBy = optionalString(object, 'unreadBy');
  const type = optionalString(object, 'type');
  const minPriority = optionalString(object, 'minPriority');
  const since = optionalString(object, 'since');
  const limit = optionalNumber(object, 'limit');
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAILBOX_MAX_QUERY_LIMIT) {
      throw validationError(
        `field "limit" must be an integer between 1 and ${MAILBOX_MAX_QUERY_LIMIT} when present`,
      );
    }
  }
  const incompleteOnly = optionalBoolean(object, 'incompleteOnly');
  if (to !== undefined) result.to = to;
  if (from !== undefined) result.from = from;
  if (unreadBy !== undefined) result.unreadBy = unreadBy;
  if (type !== undefined) {
    if (!VALID_TYPES.has(type as MailboxMessageType)) {
      throw validationError(`field "type" must be one of ${[...VALID_TYPES].join(', ')}`);
    }
    result.type = type as MailboxQuery['type'];
  }
  if (minPriority !== undefined) {
    if (!VALID_PRIORITIES.has(minPriority)) {
      throw validationError(
        `field "minPriority" must be one of ${[...VALID_PRIORITIES].join(', ')}`,
      );
    }
    result.minPriority = minPriority as MailboxQuery['minPriority'];
  }
  if (since !== undefined) result.since = since;
  if (limit !== undefined) result.limit = limit;
  if (incompleteOnly !== undefined) result.incompleteOnly = incompleteOnly;
  return result;
}

export function validateCheck(body: unknown, actorId?: string): MailboxCheckInput {
  if (typeof body !== 'object' || body === null) {
    throw validationError('expected JSON object body');
  }
  const object = body as Record<string, unknown>;
  if (actorId !== undefined) {
    rejectConflictingIdentity(object, 'agentId', actorId);
    rejectUnexpectedIdentity(object, 'baseId');
  }
  const result: MailboxCheckInput = { agentId: actorId ?? requireString(object, 'agentId') };
  const baseId = optionalString(object, 'baseId');
  const limit = optionalNumber(object, 'limit');
  const markRead = optionalBoolean(object, 'markRead');
  const completed = optionalBoolean(object, 'completed');
  const outcome = optionalString(object, 'outcome');
  if (baseId !== undefined) result.baseId = baseId;
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAILBOX_MAX_QUERY_LIMIT) {
      throw validationError(
        `field "limit" must be an integer between 1 and ${MAILBOX_MAX_QUERY_LIMIT} when present`,
      );
    }
    result.limit = limit;
  }
  if (markRead !== undefined) result.markRead = markRead;
  if (completed !== undefined) result.completed = completed;
  if (outcome !== undefined) result.outcome = outcome;
  return result;
}

export function validateAck(body: unknown, actorId?: string): MailboxAckInput {
  if (typeof body !== 'object' || body === null) {
    throw validationError('expected JSON object body');
  }
  const object = body as Record<string, unknown>;
  if (actorId !== undefined) rejectConflictingIdentity(object, 'readerId', actorId);
  const readerId = actorId ?? requireString(object, 'readerId');
  if (actorId === undefined) validateReaderId(readerId);
  const result: MailboxAckInput = {
    messageId: requireString(object, 'messageId'),
    readerId,
  };
  const read = optionalBoolean(object, 'read');
  const completed = optionalBoolean(object, 'completed');
  const outcome = optionalString(object, 'outcome');
  if (read !== undefined) result.read = read;
  if (completed !== undefined) result.completed = completed;
  if (outcome !== undefined) result.outcome = outcome;
  return result;
}

export function validateAckMany(body: unknown, actorId?: string): MailboxAckBatchInput {
  if (typeof body !== 'object' || body === null) {
    throw validationError('expected JSON object body');
  }
  const raw = (body as Record<string, unknown>)['acks'];
  if (!Array.isArray(raw)) throw validationError('field "acks" is required (array)');
  if (raw.length > MAILBOX_MAX_ACK_BATCH) {
    throw validationError(
      `field "acks" must contain at most ${MAILBOX_MAX_ACK_BATCH} entries (got ${raw.length})`,
    );
  }
  return { acks: raw.map((entry) => validateAck(entry, actorId)) };
}

export function validateAgentRegistration(
  body: unknown,
  actor?: MailboxActorContext,
): AgentRegistrationInput {
  if (typeof body !== 'object' || body === null) {
    throw validationError('expected JSON object body');
  }
  const object = body as Record<string, unknown>;
  if (actor !== undefined) {
    rejectConflictingIdentity(object, 'agentId', actor.actorId);
    rejectConflictingOptionalIdentity(object, 'sessionId', actor.sessionId);
    rejectConflictingOptionalIdentity(object, 'role', actor.role);
  }
  const agentId = actor?.actorId ?? requireString(object, 'agentId');
  if (actor === undefined) validateReaderId(agentId);
  const pid = requireNumber(object, 'pid');
  if (!Number.isInteger(pid) || pid < 1) {
    throw validationError('field "pid" must be a positive integer');
  }
  const result: AgentRegistrationInput = {
    agentId,
    sessionId: actor?.sessionId ?? 'external',
    name: requireString(object, 'name'),
    pid,
    source: 'http',
  };
  if (actor === undefined) {
    const sessionId = optionalString(object, 'sessionId');
    const role = optionalString(object, 'role');
    if (sessionId !== undefined) result.sessionId = sessionId;
    if (role !== undefined) result.role = role;
  } else if (actor.role !== undefined) {
    result.role = actor.role;
  }
  return result;
}

export function validateAgentHeartbeat(
  body: unknown,
  actor?: MailboxActorContext,
): AgentHeartbeatInput {
  if (typeof body !== 'object' || body === null) {
    throw validationError('expected JSON object body');
  }
  const object = body as Record<string, unknown>;
  if (actor !== undefined) {
    rejectConflictingIdentity(object, 'agentId', actor.actorId);
    rejectConflictingOptionalIdentity(object, 'sessionId', actor.sessionId);
    rejectConflictingOptionalIdentity(object, 'role', actor.role);
  }
  const agentId = actor?.actorId ?? requireString(object, 'agentId');
  // A heartbeat that rebuilds a pruned row is a registration in effect (the
  // store's recovery branch persists a fresh row from these fields), so it
  // inherits registration's reserved-id guard on exactly the paths where the
  // agentId is client-supplied: the actor-less mounts (HQ gateway,
  // bearer-token `mailbox serve`). Credentialed actors are exempt — their
  // agentId is credential-derived and rejectConflictingIdentity pins it.
  if (actor === undefined) validateReaderId(agentId);
  const result: AgentHeartbeatInput = { agentId };
  const status = optionalString(object, 'status');
  const currentTool = optionalString(object, 'currentTool');
  const currentTask = optionalString(object, 'currentTask');
  const iterations = optionalNumber(object, 'iterations');
  const toolCalls = optionalNumber(object, 'toolCalls');
  if (status !== undefined) result.status = status as AgentHeartbeatInput['status'];
  if (currentTool !== undefined) result.currentTool = currentTool;
  if (currentTask !== undefined) result.currentTask = currentTask;
  if (iterations !== undefined) {
    if (!Number.isInteger(iterations) || iterations < 0) {
      throw validationError('field "iterations" must be a non-negative integer when present');
    }
    result.iterations = iterations;
  }
  if (toolCalls !== undefined) {
    if (!Number.isInteger(toolCalls) || toolCalls < 0) {
      throw validationError('field "toolCalls" must be a non-negative integer when present');
    }
    result.toolCalls = toolCalls;
  }
  // Row-rebuilding identity (see AgentHeartbeatInput): mirrors
  // validateAgentRegistration's split. Identity (sessionId/role) is
  // credential-authoritative when an actor is present; display attributes
  // (name, pid) always come from the body; source is forced, never
  // client-supplied — an HTTP client must not be able to label itself 'cli'.
  const name = optionalString(object, 'name');
  const pid = optionalNumber(object, 'pid');
  if (name !== undefined) result.name = name;
  if (pid !== undefined) {
    if (!Number.isInteger(pid) || pid < 1) {
      throw validationError('field "pid" must be a positive integer when present');
    }
    result.pid = pid;
  }
  if (actor === undefined) {
    const sessionId = optionalString(object, 'sessionId');
    const role = optionalString(object, 'role');
    if (sessionId !== undefined) result.sessionId = sessionId;
    if (role !== undefined) result.role = role;
  } else {
    if (actor.sessionId !== undefined) result.sessionId = actor.sessionId;
    if (actor.role !== undefined) result.role = actor.role;
  }
  result.source = 'http';
  return result;
}

export function validateClientRegistration(body: unknown): ClientRegistrationInput {
  if (typeof body !== 'object' || body === null) {
    throw validationError('expected JSON object body');
  }
  const object = body as Record<string, unknown>;
  const pid = requireNumber(object, 'pid');
  if (!Number.isInteger(pid) || pid < 1) {
    throw validationError('field "pid" must be a positive integer');
  }
  return {
    clientId: requireString(object, 'clientId'),
    sessionId: optionalString(object, 'sessionId') ?? 'external',
    name: requireString(object, 'name'),
    source: 'http',
    pid,
  };
}

export function validateClientHeartbeat(body: unknown): ClientHeartbeatInput {
  if (typeof body !== 'object' || body === null) {
    throw validationError('expected JSON object body');
  }
  const object = body as Record<string, unknown>;
  const clientId = requireString(object, 'clientId');
  const sessionId = optionalString(object, 'sessionId');
  return sessionId ? { clientId, sessionId } : { clientId };
}
