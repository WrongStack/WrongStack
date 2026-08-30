import {
  MAILBOX_MAX_ACK_BATCH,
  MAILBOX_MAX_QUERY_LIMIT,
  type MailboxAckInput,
  type MailboxEventEmitter,
  type MailboxMessageType,
  type MailboxQuery,
  normalizeRecipient,
  type RemoteMailbox,
} from '@wrongstack/core/coordination';
import {
  MCPServer,
  type MCPServerCallResult,
  type MCPServerTool,
  type MCPServerToolHost,
} from '@wrongstack/mcp';
import {
  type MailboxMcpAction,
  type MailboxMcpPolicyOptions,
  type MailboxMcpToolName,
  selectMailboxMcpTools,
} from './policy.js';
import { SERVER_INFO } from './version.js';

const WATCH_DEFAULT_TIMEOUT_MS = 15_000;
const WATCH_MAX_TIMEOUT_MS = 25_000;
const MESSAGE_TYPES = [
  'note',
  'ask',
  'assign',
  'steer',
  'btw',
  'broadcast',
  'status',
  'result',
  'review',
] as const satisfies readonly Exclude<MailboxMessageType, 'control'>[];
const MAILBOX_CAPABILITIES = [
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

export interface MailboxMcpToolHostOptions extends MailboxMcpPolicyOptions {
  actor: string;
  sessionId?: string | undefined;
  actorName?: string | undefined;
  actorRole?: string | undefined;
}

interface ResolvedMailboxIdentity {
  actor: string;
  sessionId: string;
  actorName: string;
  actorRole?: string | undefined;
}

const BASE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    to: { type: 'string' },
    from: { type: 'string' },
    type: { type: 'string', enum: [...MESSAGE_TYPES] },
    subject: { type: 'string' },
    body: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    audience: { type: 'string', enum: ['all', 'leaders'] },
    replyTo: { type: 'string' },
    messageId: { type: 'string' },
    messageIds: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAILBOX_MAX_ACK_BATCH,
    },
    read: { type: 'boolean' },
    completed: { type: 'boolean' },
    outcome: { type: 'string' },
    unreadBy: { type: 'string' },
    incompleteOnly: { type: 'boolean' },
    minPriority: { type: 'string', enum: ['low', 'normal', 'high'] },
    since: { type: 'string' },
    senderSessionId: { type: 'string' },
    // Advisory only — MCPServer does not validate inputSchema, it is a hint to
    // the model. The ceiling is ENFORCED in `boundedLimit()` below; keep the
    // two in agreement so the hint does not describe a request that is refused.
    limit: { type: 'number', minimum: 1, maximum: MAILBOX_MAX_QUERY_LIMIT },
    includeDeleted: { type: 'boolean' },
    ttlMs: { type: 'number', minimum: 1 },
    name: { type: 'string' },
    role: { type: 'string' },
    status: {
      type: 'string',
      enum: ['idle', 'running', 'streaming', 'waiting_user', 'error'],
    },
    currentTool: { type: 'string' },
    currentTask: { type: 'string' },
    iterations: { type: 'number', minimum: 0 },
    toolCalls: { type: 'number', minimum: 0 },
    completedMaxAgeMs: { type: 'number', minimum: 0 },
    incompleteMaxAgeMs: { type: 'number', minimum: 0 },
    readMaxAgeMs: { type: 'number', minimum: 0 },
    defaultTtlMs: { type: 'number', minimum: 0 },
    maxAgeMs: { type: 'number', minimum: 0 },
    credentialId: { type: 'string' },
    secret: { type: 'string' },
    reason: { type: 'string' },
    credentialOptions: {
      type: 'object',
      properties: {
        principalId: { type: 'string' },
        // Cannot be listed in a `required` array: this block is shared by
        // `credential_issue` and `credential_rotate`, and rotation inherits
        // projectId from the credential it supersedes. The hard check lives in
        // `credentialOptions()` below, gated on the `required` argument.
        projectId: {
          type: 'string',
          description:
            'Mandatory for credential_issue — a credential without it is created but can never authenticate over HTTP. Omit for credential_rotate: inherited from the rotated credential.',
        },
        kind: { type: 'string', enum: ['agent', 'operator', 'service'] },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: [...MAILBOX_CAPABILITIES] },
          uniqueItems: true,
        },
        ttlMs: { type: 'number', minimum: 1 },
        notBefore: { type: 'string', format: 'date-time' },
        supersedes: { type: 'string' },
        issuedBy: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const WATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    eventType: {
      type: 'string',
      enum: ['message.sent', 'message.acked', 'message.deleted', 'message.restored'],
    },
    timeoutMs: {
      type: 'number',
      minimum: 100,
      maximum: WATCH_MAX_TIMEOUT_MS,
    },
  },
  additionalProperties: false,
};

