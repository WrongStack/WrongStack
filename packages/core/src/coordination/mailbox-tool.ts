/**
 * mailbox-tool — Tool that exposes the inter-agent mailbox to agents.
 *
 * Sub-commands: check, send, ack, query, status, online, unread
 *
 * Uses the server-backed project mailbox for cross-session communication.
 * Agents are auto-registered on first use with heartbeat tracking.
 * Read receipts track who read each message and when.
 *
 * @module mailbox-tool
 */

import { createHash } from 'node:crypto';
import type { EventBus } from '../kernel/events.js';
import type { Context } from '../core/context.js';
import type { Tool } from '../types/tool.js';
import { ToolCapabilities } from '../security/capabilities.js';
import { toErrorMessage } from '../utils/error.js';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';
import { resolveProjectDir } from './global-mailbox-paths.js';
import { getSharedProjectMailbox } from './remote-mailbox.js';
import { resolveSendTypeSafe } from './mailbox-message-codec.js';
import {
  acceptMailboxMessageForSession,
  isMailboxMessageVisibleTo,
  normalizeRecipient,
  type Mailbox,
  type MailboxAudience,
  type MailboxMessage,
  type MailboxMessageType,
} from './mailbox-types.js';

export type MailboxResolver = (ctx: Context) => Mailbox;

export interface MailboxToolOptions {
  /**
   * How to obtain a Mailbox instance given the execution Context.
   * Default: derives the project dir and connects to its mailbox owner.
   */
  resolveMailbox?: MailboxResolver | undefined;
  /**
   * Agent id of the caller — used as default "from" on send.
   * Default: 'leader' for the main agent, or derived from ctx.meta.
   */
  agentId?: string | undefined;
  /** Session id for cross-session communication. Default: derived from ctx. */
  sessionId?: string | undefined;
  /**
   * Project directory where the mailbox is stored.
   * Default: derived from ctx.projectRoot (may differ from wpaths.projectDir).
   * For correct cross-session sharing, pass `wpaths.projectDir` from the caller.
   */
  projectDir?: string | undefined;
  /**
   * EventBus for emitting mailbox.agent_registered and mailbox.agent_heartbeat
   * events so the TUI/WebUI can update the online agent count in the status bar.
   * When omitted, events are not emitted and the status bar count stays at 0.
   */
  events?: EventBus | undefined;
}

export function defaultResolveProjectDir(ctx: Context): string {
  return resolveProjectDir(ctx.projectRoot, wstackGlobalRoot());
}

/**
 * Compact, deterministic tag for a session id — 8 hex chars of its sha256.
 * Session ids are date-sharded paths ("2026-06-11/sess_<ULID>");
 * the tag keeps mailbox identities short, filesystem-safe, and stable for
 * the lifetime of the session (including across process restarts/resumes).
 */
