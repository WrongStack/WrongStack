/**
 * Actor-aware mailbox boundary codecs.
 *
 * They enforce:
 *   - Type + recipient normalization and semantic validation
 *   - Known-field rejection for mutations; forward-compatible tolerance for queries
 *   - Actor-override rejection (body-supplied `from`, `readerId`, `unreadBy`, …)
 *   - Capability checks, via the canonical implication graph
 *   - The shared request bounds from `mailbox-constants.ts`
 *
 * ## What actually uses these
 *
 * GM-P0.2 introduced this module as "the single canonical validator every
 * untrusted boundary MUST use". That is not what happened, and the docstring
 * claiming otherwise was actively dangerous — it invited new surfaces to wire
 * themselves here on the assumption that the path was battle-tested by the
 * HTTP bridge. Reality:
 *
 *   - `parseMailboxSendInput` — used by the `mail_send` tool
 *     (`mail-tools.ts`). This is the only codec here with a production caller.
 *   - `parseMailboxQueryInput` / `parseMailboxAckInput` — exported, no
 *     production caller.
 *   - `parseMailboxRegistrationInput` / `parseMailboxHeartbeatInput` — not
 *     exported from `coordination/index.ts`, no caller anywhere.
 *   - The HTTP bridge validates through `mailbox-http-validation.ts`; the
 *     WebUI WebSocket server through `ws-payload-validation.ts`.
 *
 * Unused validators rot in a way unused helpers do not: nothing exercises the
 * rule, so a gap survives review. Two were found here — a body-supplied
 * `unreadBy` that drove the store's leaders-only audience gate, and an
 * unbounded `limit` — both fixed below and both pinned by tests. Keep it that
 * way, or delete the codec: an unenforced boundary is worse than no boundary,
 * because it reads like one.
 *
 * @module mailbox-codecs
 */

import {
  assertCapability,
  MailboxValidationError,
  optionalBoolean,
  optionalNonNegInt,
  optionalString,
  rejectUnknownFields,
  requireString,
  validateAudience,
  validatePriority,
} from './mailbox-codec-validators.js';
import { MAILBOX_MAX_QUERY_LIMIT } from './mailbox-constants.js';
import { resolveSendTypeSafe } from './mailbox-message-codec.js';
import type { MailboxTaskContext } from './mailbox-message-types.js';
import type { MailboxActorContext } from './mailbox-types.js';
import {
  MAILBOX_TYPE_PROPERTIES,
  type MailboxAckInput,
  type MailboxAudience,
  type MailboxMessageType,
  type MailboxQuery,
  mailboxIdentityBase,
  normalizeRecipient,
} from './mailbox-types.js';

export { MailboxValidationError } from './mailbox-codec-validators.js';

// ── Allowed-field sets ───────────────────────────────────────────────

/** Fields allowed in a send mutation payload from untrusted callers. */
export const SEND_ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  'to',
  'subject',
  'body',
  'type',
  'priority',
  'audience',
  'replyTo',
  'senderSessionId',
  'ttlMs',
  'taskContext',
  // 'sessionAffinity' is NOT in the allow-list. The trust-line contract:
  // session-affinity tokens are stamped ONLY by trusted internal callers
  // (chimera/auto-review pipelines) that call `mailbox.send()` directly
  // and never go through this boundary codec. Allowing the field at the
  // boundary would let any actor with `mail.send.informational` stamp
  // another session's id and bypass the receiver-side filter. The
  // receiver trusts the sender-asserted `sessionId`; the boundary must
  // refuse the field entirely.
]);

/**
 * Send-payload fields whose presence is a trust violation, not clutter.
 *
 * `filterMailboxSendPayload` never strips these — it passes them through
 * so `parseMailboxSendInput` rejects them loudly at `rejectUnknownFields`
 * with `unknown field "…"`. Silently dropping them would convert a
 * forgery attempt into a successful, differently-scoped send:
 *   - `from` — sender identity; derived from MailboxActorContext, never
 *     the body
 *   - `sessionAffinity` — session-scoping token reserved for trusted
 *     internal callers (see the note in SEND_ALLOWED_FIELDS)
 */