const TOOL_DESCRIPTIONS: Record<MailboxMcpToolName, string> = {
  mailbox_read:
    'Read the authoritative project Mailbox over IPC: query messages, count unread mail, inspect agents, clients, and daemon status.',
  mailbox_manage:
    'Send, acknowledge, soft-delete, restore, register, heartbeat, and deregister the configured external MCP actor. Requires --writable or --admin.',
  mailbox_admin:
    'Perform destructive maintenance and credential administration for the project Mailbox. Requires --admin.',
  mailbox_watch:
    'Wait for the next Mailbox mutation event. Reconcile messages with mailbox_read after every event, timeout, or disconnect.',
};

function actionSchema(actions: readonly MailboxMcpAction[]): Record<string, unknown> {
  const schema = structuredClone(BASE_SCHEMA);
  const properties = schema['properties'] as Record<string, unknown>;
  (properties['action'] as Record<string, unknown>)['enum'] = [...actions];
  return schema;
}

function toolDescriptor(
  name: MailboxMcpToolName,
  actions?: readonly MailboxMcpAction[],
): MCPServerTool {
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: actions ? actionSchema(actions) : WATCH_SCHEMA,
  };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function credentialOptions(
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
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('credentialOptions.ttlMs must be a positive number');
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

function queryFromArgs(args: Record<string, unknown>): MailboxQuery {
  return {
    ...(optionalString(args, 'to') !== undefined ? { to: optionalString(args, 'to') } : {}),
    ...(optionalString(args, 'from') !== undefined ? { from: optionalString(args, 'from') } : {}),
    ...(optionalString(args, 'unreadBy') !== undefined
      ? { unreadBy: optionalString(args, 'unreadBy') }
      : {}),
    ...(optionalBoolean(args, 'incompleteOnly') !== undefined
      ? { incompleteOnly: optionalBoolean(args, 'incompleteOnly') }
      : {}),
    ...(optionalString(args, 'type') !== undefined
      ? { type: optionalString(args, 'type') as MailboxMessageType }
      : {}),
    ...(optionalString(args, 'minPriority') !== undefined
      ? { minPriority: optionalString(args, 'minPriority') as 'low' | 'normal' | 'high' }
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

function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return WATCH_DEFAULT_TIMEOUT_MS;
  return Math.min(WATCH_MAX_TIMEOUT_MS, Math.max(100, Math.trunc(value)));
}

async function watchForMailboxEvent(
  emitter: MailboxEventEmitter,
  args: Record<string, unknown>,
): Promise<unknown> {
  const eventType = optionalString(args, 'eventType');
  const timeoutMs = normalizeTimeout(args['timeoutMs']);
  return await new Promise((resolve) => {
    let settled = false;
    let unsubscribe = (): void => {};
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const sub = emitter.subscribe((event) => {
      if (eventType && event.type !== eventType) return;
      finish({ changed: true, event });
    });
    unsubscribe = typeof sub === 'function' ? sub : () => {};
    if (settled) unsubscribe();
    timer = setTimeout(() => finish({ changed: false, timedOut: true, timeoutMs }), timeoutMs);
  });
}

async function executeRead(
  mailbox: RemoteMailbox,
  action: string,
  args: Record<string, unknown>,
  actor: string,
  sessionId: string,
): Promise<unknown> {
  switch (action) {
    case 'query':
      return { messages: await mailbox.query(queryFromArgs(args)) };
    case 'unread':
      return { unread: await mailbox.unreadCount(actor, sessionId) };
    case 'agents':
      return { agents: await mailbox.getAgentStatuses() };
    case 'online_agents':
      return { agents: await mailbox.getOnlineAgents() };
    case 'clients':
      return { clients: await mailbox.getClientStatuses() };
    case 'status':
      return { status: await mailbox.status() };
    default:
      throw new Error(`Unsupported mailbox read action: ${action}`);
  }
}

async function executeManage(
  mailbox: RemoteMailbox,
  action: string,
  args: Record<string, unknown>,
  identity: ResolvedMailboxIdentity,
): Promise<unknown> {
  switch (action) {
    case 'send': {
      const type = requiredString(args, 'type') as MailboxMessageType;
      if (type === 'control') throw new Error('Runtime control messages are not exposed over MCP');
      return {
        message: await mailbox.send({
          from: identity.actor,
          to: normalizeRecipient(requiredString(args, 'to'), identity.sessionId),
          type,
          subject: requiredString(args, 'subject'),
          body: requiredString(args, 'body'),
          senderSessionId: identity.sessionId,
          ...(optionalString(args, 'priority') !== undefined
            ? { priority: optionalString(args, 'priority') as 'low' | 'normal' | 'high' }
            : {}),
          ...(optionalString(args, 'audience') !== undefined
            ? { audience: optionalString(args, 'audience') as 'all' | 'leaders' }
            : {}),
          ...(optionalString(args, 'replyTo') !== undefined
            ? { replyTo: optionalString(args, 'replyTo') }
            : {}),
          ...(optionalNumber(args, 'ttlMs') !== undefined
            ? { ttlMs: optionalNumber(args, 'ttlMs') }
            : {}),
        }),
      };
    }
    case 'ack':
      return {
        message: await mailbox.ack({
          messageId: requiredString(args, 'messageId'),
          readerId: identity.actor,
          ...(optionalBoolean(args, 'read') !== undefined
            ? { read: optionalBoolean(args, 'read') }
            : {}),
          ...(optionalBoolean(args, 'completed') !== undefined
            ? { completed: optionalBoolean(args, 'completed') }
            : {}),
          ...(optionalString(args, 'outcome') !== undefined
            ? { outcome: optionalString(args, 'outcome') }
            : {}),
        }),
      };
    case 'ack_many': {
      const messageIds = args['messageIds'];
      if (!Array.isArray(messageIds) || messageIds.some((id) => typeof id !== 'string')) {
        throw new Error('messageIds must be an array of message ids');
      }
      // `ackMany` applies the whole batch inside one `BEGIN IMMEDIATE` with a
      // lookup per entry, so an unbounded array here holds the project's only
      // write lock long enough to fail every other surface on `busy_timeout`.
      // `maxItems` in the schema does not bound it — MCPServer does not
      // validate inputSchema — so the check has to live here. Reject rather
      // than truncate: silently acking a prefix of what was asked for would
      // leave the caller believing the rest was acknowledged.
      if (messageIds.length > MAILBOX_MAX_ACK_BATCH) {
        throw new Error(
          `messageIds must contain at most ${MAILBOX_MAX_ACK_BATCH} ids (got ${messageIds.length})`,
        );
      }
      const acks: MailboxAckInput[] = messageIds.map((messageId) => ({
        messageId,
        readerId: identity.actor,
        ...(optionalBoolean(args, 'read') !== undefined
          ? { read: optionalBoolean(args, 'read') }
          : {}),
        ...(optionalBoolean(args, 'completed') !== undefined
          ? { completed: optionalBoolean(args, 'completed') }
          : {}),
        ...(optionalString(args, 'outcome') !== undefined
          ? { outcome: optionalString(args, 'outcome') }
          : {}),
      }));
      return { messages: await mailbox.ackMany({ acks }) };
    }
    case 'soft_delete':
      return {
        message: await mailbox.softDelete(requiredString(args, 'messageId'), identity.actor),
      };
    case 'restore':
      return { message: await mailbox.restore(requiredString(args, 'messageId')) };
    case 'register_self':
      await mailbox.registerAgent({
        agentId: identity.actor,
        sessionId: identity.sessionId,
        name: optionalString(args, 'name')?.trim() || identity.actorName,
        ...((optionalString(args, 'role') ?? identity.actorRole)
          ? { role: optionalString(args, 'role') ?? identity.actorRole }
          : {}),
        pid: process.pid,
        source: 'mcp',
      });
      return { registered: true, agentId: identity.actor };
    case 'heartbeat_self':
      await mailbox.heartbeat({
        agentId: identity.actor,
        ...(optionalString(args, 'status') !== undefined
          ? {
              status: optionalString(args, 'status') as
                | 'idle'
                | 'running'
                | 'streaming'
                | 'waiting_user'
                | 'error',
            }
          : {}),
        ...(optionalString(args, 'currentTool') !== undefined
          ? { currentTool: optionalString(args, 'currentTool') }
          : {}),
        ...(optionalString(args, 'currentTask') !== undefined
          ? { currentTask: optionalString(args, 'currentTask') }
          : {}),
        ...(optionalNumber(args, 'iterations') !== undefined
          ? { iterations: optionalNumber(args, 'iterations') }
          : {}),
        ...(optionalNumber(args, 'toolCalls') !== undefined
          ? { toolCalls: optionalNumber(args, 'toolCalls') }
          : {}),
      });
      return { heartbeat: true, agentId: identity.actor };
    case 'deregister_self':
      await mailbox.deregisterAgent(identity.actor);
      return { deregistered: true, agentId: identity.actor };
    default:
      throw new Error(`Unsupported mailbox management action: ${action}`);
  }
}

async function executeAdmin(
  mailbox: RemoteMailbox,
  action: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<unknown> {
  switch (action) {
    case 'clear_all':
      await mailbox.clearAll();
      return { cleared: true };
    case 'purge_stale':
      return {
        result: await mailbox.purgeStale({
          ...(optionalNumber(args, 'completedMaxAgeMs') !== undefined
            ? { completedMaxAgeMs: optionalNumber(args, 'completedMaxAgeMs') }
            : {}),
          ...(optionalNumber(args, 'incompleteMaxAgeMs') !== undefined
            ? { incompleteMaxAgeMs: optionalNumber(args, 'incompleteMaxAgeMs') }
            : {}),
        }),
      };
    case 'auto_compact':
      return {
        result: await mailbox.autoCompact({
          ...(optionalNumber(args, 'readMaxAgeMs') !== undefined
            ? { readMaxAgeMs: optionalNumber(args, 'readMaxAgeMs') }
            : {}),
          ...(optionalNumber(args, 'defaultTtlMs') !== undefined
            ? { defaultTtlMs: optionalNumber(args, 'defaultTtlMs') }
            : {}),
        }),
      };
    case 'purge_agents':
      return { purged: await mailbox.purgeAgents(optionalNumber(args, 'maxAgeMs')) };
    case 'purge_clients':
      return { purged: await mailbox.purgeClients() };
    case 'credential_issue':
      return {
        result: await mailbox.credentialIssue(credentialOptions(args, true)!),
      };
    case 'credential_verify':
      return {
        result: await mailbox.credentialVerify(
          requiredString(args, 'credentialId'),
          requiredString(args, 'secret'),
        ),
      };
    case 'credential_revoke':
      return {
        revoked: await mailbox.credentialRevoke(
          requiredString(args, 'credentialId'),
          optionalString(args, 'reason'),
          actor,
        ),
      };
    case 'credential_rotate':
      return {
        result: await mailbox.credentialRotate(
          requiredString(args, 'credentialId'),
          credentialOptions(args, false),
        ),
      };
    case 'credential_get': {
      // WS-025: the owner already strips the authenticator at the IPC boundary —
      // `credentialGet` returns a RedactedMailboxCredential, so pass it through.
      const credential = await mailbox.credentialGet(requiredString(args, 'credentialId'));
      return { credential };
    }
    case 'credential_list':
      // WS-025: credentials arrive pre-redacted from the owner.
      return { credentials: await mailbox.credentialList() };
    case 'credential_status_counts':
      return { counts: await mailbox.credentialStatusCounts() };
    default:
      throw new Error(`Unsupported mailbox admin action: ${action}`);
  }
}

export function createMailboxMcpToolHost(
  mailbox: RemoteMailbox,
  emitter: MailboxEventEmitter,
  opts: MailboxMcpToolHostOptions,
): MCPServerToolHost {
  const actor = opts.actor.trim();
  if (!actor) throw new Error('Mailbox MCP requires a non-blank actor id');
  const identity = {
    actor,
    sessionId: opts.sessionId?.trim() || `mcp-${process.pid}`,
    actorName: opts.actorName?.trim() || actor,
    ...(opts.actorRole?.trim() ? { actorRole: opts.actorRole.trim() } : {}),
  };
  const policy = selectMailboxMcpTools(opts);
  const allowed = new Map(policy.map((entry) => [entry.name, entry.actions]));

  return {
    listTools(): MCPServerTool[] {
      return policy.map((entry) => toolDescriptor(entry.name, entry.actions));
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<MCPServerCallResult> {
      if (!allowed.has(name as MailboxMcpToolName)) {
        return {
          content: `Tool "${name}" is not exposed by this Mailbox MCP server`,
          isError: true,
        };
      }
      try {
        if (name === 'mailbox_watch') {
          return { content: await watchForMailboxEvent(emitter, args), isError: false };
        }
        const actions = allowed.get(name as MailboxMcpToolName);
        const action = args['action'];
        if (typeof action !== 'string' || !actions?.includes(action as MailboxMcpAction)) {
          throw new Error(`Action "${String(action)}" is not allowed through ${name}`);
        }
        const content =
          name === 'mailbox_read'
            ? await executeRead(mailbox, action, args, actor, identity.sessionId)
            : name === 'mailbox_manage'
              ? await executeManage(mailbox, action, args, identity)
              : await executeAdmin(mailbox, action, args, actor);
        return { content, isError: false };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

export function createMailboxMcpServer(
  mailbox: RemoteMailbox,
  emitter: MailboxEventEmitter,
  opts: MailboxMcpToolHostOptions,
): MCPServer {
  return new MCPServer({
    host: createMailboxMcpToolHost(mailbox, emitter, opts),
    serverInfo: { name: 'wrongstack-mailbox-mcp', version: SERVER_INFO.version },
    prompts: [
      {
        name: 'coordinate-via-mailbox',
        title: 'Coordinate through WrongStack Mailbox',
        description:
          'Register the external actor, inspect mail, communicate, and keep receipts current.',
        template:
          'Use the WrongStack Mailbox MCP tools. Register the configured actor, inspect unread and incomplete messages, reply with explicit recipients, acknowledge handled messages, heartbeat during long work, and reconcile after watch events.',
      },
    ],
  });
}
