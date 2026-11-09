import {
  MAILBOX_MAX_QUERY_LIMIT,
  MAILBOX_SENDABLE_MESSAGE_TYPES,
  type MailboxMessageType,
  type MailboxQuery,
  type RemoteMailbox,
} from '@wrongstack/coordination';

export const MAILBOX_CAPABILITIES = [
  'mail.send.informational',
  'mail.send.actionable',
  'mail.send.directive',
  'mail.read.self',
  'mail.read.all',
  'mail.ack.self',
  'mail.events.self',
  'mail.events.all',
  'mail.presence.register.self',
  'mail.presence.heartbeat.self',
  'mail.presence.deregister.self',
  'mail.presence.read',
  'mail.retention.purge',
  'mail.retention.clear',
  'mail.admin.receipts',
] as const;

export function requiredString(args: Record<string, unknown>, key: string, trim = true): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return trim ? value.trim() : value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

export function optionalNonNegativeInteger(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

export function optionalRetentionAge(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a finite non-negative number`);
  }
  return value;
}

/**
 * Enforce the shared read ceiling.
 *
 * `inputSchema` is NOT validated by MCPServer — it is a description handed to
 * the model, not a gate — so the `maximum` on `limit` bounded nothing at
 * runtime. A caller (or a model that ignores the hint) could ask for `1e9`,
 * and the store pre-limits in SQL: it would materialize every matching row,
 * each a `JSON.parse` plus a receipt fold. This is the surface built for
 * external agents, so it must bound its own inputs.
 *
 * Clamps rather than throws: a too-large `limit` is a request for "everything",
 * and answering with the maximum the system will serve is more useful to an
 * external agent than an error it has to learn to retry.
 */
function boundedLimit(args: Record<string, unknown>, key: string): number | undefined {
  const value = optionalNumber(args, key);
  if (value === undefined) return undefined;
  return Math.min(Math.max(1, Math.floor(value)), MAILBOX_MAX_QUERY_LIMIT);
}

/**
 * A string field restricted to the enum its schema advertises. Like `limit`,
 * the enum is only a hint to the model — MCPServer does not validate it — so
 * without this an out-of-contract value (`priority: "urgent"`, heartbeat
 * `status: "anything"`) was persisted into the project's shared mailbox, which
 * every other write boundary (HTTP bridge, WS validation, message codec)
 * refuses. Throws instead of coercing: silently rewriting the value would
 * report a send the caller did not ask for.
 */
export function optionalEnum<const T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

export const PRIORITIES = ['low', 'normal', 'high'] as const;
export const HEARTBEAT_STATUSES = [
  'idle',
  'running',
  'streaming',
  'waiting_user',
  'error',
] as const;
/**
 * The message types the MCP tools accept.
 *
 * Derived from the canonical mailbox vocabulary in `@wrongstack/coordination`
 * instead of a hand-maintained copy of the union: the copy silently drifted
 * whenever a type was added, so the MCP surface rejected types every other
 * surface accepted (and vice versa). `control` is runtime-reserved and is
 * excluded from the sendable set.
 */
export const MESSAGE_TYPES: readonly Exclude<MailboxMessageType, 'control'>[] =
  MAILBOX_SENDABLE_MESSAGE_TYPES;
export const WATCH_EVENT_TYPES = [
  'message.sent',
  'message.acked',
  'message.deleted',
  'message.restored',
] as const;

/**
 * `ttlMs` of a send, held to the schema's `minimum: 1`: zero or a negative TTL
 * stored a message that was already expired, and the send still reported
 * success.
 */
export function sendTtlMs(args: Record<string, unknown>): number | undefined {
  const value = args['ttlMs'];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error('ttlMs must be at least 1');
  }
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

export function credentialOptions(
  args: Record<string, unknown>,
  required: boolean,
): Parameters<RemoteMailbox['credentialIssue']>[0] | undefined {
  const raw = args['credentialOptions'];
  if (raw === undefined && !required) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('credentialOptions must be an object');
  }
  const options = raw as Record<string, unknown>;
  const allowed = new Set([
    'principalId',
    'projectId',
    'kind',
    'capabilities',
    'ttlMs',
    'notBefore',
    'supersedes',
    'issuedBy',
  ]);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unsupported credential option: ${unknown}`);

  const result: Record<string, unknown> = {};
  for (const key of ['principalId', 'projectId', 'supersedes', 'issuedBy'] as const) {
    const value = options[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`credentialOptions.${key} must be a non-blank string`);
      }
      result[key] = value.trim();
    }
  }
  // A credential without `projectId` is issued successfully but is permanently
  // unusable over HTTP: `credentialDecision` (core: mailbox-http-auth.ts:65)
  // returns `{allowed:false}` when `credential.projectId === undefined`, and it
  // surfaces as a generic 401 that never names the missing field. Fail here
  // instead, where the caller can still fix it.
  //
  // Gated on `required` (true only for `credential_issue`): rotation passes
  // `false` and legitimately omits the field, because core's rotation path
  // inherits it from the credential being superseded
  // (`projectId: old.projectId ?? options?.projectId`).
  if (required && result['projectId'] === undefined) {
    throw new Error('credentialOptions.projectId is required when issuing a credential');
  }
  const kind = options['kind'];
  if (kind !== undefined) {
    if (kind !== 'agent' && kind !== 'operator' && kind !== 'service') {
      throw new Error('credentialOptions.kind must be agent, operator, or service');
    }
    result['kind'] = kind;
  }
  const capabilities = options['capabilities'];
  if (capabilities !== undefined) {
    if (
      !Array.isArray(capabilities) ||
      capabilities.length === 0 ||
      capabilities.some(
        (capability) =>
          typeof capability !== 'string' ||
          !MAILBOX_CAPABILITIES.includes(capability as (typeof MAILBOX_CAPABILITIES)[number]),
      )
    ) {
      throw new Error('credentialOptions.capabilities contains an unsupported capability');
    }
    result['capabilities'] = [...new Set(capabilities)];
  }
  const ttlMs = options['ttlMs'];
  if (ttlMs !== undefined) {
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 1) {
      throw new Error('credentialOptions.ttlMs must be at least 1');
    }
    result['ttlMs'] = ttlMs;
  }
  const notBefore = options['notBefore'];
  if (notBefore !== undefined) {
    if (typeof notBefore !== 'string' || !Number.isFinite(Date.parse(notBefore))) {
      throw new Error('credentialOptions.notBefore must be an ISO date-time string');
    }
    result['notBefore'] = new Date(notBefore);
  }

  if (required) {
    for (const key of ['principalId', 'kind', 'capabilities', 'ttlMs'] as const) {
      if (result[key] === undefined) throw new Error(`credentialOptions.${key} is required`);
    }
  }
  return result as unknown as Parameters<RemoteMailbox['credentialIssue']>[0];
}