const SEND_FORBIDDEN_FIELDS: ReadonlySet<string> = new Set<string>(['from', 'sessionAffinity']);

// ── Send payload filter ─────────────────────────────────────────────

/** Result of {@link filterMailboxSendPayload}. */
export interface FilteredSendPayload {
  /** Copy of the input containing only allow-listed and trust-relevant keys. */
  payload: Record<string, unknown>;
  /** Keys that were removed, in input order. Empty when nothing was stripped. */
  stripped: string[];
}

/**
 * Strip fields that do not belong in a send payload before it reaches the
 * boundary codec or the mailbox store.
 *
 * Senders (hosts, adapters, models) attach fields the mailbox never asked
 * for — debug knobs, client metadata, accidental whole-context dumps. Two
 * failure modes follow without a filter: the strict codec rejects the whole
 * send because of one irrelevant key, or a lenient surface persists the
 * clutter into every recipient's inbox. This function prevents both:
 * irrelevant keys are removed from the payload and reported in `stripped`.
 *
 * It is pure (never mutates the input) and keyed off the same
 * {@link SEND_ALLOWED_FIELDS} set that governs `parseMailboxSendInput`, so
 * the filter and the validator cannot drift apart.
 *
 * Trust-relevant fields (`from`, `sessionAffinity`, see
 * {@link SEND_FORBIDDEN_FIELDS}) are deliberately PASSED THROUGH, never
 * stripped: the codec must reject them loudly as unknown fields. Dropping
 * them here would convert a forgery attempt into a successful,
 * differently-scoped send.
 */
export function filterMailboxSendPayload(input: Record<string, unknown>): FilteredSendPayload {
  const payload: Record<string, unknown> = {};
  const stripped: string[] = [];
  for (const key of Object.keys(input)) {
    if (SEND_ALLOWED_FIELDS.has(key) || SEND_FORBIDDEN_FIELDS.has(key)) {
      payload[key] = input[key];
    } else {
      stripped.push(key);
    }
  }
  return { payload, stripped };
}

/** Fields allowed in an ack mutation payload. */
const ACK_ALLOWED_FIELDS = new Set<string>([
  'messageId',
  'read',
  'completed',
  'readerId',
  'outcome',
]);

/** Fields allowed in a presence-registration payload. */
const REGISTER_ALLOWED_FIELDS = new Set<string>([
  'agentId',
  'sessionId',
  'name',
  'role',
  'status',
  'currentTool',
  'currentTask',
  'iterations',
  'toolCalls',
  'source',
]);

/** Fields allowed in a heartbeat payload. */
const HEARTBEAT_ALLOWED_FIELDS = new Set<string>([
  'agentId',
  'sessionId',
  'status',
  'currentTool',
  'currentTask',
  'iterations',
  'toolCalls',
]);

// ── Send codec ───────────────────────────────────────────────────────

/**
 * Result of successful send-input parsing.
 * `type` is the resolved type after default selection and validation.
 */
export interface ParsedSendInput {
  to: string;
  type: MailboxMessageType;
  subject: string;
  body: string;
  priority: 'low' | 'normal' | 'high';
  audience: MailboxAudience;
  replyTo: string | undefined;
  ttlMs?: number | undefined;
  taskContext?: MailboxTaskContext | undefined;
  // No `sessionAffinity`: see SEND_ALLOWED_FIELDS. The token is stamped only
  // by trusted internal callers, never carried across this boundary.
}

/**
 * Parse and validate a send payload from an untrusted boundary.
 *
 * Actor fields (`from`, `senderSessionId`) are NOT accepted from the payload —
 * they are derived from the trusted {@link MailboxActorContext}.
 *
 * Unknown fields are rejected (mutations use strict validation).
 *
 * @throws {MailboxValidationError} on any validation failure.
 */
