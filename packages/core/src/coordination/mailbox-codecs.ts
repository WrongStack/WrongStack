/**
 * Shared mailbox boundary codecs.
 *
 * GM-P0.2: These are the single canonical validators that every untrusted
 * boundary (tools, HTTP bridge, WebSocket server, HQ gateway, slash commands)
 * MUST use to parse and validate mailbox inputs. They enforce:
 *
 *   - Type + recipient normalization and semantic validation
 *   - Known-field rejection for mutations; forward-compatible tolerance for queries
 *   - Actor-override rejection (body-supplied `from`, `readerId`, etc.)
 *   - Capability checks for directive sends
 *
 * Downstream tasks (GM-P0.5A) will make `GlobalMailbox` itself call
 * `validateSendType()` internally so direct typed calls are also gated.
 *
 * @module mailbox-codecs
 */

import {
  MAILBOX_TYPE_PROPERTIES,
  mailboxIdentityBase,
  normalizeRecipient,
  sessionRecipient,
  validateSendType,
  type MailboxAudience,
  type MailboxMessageType,
  type MailboxQuery,
  type MailboxSendInput,
  type MailboxAckInput,
} from './mailbox-types.js';
import { resolveSendTypeSafe } from './mailbox-message-codec.js';
import type { MailboxActorContext, MailboxCapability } from './mailbox-types.js';

// ── Error class ──────────────────────────────────────────────────────

/**
 * Structured validation error from a boundary codec. Carries a stable
 * error code and field path so every surface produces the same shape.
 */
export class MailboxValidationError extends Error {
  readonly code: string;
  readonly field: string;
  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = 'MailboxValidationError';
    this.code = code;
    this.field = field;
  }
}

// ── Allowed-field sets ───────────────────────────────────────────────

/** Fields allowed in a send mutation payload from untrusted callers. */
const SEND_ALLOWED_FIELDS = new Set<string>([
  'to', 'subject', 'body', 'type', 'priority', 'audience', 'replyTo',
]);

/** Fields allowed in a query input from untrusted callers. */
const QUERY_ALLOWED_FIELDS = new Set<string>([
  'to', 'from', 'unreadBy', 'readerRole', 'incompleteOnly', 'type',
  'minPriority', 'limit', 'since', 'sessionId', 'includeDeleted', 'replyTo',
]);

/** Fields allowed in an ack mutation payload. */
const ACK_ALLOWED_FIELDS = new Set<string>([
  'messageId', 'read', 'completed', 'readerId', 'note', 'outcome', 'requestId',
]);

/** Fields allowed in a presence-registration payload. */
const REGISTER_ALLOWED_FIELDS = new Set<string>([
  'agentId', 'sessionId', 'name', 'role', 'status', 'currentTool',
  'currentTask', 'iterations', 'toolCalls', 'source',
]);

/** Fields allowed in a heartbeat payload. */
const HEARTBEAT_ALLOWED_FIELDS = new Set<string>([
  'agentId', 'sessionId', 'status', 'currentTool', 'currentTask',
  'iterations', 'toolCalls',
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
    throw new MailboxValidationError('VALIDATION_ERROR', 'priority', 'field "priority" must be a string');
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

  return { to, type: typeResult.type, subject, body, priority, audience, replyTo };
}

// ── Query codec ──────────────────────────────────────────────────────

/**
 * Parse and validate a query payload from an untrusted boundary.
 *
 * Queries tolerate unknown fields (forward compatibility for read-only clients).
 * Actor-derived recipient forms are NOT overridden by body-supplied `readerRole`.
 *
 * @throws {MailboxValidationError} on validation failure.
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
  query.unreadBy = optionalString(payload, 'unreadBy', 'query');

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
    if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 0) {
      throw new MailboxValidationError('VALIDATION_ERROR', 'limit', 'field "limit" must be a non-negative number');
    }
    query.limit = Math.floor(rawLimit);
  }

  query.since = optionalString(payload, 'since', 'query');
  query.sessionId = optionalString(payload, 'sessionId', 'query');
  query.includeDeleted = optionalBoolean(payload, 'includeDeleted', 'query');
  query.replyTo = optionalString(payload, 'replyTo', 'query');

  return query;
}

// ── Ack codec ────────────────────────────────────────────────────────

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
  const readerId = actor.authMode === 'legacy-operator' && bodyReaderId
    ? bodyReaderId
    : actor.actorId;

  const read = optionalBoolean(payload, 'read', 'ack');
  const completed = optionalBoolean(payload, 'completed', 'ack');
  const note = optionalString(payload, 'note', 'ack');
  const outcome = optionalString(payload, 'outcome', 'ack');
  const requestId = optionalString(payload, 'requestId', 'ack');

  return {
    messageId,
    read: read ?? false,
    completed: completed ?? false,
    readerId,
    note,
    outcome,
    requestId,
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
  const status = rawStatus !== undefined && typeof rawStatus === 'string' && validStatuses.includes(rawStatus)
    ? (rawStatus as ParsedRegistrationInput['status'])
    : 'idle';

  const currentTool = optionalString(payload, 'currentTool', 'register');
  const currentTask = optionalString(payload, 'currentTask', 'register');
  const iterations = optionalNonNegInt(payload, 'iterations', 'register') ?? 0;
  const toolCalls = optionalNonNegInt(payload, 'toolCalls', 'register') ?? 0;

  const rawSource = payload['source'];
  const validSources = ['cli', 'webui', 'mcp', 'acp', 'http'];
  const source = rawSource !== undefined && typeof rawSource === 'string' && validSources.includes(rawSource)
    ? (rawSource as ParsedRegistrationInput['source'])
    : undefined;

  return { agentId, sessionId, name, role, status, currentTool, currentTask, iterations, toolCalls, source };
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
  const status = rawStatus !== undefined && typeof rawStatus === 'string' && validStatuses.includes(rawStatus)
    ? (rawStatus as ParsedHeartbeatInput['status'])
    : undefined;

  const currentTool = optionalString(payload, 'currentTool', 'heartbeat');
  const currentTask = optionalString(payload, 'currentTask', 'heartbeat');
  const iterations = optionalNonNegInt(payload, 'iterations', 'heartbeat');
  const toolCalls = optionalNonNegInt(payload, 'toolCalls', 'heartbeat');

  return { agentId, sessionId, status, currentTool, currentTask, iterations, toolCalls };
}

// ── Internal helpers ─────────────────────────────────────────────────

/** Reject unknown fields on mutation inputs. */
function rejectUnknownFields(
  payload: Record<string, unknown>,
  allowed: Set<string>,
  op: string,
): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new MailboxValidationError(
        'VALIDATION_ERROR',
        key,
        `unknown field "${key}" in ${op} payload`,
      );
    }
  }
}