export function queryFromArgs(args: Record<string, unknown>): MailboxQuery {
  return {
    ...(optionalString(args, 'to') !== undefined ? { to: optionalString(args, 'to') } : {}),
    ...(optionalString(args, 'from') !== undefined ? { from: optionalString(args, 'from') } : {}),
    ...(optionalString(args, 'unreadBy') !== undefined
      ? { unreadBy: optionalString(args, 'unreadBy') }
      : {}),
    ...(optionalBoolean(args, 'incompleteOnly') !== undefined
      ? { incompleteOnly: optionalBoolean(args, 'incompleteOnly') }
      : {}),
    ...(optionalEnum(args, 'type', MESSAGE_TYPES) !== undefined
      ? { type: optionalEnum(args, 'type', MESSAGE_TYPES) }
      : {}),
    ...(optionalEnum(args, 'minPriority', PRIORITIES) !== undefined
      ? { minPriority: optionalEnum(args, 'minPriority', PRIORITIES) }
      : {}),
    ...(boundedLimit(args, 'limit') !== undefined ? { limit: boundedLimit(args, 'limit') } : {}),
    ...(optionalString(args, 'since') !== undefined
      ? { since: optionalString(args, 'since') }
      : {}),
    ...(optionalString(args, 'senderSessionId') !== undefined
      ? { sessionId: optionalString(args, 'senderSessionId') }
      : {}),
    ...(optionalBoolean(args, 'includeDeleted') !== undefined
      ? { includeDeleted: optionalBoolean(args, 'includeDeleted') }
      : {}),
    ...(optionalString(args, 'replyTo') !== undefined
      ? { replyTo: optionalString(args, 'replyTo') }
      : {}),
  };
}