export function parseMailboxSendInput(
  payload: Record<string, unknown>,
  actor: MailboxActorContext,
): ParsedSendInput {
  // Reject unknown fields (strict mutation policy).
  rejectUnknownFields(payload, SEND_ALLOWED_FIELDS, 'send');

  // Required string fields.
  const rawTo = requireString(payload, 'to', 'send');
  const subject = requireString(payload, 'subject', 'send');
  const body = requireString(payload, 'body', 'send');

  // Normalize recipient using the actor's session id.
  const to = normalizeRecipient(rawTo, actor.sessionId);

  // Optional fields.
  const rawType = payload['type'];
  if (rawType !== undefined && typeof rawType !== 'string') {
    throw new MailboxValidationError('VALIDATION_ERROR', 'type', 'field "type" must be a string');
  }
  const rawPriority = payload['priority'];
  if (rawPriority !== undefined && typeof rawPriority !== 'string') {
    throw new MailboxValidationError(
      'VALIDATION_ERROR',
      'priority',
      'field "priority" must be a string',
    );
  }

  // Validate type + recipient semantic rules via the canonical resolver.
  const typeResult = resolveSendTypeSafe(rawType as MailboxMessageType | undefined, to);
  if (!typeResult.ok) {
    throw new MailboxValidationError('VALIDATION_ERROR', 'type', typeResult.error);
  }

  // Capability check: directive sends require mail.send.directive.
  if (typeResult.type === 'steer') {
    assertCapability(actor, 'mail.send.directive', 'send');
  } else if (
    typeResult.type === 'ask' ||
    typeResult.type === 'assign' ||
    typeResult.type === 'review'
  ) {
    assertCapability(actor, 'mail.send.actionable', 'send');
  } else {
    assertCapability(actor, 'mail.send.informational', 'send');
  }

  // Validate priority.
  const priority = validatePriority(rawPriority);

  // Validate audience.
  const audience = validateAudience(payload['audience']);

  // Validate replyTo.
  const replyTo = optionalString(payload, 'replyTo', 'send');

  // Validate optional ttlMs.
  const rawTtlMs = payload['ttlMs'];
  let ttlMs: number | undefined;
  if (rawTtlMs !== undefined && rawTtlMs !== null) {
    if (
      typeof rawTtlMs !== 'number' ||
      !Number.isFinite(rawTtlMs) ||
      !Number.isInteger(rawTtlMs) ||
      rawTtlMs < 1
    ) {
      throw new MailboxValidationError(
        'VALIDATION_ERROR',
        'ttlMs',
        'field "ttlMs" must be a positive integer',
      );
    }
    ttlMs = rawTtlMs;
  }

  // Validate optional taskContext.
  const rawTaskContext = payload['taskContext'];
  let taskContext: MailboxTaskContext | undefined;
  if (rawTaskContext !== undefined && rawTaskContext !== null) {
    if (typeof rawTaskContext !== 'object' || Array.isArray(rawTaskContext)) {
      throw new MailboxValidationError(
        'VALIDATION_ERROR',
        'taskContext',
        'field "taskContext" must be an object',
      );
    }
    const tc = rawTaskContext as Record<string, unknown>;
    const status = tc['status'];
    const validStatuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
    if (status !== undefined && (typeof status !== 'string' || !validStatuses.has(status))) {
      throw new MailboxValidationError(
        'VALIDATION_ERROR',
        'taskContext',
        'field "taskContext.status" is invalid',
      );
    }
    const agentRole = tc['agentRole'];
    if (agentRole !== undefined && typeof agentRole !== 'string') {
      throw new MailboxValidationError(
        'VALIDATION_ERROR',
        'taskContext',
        'field "taskContext.agentRole" must be a string',
      );
    }
    const agentName = tc['agentName'];
    if (agentName !== undefined && typeof agentName !== 'string') {
      throw new MailboxValidationError(
        'VALIDATION_ERROR',
        'taskContext',
        'field "taskContext.agentName" must be a string',
      );
    }
    const taskId = tc['taskId'];
    if (taskId !== undefined && typeof taskId !== 'string') {
      throw new MailboxValidationError(
        'VALIDATION_ERROR',
        'taskContext',
        'field "taskContext.taskId" must be a string',
      );
    }
    taskContext = {
      ...(typeof agentRole === 'string' ? { agentRole } : {}),
      ...(typeof agentName === 'string' ? { agentName } : {}),
      ...(typeof taskId === 'string' ? { taskId } : {}),
      ...(typeof status === 'string' ? { status: status as MailboxTaskContext['status'] } : {}),
    };
  }

  return {
    to,
    type: typeResult.type,
    subject,
    body,
    priority,
    audience,
    replyTo,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(taskContext !== undefined ? { taskContext } : {}),
  };
}