function requireString(
  payload: Record<string, unknown>,
  field: string,
  op: string,
): string {
  const val = payload[field];
  if (val === undefined || val === null) {
    throw new MailboxValidationError('VALIDATION_ERROR', field, `missing required field "${field}" in ${op}`);
  }
  if (typeof val !== 'string') {
    throw new MailboxValidationError('VALIDATION_ERROR', field, `field "${field}" must be a string`);
  }
  if (val.length === 0) {
    throw new MailboxValidationError('VALIDATION_ERROR', field, `field "${field}" must not be empty`);
  }
  return val;
}

function optionalString(
  payload: Record<string, unknown>,
  field: string,
  _op: string,
): string | undefined {
  const val = payload[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new MailboxValidationError('VALIDATION_ERROR', field, `field "${field}" must be a string`);
  }
  return val || undefined;
}

function optionalBoolean(
  payload: Record<string, unknown>,
  field: string,
  _op: string,
): boolean | undefined {
  const val = payload[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') {
    throw new MailboxValidationError('VALIDATION_ERROR', field, `field "${field}" must be a boolean`);
  }
  return val;
}

function optionalNonNegInt(
  payload: Record<string, unknown>,
  field: string,
  _op: string,
): number | undefined {
  const val = payload[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    throw new MailboxValidationError('VALIDATION_ERROR', field, `field "${field}" must be a non-negative number`);
  }
  return Math.floor(val);
}

function validatePriority(val: unknown): 'low' | 'normal' | 'high' {
  if (val === undefined || val === null) return 'normal';
  if (typeof val !== 'string') {
    throw new MailboxValidationError('VALIDATION_ERROR', 'priority', 'field "priority" must be a string');
  }
  if (val === 'low' || val === 'normal' || val === 'high') return val;
  throw new MailboxValidationError('VALIDATION_ERROR', 'priority', `invalid priority "${val}"`);
}

function validateAudience(val: unknown): MailboxAudience {
  if (val === undefined || val === null) return 'all';
  if (typeof val !== 'string') {
    throw new MailboxValidationError('VALIDATION_ERROR', 'audience', 'field "audience" must be a string');
  }
  if (val === 'all' || val === 'leaders') return val;
  throw new MailboxValidationError('VALIDATION_ERROR', 'audience', `invalid audience "${val}"`);
}

/**
 * Assert that the actor holds a capability. Uses implication rules:
 * if the actor holds a higher-tier capability that implies the required
 * one, the check passes.
 */
function assertCapability(
  actor: Pick<MailboxActorContext, 'capabilities'>,
  cap: MailboxCapability,
  op: string,
): void {
  const caps = actor.capabilities;
  if (caps.has(cap)) return;

  // Check if any held capability implies the required one.
  // Implication: mail.read.all => mail.read.self, etc.
  const implications: Record<string, readonly string[]> = {
    'mail.read.self': ['mail.read.all'],
    'mail.events.self': ['mail.events.all'],
    'mail.send.informational': ['mail.send.actionable', 'mail.send.directive'],
    'mail.send.actionable': ['mail.send.directive'],
  };
  const implies = implications[cap];
  if (implies) {
    for (const held of implies) {
      if (caps.has(held as MailboxCapability)) return;
    }
  }

  throw new MailboxValidationError(
    'FORBIDDEN',
    'capabilities',
    `actor lacks required capability "${cap}" for ${op}`,
  );
}

/**
 * Resolve send type safely — delegates to the canonical resolver in
 * mailbox-message-codec.ts which handles default type selection,
 * recipient normalization, and cross-field validation.
 * Kept as a local alias for readability.
 */