export function mailboxSessionTag(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

/**
 * Resolve the caller's mailbox identity from the execution Context.
 *
 * Shared by the `mailbox` power-tool, the thin `mail_send`/`mail_inbox`
 * tools, the agent-loop checker, and the /mailbox slash command so every
 * surface agrees on who is talking:
 * - base id: ctx.meta.agentId → ctx.agentId field (subagents) → fallback
 * - unique id: `<base>@<sessionTag>` — SESSION-bound, not pid-bound. Every
 *   session has its own id, so two leader sessions on the same project
 *   never collide (pids can be recycled by the OS), and a resumed session
 *   keeps its identity: read state survives a restart instead of
 *   re-flooding old broadcasts. Derived LIVE from ctx.session.id so an
 *   in-process session swap (resume / session.new / project switch) moves
 *   the identity with it. `ctx.meta.globalAgentId` remains an explicit
 *   override for hosts that manage identity themselves.
 */
export function resolveMailboxIdentity(
  ctx: Context,
  fallbackBase = 'leader',
): {
  baseId: string;
  callerId: string;
  name: string;
  role?: string | undefined;
  sessionId: string;
} {
  const fieldId = ctx.agentId && ctx.agentId !== 'unknown' ? ctx.agentId : undefined;
  const baseId = (ctx.meta['agentId'] as string | undefined) ?? fieldId ?? fallbackBase;
  const sessionId = (ctx.meta['sessionId'] as string | undefined) ?? ctx.session?.id ?? 'default';
  const callerId =
    (ctx.meta['globalAgentId'] as string | undefined) ??
    `${baseId}@${mailboxSessionTag(sessionId)}`;
  const fieldName = ctx.agentName && ctx.agentName !== 'Unknown Agent' ? ctx.agentName : undefined;
  const name = (ctx.meta['agentName'] as string | undefined) ?? fieldName ?? baseId;
  const role = ctx.meta['agentRole'] as string | undefined;
  return { baseId, callerId, name, role, sessionId };
}

/**
 * Apply sender-specific delivery restrictions before a message is persisted.
 * Chimera workers report only to main agents; enforcing that here keeps the
 * invariant intact even if a model requests a peer or project broadcast.
 */
export function applyMailboxSendPolicy(
  ctx: Context,
  identity: Pick<ReturnType<typeof resolveMailboxIdentity>, 'baseId' | 'name'>,
  requestedTo: string,
  requestedAudience?: MailboxAudience,
): { to: string; audience?: MailboxAudience } {
  const policy = ctx.meta['mailboxSendPolicy'];
  const isChimeraIdentity = (value: string) => {
    const normalized = value.trim().toLowerCase();
    return normalized === 'chimera' || normalized.startsWith('chimera-');
  };
  const chimeraSender = isChimeraIdentity(identity.baseId) || isChimeraIdentity(identity.name);
  if (policy === 'leaders-only' || chimeraSender) {
    return { to: 'leader', audience: 'leaders' };
  }
  return {
    to: requestedTo,
    ...(requestedAudience !== undefined ? { audience: requestedAudience } : {}),
  };
}

export function makeMailboxTool(opts: MailboxToolOptions = {}): Tool {
  const resolveMailbox =
    opts.resolveMailbox ??
    ((ctx: Context) => {
      const dir = opts.projectDir ?? defaultResolveProjectDir(ctx);
      return getSharedProjectMailbox(dir, opts.events);
    });
  const agentId = opts.agentId ?? 'leader';
  const sessionId = opts.sessionId ?? 'default';

  const shortHint =
    'Sub-commands: check (unread), send (exact/base/@session/project broadcast), ack (read/complete), query (filter), status (all agents), online (active only), unread (count).';

  return {
    name: 'mailbox',
    description:
      'Low-level inter-agent mailbox with 7 actions (check, send, ack, query, status, online, unread). ' +
      'For most use cases, prefer the simpler `mail_send` and `mail_inbox` tools — they cover the ' +
      'common send/read operations with a cleaner interface. This tool is for advanced queries ' +
      '(filter by sender, sender session, priority, since-timestamp), agent status/online lists, and message ack/control. ' +
      'Use to="@session" only for session-local coordination; use "*" or a base alias when another session may be affected.',
    usageHint: shortHint + ' For simple send/read, use mail_send / mail_inbox instead.',
    category: 'Coordination',
    permission: 'auto',
    mutating: true,
    capabilities: [ToolCapabilities.COORDINATION_MAIL],
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'send', 'ack', 'query', 'status', 'online', 'unread'],
          description: 'Which mailbox operation to perform.',
        },
        to: {
          type: 'string',
          description:
            "Recipient agent id, base alias, '@session' for the sender's session, or '*' / 'all' for project broadcast.",
        },
        type: {
          type: 'string',
          enum: [
            'note',
            'ask',
            'assign',
            'steer',
            'btw',
            'broadcast',
            'status',
            'result',
            'review',
            'control',
          ],
          description:
            'Required message intent. Actionable: ask (blocking question), assign (task delegation, must have specific to), steer (mid-course direction), review (passive ask). Informational: note (general FYI), btw (low-priority aside), result (completion notice), status (system update). Routing: broadcast (multi-recipient). Reserved: control (runtime only, agents cannot send).',
        },
        subject: { type: 'string', description: 'Short subject line.' },
        body: { type: 'string', description: 'Full message content.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        audience: {
          type: 'string',
          enum: ['all', 'leaders'],
          description: 'Delivery audience. "leaders" prevents subagent consumption.',
        },
        replyTo: { type: 'string', description: 'Reply to a specific message id.' },
        messageId: {
          type: 'string',
          description: "Message id to acknowledge. Required for 'ack'.",
        },
        read: { type: 'boolean', description: 'Mark as read (adds read receipt).' },
        markRead: {
          type: 'boolean',
          description: 'For action=check, add read receipts for returned messages (default true).',
        },
        completed: {
          type: 'boolean',
          description: 'Mark as completed. For action=check, completes every returned message.',
        },
        outcome: { type: 'string', description: 'Outcome summary when marking complete.' },
        unreadBy: {
          type: 'string',
          description: "Filter messages unread by this agent. Used by 'check'.",
        },
        incompleteOnly: { type: 'boolean', description: 'Only incomplete messages.' },
        from: { type: 'string', description: 'Filter by sender.' },
        minPriority: { type: 'string', enum: ['low', 'normal', 'high'] },
        since: { type: 'string', description: 'ISO8601 timestamp — only messages after this.' },
        sessionId: { type: 'string', description: 'Filter query results by sender session id.' },
        limit: { type: 'number', description: 'Max messages to return.' },
      },
      required: ['action'],
    },
    async execute(input: unknown, ctx: Context) {
      const mb = resolveMailbox(ctx);
      const i = (input ?? {}) as Record<string, unknown>;
      const action = i.action as string | undefined;
      // Prefer the process-unique identity set by attachMailboxChecker
      // (`leader#<pid>`) so registration/receipts/sends agree with the
      // agent-loop checker. The bare base id stays addressable as an alias.
      const identity = resolveMailboxIdentity(ctx, agentId);
      const baseCallerId = identity.baseId;
      const callerId = identity.callerId;
      const callerSessionId = (ctx.meta['sessionId'] as string) ?? ctx.session?.id ?? sessionId;

      // Auto-register this agent on first use (idempotent)
      try {
        await mb.registerAgent({
          agentId: callerId,
          sessionId: callerSessionId,
          name: identity.name,
          role: identity.role,
          pid: process.pid,
          source: (ctx.meta['source'] as 'cli' | 'webui' | undefined) ?? 'cli',
        });
      } catch {
        /* best-effort */
      }

      // Update heartbeat
      try {
        await mb.heartbeat({ agentId: callerId });
      } catch {
        /* best-effort */
      }

      switch (action) {
        case 'check':
          return executeCheck(mb, callerId, callerSessionId, [baseCallerId], identity.role, i);
        case 'send':
          return executeSend(mb, identity, callerSessionId, i, ctx);
        case 'ack':
          return executeAck(mb, callerId, i);
        case 'query':
          return executeQuery(mb, callerId, callerSessionId, identity.role, i);
        case 'status':
          return executeStatus(mb);
        case 'online':
          return executeOnline(mb);
        case 'unread':
          return executeUnread(mb, callerId, callerSessionId, [baseCallerId], identity.role);
        default:
          return {
            ok: false,
            error: `Unknown action: "${action}". Use check, send, ack, query, status, online, or unread.`,
          };
      }
    },
  };
}