// ── Query codec ──────────────────────────────────────────────────────

/**
 * Parse and validate a query payload from an untrusted boundary.
 *
 * Queries tolerate unknown fields (forward compatibility for read-only clients).
 * Identity fields (`unreadBy`, `readerRole`) come from the actor, never the body.
 *
 * @throws {MailboxValidationError} on any validation failure.
 */
export function parseMailboxQueryInput(
  payload: Record<string, unknown>,
  actor: MailboxActorContext,
): MailboxQuery {
  assertCapability(actor, 'mail.read.self', 'query');

  const query: MailboxQuery = {};

  // All fields are optional; validate types when present.
  query.to = optionalString(payload, 'to', 'query');
  query.from = optionalString(payload, 'from', 'query');

  // `unreadBy` is an IDENTITY, not a filter, and it must come from the actor.
  //
  // The store's audience gate keys off `unreadBy`, not off `readerRole`:
  //
  //     if (!isMailboxLeader(query.unreadBy, query.readerRole)) {
  //       where.push("… audience <> 'leaders'");
  //     }
  //
  // and `isMailboxLeader` accepts any identity whose base segment is
  // `leader`. So a body-supplied `unreadBy: "leader@zzzz"` from a worker
  // credential holding nothing but `mail.read.self` made the store answer as
  // though a leader had asked — returning `audience: 'leaders'` mail, which
  // exists precisely to be invisible to that caller. Verified against the
  // store before the fix: the same actor saw one message with its own id and
  // two (including the leaders-only one) with a forged leader id.
  //
  // Passing another actor's id was also an enumeration primitive in its own
  // right — "what has agent X not read yet" is not the caller's business.
  //
  // Legacy operators keep the override: that principal is the bearer-token
  // admin path, which is already trusted to read on behalf of anyone.
  const bodyUnreadBy = optionalString(payload, 'unreadBy', 'query');
  if (actor.authMode === 'legacy-operator' && bodyUnreadBy) {
    query.unreadBy = bodyUnreadBy;
  } else if (bodyUnreadBy !== undefined && bodyUnreadBy !== actor.actorId) {
    throw new MailboxValidationError(
      'FORBIDDEN',
      'unreadBy',
      'field "unreadBy" may not name another actor',
    );
  } else if (bodyUnreadBy !== undefined) {
    query.unreadBy = actor.actorId;
  }

  // readerRole is NEVER trusted from the body — derive from actor.
  query.readerRole = actor.role ?? mailboxIdentityBase(actor.actorId);

  query.incompleteOnly = optionalBoolean(payload, 'incompleteOnly', 'query');

  const rawType = payload['type'];
  if (rawType !== undefined) {
    if (typeof rawType !== 'string' || !(rawType in MAILBOX_TYPE_PROPERTIES)) {
      throw new MailboxValidationError('VALIDATION_ERROR', 'type', `invalid type "${rawType}"`);
    }
    query.type = rawType as MailboxMessageType;
  }

  const rawMinPriority = payload['minPriority'];
  if (rawMinPriority !== undefined) {
    query.minPriority = validatePriority(rawMinPriority);
  }

  const rawLimit = payload['limit'];
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== 'number' ||
      !Number.isFinite(rawLimit) ||
      rawLimit < 0 ||
      rawLimit > MAILBOX_MAX_QUERY_LIMIT
    ) {
      throw new MailboxValidationError(
        'VALIDATION_ERROR',
        'limit',
        `field "limit" must be a number between 0 and ${MAILBOX_MAX_QUERY_LIMIT}`,
      );
    }
    query.limit = Math.floor(rawLimit);
  }

  query.since = optionalString(payload, 'since', 'query');
  query.until = optionalString(payload, 'until', 'query');
  query.sessionId = optionalString(payload, 'sessionId', 'query');
  query.includeDeleted = optionalBoolean(payload, 'includeDeleted', 'query');
  query.replyTo = optionalString(payload, 'replyTo', 'query');

  return query;
}