// ── Action handlers ──────────────────────────────────────────────────────

async function executeCheck(
  mb: Mailbox,
  agentId: string,
  sessionId: string,
  aliases: string[],
  role: string | undefined,
  i: Record<string, unknown>,
) {
  const limit = (i.limit as number) ?? 20;
  const markRead = (i.markRead as boolean | undefined) ?? true;
  const completed = (i.completed as boolean | undefined) ?? false;
  const outcome = i.outcome as string | undefined;
  // Check unique id + base aliases + same-session broadcast. Project
  // broadcasts match every query and are deduped by message id below.
  const targets = [
    agentId,
    ...aliases.filter((al) => al && al !== agentId),
    `@session:${sessionId}`,
  ];
  const batches = await Promise.all(
    targets.map((to) =>
      mb
        .query({ to, unreadBy: agentId, readerRole: role, limit, minPriority: 'low' })
        .catch(() => []),
    ),
  );
  const seen = new Set<string>();
  const candidates = batches.flat().filter((m) => {
    if (seen.has(m.id)) return false;
    if (!isMailboxMessageVisibleTo(m, agentId, role)) return false;
    seen.add(m.id);
    return true;
  });
  // Session-affinity filter: every read path that touches cross-session
  // mail must wire the same filter. The agent-loop checker is not the only
  // read surface — `check` and `unread` are the default tool actions a
  // leader uses to read their mailbox, and they must reject messages whose
  // `sessionAffinity.sessionId` does not match the caller's current
  // session id. Mirrors the `query` action's pattern at line 400.
  const messages: typeof candidates = [];
  for (const m of candidates) {
    if (await acceptMailboxMessageForSession(m, sessionId)) {
      messages.push(m);
    }
  }

  // Auto-read: add read receipts for each message by default. Use the batch
  // path so catch-up checks perform one locked rewrite instead of N rewrites.
  // Return the post-ack snapshots so readByMe/completed reflect this call.
  const acked =
    markRead || completed
      ? await mb
          .ackMany({
            acks: messages.map((m) => ({
              messageId: m.id,
              readerId: agentId,
              read: markRead,
              completed,
              outcome: completed ? outcome : undefined,
            })),
          })
          .catch(() => messages)
      : messages;

  return {
    ok: true,
    count: acked.length,
    messages: acked.map((m) => formatMessage(m, agentId)),
    summary:
      acked.length === 0
        ? 'No unread messages.'
        : `${acked.length} unread message(s)${markRead ? ' (marked read)' : ''}${completed ? ' (completed)' : ''}.`,
  };
}

async function executeSend(
  mb: Mailbox,
  identity: ReturnType<typeof resolveMailboxIdentity>,
  sessionId: string,
  i: Record<string, unknown>,
  ctx: Context,
) {
  const to = i.to as string | undefined;
  const tp = i.type as string | undefined;
  const subject = i.subject as string | undefined;
  const body = i.body as string | undefined;
  const audience = i.audience as MailboxAudience | undefined;

  if (!to) return { ok: false, error: '"to" is required.' };
  if (!tp) return { ok: false, error: '"type" is required.' };
  if (!subject) return { ok: false, error: '"subject" is required.' };
  // Empty string is a legitimate body (e.g. subject-only status pings) —
  // only reject when the field is genuinely absent.
  if (body === undefined || body === null) return { ok: false, error: '"body" is required.' };
  if (audience !== undefined && audience !== 'all' && audience !== 'leaders') {
    return { ok: false, error: '"audience" must be "all" or "leaders".' };
  }

  // Resolve and validate the (type, to) pair using the canonical helper.
  // This enforces: control is reserved, assign/steer to "*" is rejected.
  let normalizedTo: string;
  try {
    normalizedTo = normalizeRecipient(to, sessionId);
  } catch (err) {
    return { ok: false, error: `"to" is invalid: ${toErrorMessage(err)}` };
  }
  const delivery = applyMailboxSendPolicy(ctx, identity, normalizedTo, audience);
  const typeResult = resolveSendTypeSafe(tp as MailboxMessageType, delivery.to);
  if (!typeResult.ok) return { ok: false, error: `"type" is invalid: ${typeResult.error}` };

  const msg = await mb.send({
    from: identity.callerId,
    to: delivery.to,
    type: typeResult.type,
    subject,
    body,
    audience: delivery.audience,
    priority: (i.priority as 'low' | 'normal' | 'high') ?? 'normal',
    replyTo: i.replyTo as string | undefined,
    senderSessionId: sessionId,
    // Same scoping rule as `mail_send`: with four tabs live, every one of them
    // has a leader on this mailbox and an unscoped "to: leader" is accepted by
    // all four. Only the ambiguous alias, and only from a sender that carries
    // an explicit owning stamp — see `scopeAgentMailToOwningSession`.
    ...(typeof ctx.meta['sessionId'] === 'string' &&
    (ctx.meta['sessionId'] as string).length > 0 &&
    delivery.to.trim().toLowerCase() === 'leader'
      ? { sessionAffinity: { sessionId } }
      : {}),
  });

  return {
    ok: true,
    messageId: msg.id,
    to: msg.to,
    type: msg.type,
    timestamp: msg.timestamp,
    summary: `Message sent to ${msg.to === '*' ? 'all agents' : msg.to}. Id: ${msg.id}`,
  };
}

async function executeAck(mb: Mailbox, agentId: string, i: Record<string, unknown>) {
  const messageId = i.messageId as string | undefined;
  if (!messageId) return { ok: false, error: '"messageId" is required.' };

  const updated = await mb.ack({
    messageId,
    readerId: agentId,
    read: i.read as boolean | undefined,
    completed: i.completed as boolean | undefined,
    outcome: i.outcome as string | undefined,
  });

  if (!updated) return { ok: false, error: `Message "${messageId}" not found.` };

  return {
    ok: true,
    messageId: updated.id,
    readBy: Object.keys(updated.readBy),
    readByCount: Object.keys(updated.readBy).length,
    completed: updated.completed,
    completedBy: updated.completedBy,
    outcome: updated.outcome,
    summary: `Message ${messageId} acknowledged. Read by ${Object.keys(updated.readBy).length} agent(s), Completed: ${updated.completed}.`,
  };
}