/**
 * Parse and validate an ack (mark-read / acknowledge / reopen) payload.
 *
 * `readerId` is NOT accepted from the body for identity-scoped principals —
 * it is derived from the actor. For legacy/admin principals it may be
 * accepted for backward compatibility.
 *
 * @throws {MailboxValidationError} on validation failure.
 */
export function parseMailboxAckInput(
  payload: Record<string, unknown>,
  actor: MailboxActorContext,
): MailboxAckInput & { readerId: string } {
  rejectUnknownFields(payload, ACK_ALLOWED_FIELDS, 'ack');

  assertCapability(actor, 'mail.ack.self', 'ack');

  const messageId = requireString(payload, 'messageId', 'ack');

  // Derive readerId from actor, not from the body.
  // Legacy/admin mode may accept body-supplied readerId.
  const bodyReaderId = optionalString(payload, 'readerId', 'ack');
  const readerId =
    actor.authMode === 'legacy-operator' && bodyReaderId ? bodyReaderId : actor.actorId;

  const read = optionalBoolean(payload, 'read', 'ack');
  const completed = optionalBoolean(payload, 'completed', 'ack');
  const outcome = optionalString(payload, 'outcome', 'ack');

  return {
    messageId,
    // Omit `read` when the caller did not state it, rather than defaulting it
    // to `false`. `MailboxAckInput.read` is documented as "defaults to true if
    // not specified", and the store implements exactly that (`ack.read !==
    // false`). Materializing `false` here inverted the contract: an ack sent
    // through this codec without an explicit `read` left the message unread,
    // while the same ack through `mailbox-http-validation.validateAck` — which
    // omits the field — marked it read. Two boundary codecs, one store, two
    // answers.
    ...(read !== undefined ? { read } : {}),
    ...(completed !== undefined ? { completed } : {}),
    readerId,
    outcome,
  };
}

// ── Registration codec ───────────────────────────────────────────────

/**
 * Parse and validate an agent-registration payload.
 *
 * `agentId` and `sessionId` are derived from the actor, not the body,
 * for identity-scoped principals. Legacy mode may accept body-supplied values.
 *
 * @throws {MailboxValidationError} on validation failure.
 */
export interface ParsedRegistrationInput {
  agentId: string;
  sessionId: string;
  name: string;
  role?: string | undefined;
  status: 'idle' | 'running' | 'streaming' | 'waiting_user' | 'error';
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  iterations: number;
  toolCalls: number;
  source?: 'cli' | 'webui' | 'mcp' | 'acp' | 'http' | undefined;
}