async function executeQuery(
  mb: Mailbox,
  agentId: string,
  sessionId: string,
  role: string | undefined,
  i: Record<string, unknown>,
) {
  const limit = (i.limit as number) ?? 50;
  const messages = await mb.query({
    to: i.to as string | undefined,
    from: i.from as string | undefined,
    unreadBy: i.unreadBy as string | undefined,
    incompleteOnly: i.incompleteOnly as boolean | undefined,
    type: i.type as MailboxMessageType | undefined,
    minPriority: i.minPriority as 'low' | 'normal' | 'high' | undefined,
    since: i.since as string | undefined,
    sessionId: i.sessionId as string | undefined,
    limit,
  });
  const visible: MailboxMessage[] = [];
  for (const message of messages) {
    if (
      isMailboxMessageVisibleTo(message, agentId, role) &&
      (await acceptMailboxMessageForSession(message, sessionId))
    ) {
      visible.push(message);
    }
  }
  return {
    ok: true,
    count: visible.length,
    messages: visible,
    summary: `${visible.length} message(s).`,
  };
}

async function executeStatus(mb: Mailbox) {
  const agents = await mb.getAgentStatuses();
  return {
    ok: true,
    count: agents.length,
    agents: agents.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      role: a.role,
      sessionId: a.sessionId,
      status: a.status,
      currentTool: a.currentTool,
      currentTask: a.currentTask,
      iterations: a.iterations,
      toolCalls: a.toolCalls,
      lastSeenAt: a.lastSeenAt,
      online: a.online,
      pid: a.pid,
      source: a.source,
    })),
    summary: `${agents.filter((a) => a.online).length} online, ${agents.length} total.`,
  };
}

async function executeOnline(mb: Mailbox) {
  const agents = await mb.getOnlineAgents();
  return {
    ok: true,
    count: agents.length,
    agents: agents.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      role: a.role,
      sessionId: a.sessionId,
      status: a.status,
      currentTool: a.currentTool,
      currentTask: a.currentTask,
      lastSeenAt: a.lastSeenAt,
      source: a.source,
    })),
    summary: `${agents.length} online agent(s).`,
  };
}

async function executeUnread(
  mb: Mailbox,
  agentId: string,
  sessionId: string,
  aliases: string[] = [],
  role?: string,
) {
  // Count unique id + base aliases + same-session broadcast; project
  // broadcasts match every query and are deduped by id.
  const targets = [
    agentId,
    ...aliases.filter((al) => al && al !== agentId),
    `@session:${sessionId}`,
  ];
  const batches = await Promise.all(
    targets.map((to) =>
      mb.query({ to, unreadBy: agentId, readerRole: role, limit: 200 }).catch(() => []),
    ),
  );
  // Session-affinity filter: every read path that touches cross-session
  // mail must wire the same filter — check (line 284) and query (line 412)
  // already do. Without it here, a chimera report stamped with another
  // session's affinity token counts toward this leader's unread total
  // even though acceptMailboxMessageForSession would reject it on read.
  const ids = new Set<string>();
  for (const m of batches.flat()) {
    if (!isMailboxMessageVisibleTo(m, agentId, role)) continue;
    if (await acceptMailboxMessageForSession(m, sessionId)) ids.add(m.id);
  }
  return { ok: true, count: ids.size, summary: `${ids.size} unread message(s) for you.` };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatMessage(m: MailboxMessage, readerId: string) {
  const maxBody = 2000;
  const truncated = m.body.length > maxBody ? `${m.body.slice(0, maxBody)}… [truncated]` : m.body;
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    type: m.type,
    audience: m.audience ?? 'all',
    subject: m.subject,
    body: truncated,
    priority: m.priority,
    readByMe: readerId in m.readBy,
    readByCount: Object.keys(m.readBy).length,
    readBy: m.readBy,
    completed: m.completed,
    completedBy: m.completedBy,
    outcome: m.outcome,
    timestamp: m.timestamp,
    replyTo: m.replyTo,
    senderSessionId: m.senderSessionId,
  };
}