export function parseMailboxRegistrationInput(
  payload: Record<string, unknown>,
  actor: MailboxActorContext,
): ParsedRegistrationInput {
  rejectUnknownFields(payload, REGISTER_ALLOWED_FIELDS, 'register');

  assertCapability(actor, 'mail.presence.register.self', 'register');

  // Identity fields derived from actor for identity-scoped principals.
  const isLegacy = actor.authMode === 'legacy-operator';
  const bodyAgentId = optionalString(payload, 'agentId', 'register');
  const bodySessionId = optionalString(payload, 'sessionId', 'register');

  const agentId = isLegacy && bodyAgentId ? bodyAgentId : actor.actorId;
  const sessionId = isLegacy && bodySessionId ? bodySessionId : (actor.sessionId ?? '');

  if (!agentId) {
    throw new MailboxValidationError('VALIDATION_ERROR', 'agentId', 'agentId is required');
  }
  if (!sessionId) {
    throw new MailboxValidationError('VALIDATION_ERROR', 'sessionId', 'sessionId is required');
  }

  const name = requireString(payload, 'name', 'register');
  const role = optionalString(payload, 'role', 'register');

  const rawStatus = payload['status'];
  const validStatuses = ['idle', 'running', 'streaming', 'waiting_user', 'error'];
  const status =
    rawStatus !== undefined && typeof rawStatus === 'string' && validStatuses.includes(rawStatus)
      ? (rawStatus as ParsedRegistrationInput['status'])
      : 'idle';

  const currentTool = optionalString(payload, 'currentTool', 'register');
  const currentTask = optionalString(payload, 'currentTask', 'register');
  const iterations = optionalNonNegInt(payload, 'iterations', 'register') ?? 0;
  const toolCalls = optionalNonNegInt(payload, 'toolCalls', 'register') ?? 0;

  const rawSource = payload['source'];
  const validSources = ['cli', 'webui', 'mcp', 'acp', 'http'];
  const source =
    rawSource !== undefined && typeof rawSource === 'string' && validSources.includes(rawSource)
      ? (rawSource as ParsedRegistrationInput['source'])
      : undefined;

  return {
    agentId,
    sessionId,
    name,
    role,
    status,
    currentTool,
    currentTask,
    iterations,
    toolCalls,
    source,
  };
}

// ── Heartbeat codec ──────────────────────────────────────────────────

export interface ParsedHeartbeatInput {
  agentId: string;
  sessionId: string;
  status?: 'idle' | 'running' | 'streaming' | 'waiting_user' | 'error' | undefined;
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  iterations?: number | undefined;
  toolCalls?: number | undefined;
}

export function parseMailboxHeartbeatInput(
  payload: Record<string, unknown>,
  actor: MailboxActorContext,
): ParsedHeartbeatInput {
  rejectUnknownFields(payload, HEARTBEAT_ALLOWED_FIELDS, 'heartbeat');

  assertCapability(actor, 'mail.presence.heartbeat.self', 'heartbeat');

  const isLegacy = actor.authMode === 'legacy-operator';
  const bodyAgentId = optionalString(payload, 'agentId', 'heartbeat');
  const bodySessionId = optionalString(payload, 'sessionId', 'heartbeat');

  const agentId = isLegacy && bodyAgentId ? bodyAgentId : actor.actorId;
  const sessionId = isLegacy && bodySessionId ? bodySessionId : (actor.sessionId ?? '');

  if (!agentId) {
    throw new MailboxValidationError('VALIDATION_ERROR', 'agentId', 'agentId is required');
  }
  if (!sessionId) {
    throw new MailboxValidationError('VALIDATION_ERROR', 'sessionId', 'sessionId is required');
  }

  const rawStatus = payload['status'];
  const validStatuses = ['idle', 'running', 'streaming', 'waiting_user', 'error'];
  const status =
    rawStatus !== undefined && typeof rawStatus === 'string' && validStatuses.includes(rawStatus)
      ? (rawStatus as ParsedHeartbeatInput['status'])
      : undefined;

  const currentTool = optionalString(payload, 'currentTool', 'heartbeat');
  const currentTask = optionalString(payload, 'currentTask', 'heartbeat');
  const iterations = optionalNonNegInt(payload, 'iterations', 'heartbeat');
  const toolCalls = optionalNonNegInt(payload, 'toolCalls', 'heartbeat');

  return { agentId, sessionId, status, currentTool, currentTask, iterations, toolCalls };
}

/**
 * Resolve send type safely — delegates to the canonical resolver in
 * mailbox-message-codec.ts which handles default type selection,
 * recipient normalization, and cross-field validation.
 * Kept as a local alias for readability.
 */
