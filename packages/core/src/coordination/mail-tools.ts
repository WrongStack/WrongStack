/**
 * mail-tools — thin, high-affordance wrappers over the project mailbox.
 *
 * These are the PREFERRED mailbox tools for agents. The multi-action `mailbox`
 * tool is the low-level power surface for advanced queries and agent status;
 * `mail_send` and `mail_inbox` exist because explicit verbs ("send a mail",
 * "read my inbox") are what makes agents USE the mailbox autonomously — a model
 * reaches for `mail_send` mid-task far more readily than for
 * `mailbox action=send ...`.
 *
 *   mail_send  — message one agent (`to: "leader@a1b2c3d4"`), every leader
 *                (`to: "leader"`), this session (`to: "@session"`), or everyone (`to: "*"`)
 *   mail_inbox — read unread mail (unique id + base alias + session/project broadcasts),
 *                marking it read so it isn't re-injected next iteration
 *
 * Both share the identity convention with the agent-loop checker
 * (`<base>@<sessionTag>`, see mailbox-attach) via `resolveMailboxIdentity`.
 *
 * @module mail-tools
 */

import type { EventBus } from '../kernel/events.js';
import type { Context } from '../core/context.js';
import type { Tool } from '../types/tool.js';
import { ToolCapabilities } from '../security/capabilities.js';
import { getSharedProjectMailbox } from './remote-mailbox.js';
import { filterMailboxSendPayload, parseMailboxSendInput, type ParsedSendInput } from './mailbox-codecs.js';
import { isMailboxMessageVisibleTo, normalizeRecipient } from './mailbox-types.js';
import type {
  Mailbox,
  MailboxActorContext,
  MailboxCapability,
  MailboxMessage,
  MailboxMessageType,
} from './mailbox-types.js';
import { resolveSendType } from './mailbox-message-codec.js';
import {
  applyMailboxSendPolicy,
  defaultResolveProjectDir,
  resolveMailboxIdentity,
  type MailboxResolver,
} from './mailbox-tool.js';

export interface MailToolsOptions {
  /** How to obtain a Mailbox given the execution Context (tests). */
  resolveMailbox?: MailboxResolver | undefined;
  /** Project dir for the shared mailbox. Prefer wpaths.projectDir. */
  projectDir?: string | undefined;
  /** EventBus for mailbox.agent_registered / heartbeat surface events. */
  events?: EventBus | undefined;
}

/**
 * Scope an agent's mail to the conversation it belongs to when — and only
 * when — the recipient is the ambiguous `leader` alias.
 *
 * Four WebUI tabs are four live conversations in ONE process. Each registers a
 * leader, all four poll the same project mailbox, and a message carrying no
 * affinity token is accepted by every one of them
 * (`acceptMailboxMessageForSession` reads "no affinity" as "for everyone"), so
 * a worker reporting to "leader" folded its findings into three conversations
 * that never asked for them.
 *
 * Two deliberate narrowings. Only the ambiguous alias is scoped: a NAMED
 * recipient already identifies one agent, and `*` means what it says. And only
 * a sender carrying an explicit owning stamp is scoped: without one the best
 * available answer is the sender's own writer, which for a worker with its own
 * journal is a session no leader is on — stamping that would replace a
 * fan-out with silence. Same rule as the WebUI's `scopeToSenderSession`.
 */
function scopeAgentMailToOwningSession(
  ctx: Context,
  to: string,
  sessionId: string,
): { sessionAffinity: { sessionId: string } } | Record<string, never> {
  const owning = ctx.meta['sessionId'];
  if (typeof owning !== 'string' || owning.length === 0) return {};
  if (to.trim().toLowerCase() !== 'leader') return {};
  return { sessionAffinity: { sessionId } };
}

function makeResolver(opts: MailToolsOptions): MailboxResolver {
  return (
    opts.resolveMailbox ??
    ((ctx: Context) =>
      getSharedProjectMailbox(opts.projectDir ?? defaultResolveProjectDir(ctx), opts.events))
  );
}

async function register(mb: Mailbox, ctx: Context): Promise<ReturnType<typeof resolveMailboxIdentity>> {
  const identity = resolveMailboxIdentity(ctx);
  try {
    await mb.registerAgent({
      agentId: identity.callerId,
      sessionId: identity.sessionId,
      name: identity.name,
      role: identity.role,
      pid: process.pid,
      source: (ctx.meta['source'] as 'cli' | 'webui' | undefined) ?? 'cli',
    });
    await mb.heartbeat({ agentId: identity.callerId });
  } catch {
    /* best-effort */
  }
  return identity;
}

export function makeMailSendTool(opts: MailToolsOptions = {}) {
  const resolveMailbox = makeResolver(opts);
  return {
    name: 'mail_send',
    description:
      'Send mail to any agent on this canonical project, across clients, processes, sessions, ' +
      'branches, and linked Git worktrees (CLI, TUI, WebUI, ACP/MCP/HTTP). ' +
      'Use it to hand off work, ask questions, announce what you just did, or request a ' +
      'review. to="*" broadcasts to ' +
      'everyone; to="@session" reaches agents in your current session; to="leader" reaches every ' +
      'leader process; an exact id like "leader@a1b2c3d4" reaches one agent. Use project-wide ' +
      'scope (`*` or a base alias) whenever another session may be affected. Recipients see your ' +
      'mail automatically before their next step. ' +
      '\n\n' +
      '── TYPE SEMANTICS ──\n' +
      'The `type` parameter determines how the recipient must handle your message:\n' +
      '  actionable (requires a response):\n' +
      '    ask    — blocking question, sender waits for an answer\n' +
      '    assign — task delegation, act when current op allows (requires specific to, NOT "*")\n' +
      '    steer  — mid-task direction change, recipient adjusts course NOW\n' +
      '    review — passive ask, inspect when convenient, no reply needed\n' +
      '  informational (consume for context):\n' +
      '    note     — general FYI (default for directed sends)\n' +
      '    btw      — low-priority aside, absorb and stay on task\n' +
      '    result   — subagent completion notice, factor into next decision\n' +
      '    status   — agent/system status update, avoid redundant work\n' +
      '    broadcast — multi-recipient envelope (default when to="*" or "@session")\n' +
      '  control (reserved for runtime use — agents cannot send this type)\n' +
      '\n' +
      'When no `type` is provided: broadcast for `*`/`@session`, otherwise note.\n' +
      'assign/steer with to="*" is rejected (ambiguous). control is rejected (runtime-reserved).' +
      '\n\n' +
      'Type determines dispatch: steer renders first, control is out-of-band, ' +
      'actionable types show "Action required" footer. Set audience="leaders" for ' +
      'mail that subagents must not consume.',
    usageHint: 'mail_send to="<id>" type="review" body="please skim <file>"',
    category: 'Coordination',
    permission: 'auto',
    mutating: true,
    capabilities: [ToolCapabilities.COORDINATION_MAIL],
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient: exact agent id ("leader@a1b2c3d4"), base alias ("leader"), "@session" for your current session, or "*" / "all" for everyone.',
        },
        subject: { type: 'string', description: 'Short subject line.' },
        body: { type: 'string', description: 'The message.' },
        type: {
          type: 'string',
          enum: ['note', 'ask', 'assign', 'steer', 'btw', 'broadcast', 'status', 'result', 'review'],
          description:
            'Message intent. Default: "broadcast" when to="*", otherwise "note". ' +
            'Actionable types: ask (blocking question), assign (task), result (completion notice), ' +
            'review (passive ask — code/doc/PR review, no immediate reply required). ' +
            'Behavioral: steer (mid-task direction change), btw (low-priority aside). ' +
            'Informational: note/status/broadcast/control.',
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        audience: {
          type: 'string',
          enum: ['all', 'leaders'],
          description: 'Delivery audience. "leaders" hides the mail from subagent inboxes and agent-loop injection.',
        },
        replyTo: { type: 'string', description: 'Message id this replies to.' },
      },
      required: ['to', 'subject', 'body'],
    },
    async execute(input: unknown, ctx: Context) {
      // Clutter gate: hosts, adapters, and models attach fields the mailbox
      // never asked for (debug knobs, client metadata, accidental context
      // dumps). Strip them BEFORE validation so one irrelevant key cannot
      // fail an otherwise valid send, and so nothing outside
      // SEND_ALLOWED_FIELDS can structurally reach another agent's inbox.
      // Trust-relevant fields (`from`, `sessionAffinity`) survive the filter
      // on purpose — the codec below must reject them loudly.
      const { payload: i, stripped } = filterMailboxSendPayload(
        (input ?? {}) as Record<string, unknown>,
      );
      const rawTo = i.to as string | undefined;
      const subject = i.subject as string | undefined;
      const body = i.body as string | undefined;
      if (!rawTo || !subject || body === undefined || body === null) {
        return { ok: false, error: '"to", "subject" and "body" are required.' };
      }
      // GM-P0.8: Early validation through the shared boundary codec, fed the
      // pre-filtered payload. Rejects trust-relevant fields (from,
      // sessionAffinity) and malformed type/priority/audience before any I/O.
      const codecIdentity = resolveMailboxIdentity(ctx);
      const sendCapabilities: ReadonlySet<MailboxCapability> = new Set([
        'mail.send.directive',
        'mail.send.actionable',
        'mail.send.informational',
      ]);
      const codecActor: MailboxActorContext = {
        actorId: codecIdentity.callerId,
        projectId: ctx.projectRoot,
        kind: 'agent',
        role: codecIdentity.role,
        capabilities: sendCapabilities,
        authMode: 'runtime',
        recipientAliases: new Set([codecIdentity.baseId]),
        sessionId: codecIdentity.sessionId,
      };
      let parsed: ParsedSendInput;
      try {
        parsed = parseMailboxSendInput(i, codecActor);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const audience = parsed.audience;
      const mb = resolveMailbox(ctx);
      const identity = await register(mb, ctx);
      // Normalize after identity resolution because "@session" needs the
      // sender's full session id to produce a canonical recipient.
      const requestedTo = normalizeRecipient(rawTo, identity.sessionId);
      const delivery = applyMailboxSendPolicy(ctx, identity, requestedTo, audience);
      // Use the codec-validated envelope fields. Type re-derivation must use
      // the RAW input type, not the codec-resolved `parsed.type`: the codec
      // resolved defaults against the REQUESTED recipient, but the send
      // policy may retarget the recipient (chimera → leader). Re-resolving
      // the already-defaulted type froze `broadcast` (chosen for `*`) onto
      // the single retargeted recipient; re-deriving from the raw type lets
      // the canonical default follow the FINAL recipient (`note`). Explicit
      // types are unchanged by default logic and re-validate against the
      // final recipient here.
      const resolvedType = resolveSendType(
        i.type as MailboxMessageType | undefined,
        delivery.to,
      );
      const msg = await mb.send({
        from: identity.callerId,
        to: delivery.to,
        type: resolvedType,
        audience: delivery.audience,
        subject: parsed.subject,
        body: parsed.body,
        priority: parsed.priority,
        replyTo: parsed.replyTo,
        senderSessionId: identity.sessionId,
        ...scopeAgentMailToOwningSession(ctx, delivery.to, identity.sessionId),
      });
      return {
        ok: true,
        messageId: msg.id,
        from: identity.callerId,
        to: msg.to,
        // Surfacing what was stripped keeps the send auditable without
        // re-introducing the clutter into the payload itself.
        ...(stripped.length > 0
          ? { strippedFields: stripped, summary: `Mail sent to ${msg.to === '*' ? 'all agents' : msg.to} as ${identity.callerId}. Ignored ${stripped.length} unrecognized field(s): ${stripped.join(', ')}.` }
          : { summary: `Mail sent to ${msg.to === '*' ? 'all agents' : msg.to} as ${identity.callerId}.` }),
      };
    },
  } satisfies Tool;
}

export function makeMailInboxTool(opts: MailToolsOptions = {}) {
  const resolveMailbox = makeResolver(opts);
  return {
    name: 'mail_inbox',
    description:
      'Read your unread project-wide mail from agents in any client, session, branch, or linked ' +
      'Git worktree and mark it read. Covers mail ' +
      'addressed to you directly, to your base name (e.g. "leader"), to your current session, ' +
      'and project broadcasts ("*"). ' +
      'Fresh eligible mail is already injected for one model evaluation and then removed ' +
      'from raw conversation context — use this to catch up on ' +
      'notes, questions, handoffs, results, and review requests (type="review" — passive ' +
      'asks where no reply is required). Best called after a long stretch of tool work. ' +
      'Set completed=true to finish every returned message in the same call.',
    usageHint: 'mail_inbox  (optionally: limit=10, markRead=false to peek, completed=true outcome="handled")',
    category: 'Coordination',
    permission: 'auto',
    mutating: true,
    capabilities: [ToolCapabilities.COORDINATION_MAIL],
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default 20).' },
        markRead: {
          type: 'boolean',
          description: 'Add a read receipt for each returned message (default true).',
        },
        completed: {
          type: 'boolean',
          description: 'Also mark each returned message completed (default false).',
        },
        outcome: {
          type: 'string',
          description: 'Completion outcome to store when completed=true.',
        },
      },
    },
    async execute(input: unknown, ctx: Context) {
      const i = (input ?? {}) as Record<string, unknown>;
      const limit = (i.limit as number | undefined) ?? 20;
      const markRead = (i.markRead as boolean | undefined) ?? true;
      const completed = (i.completed as boolean | undefined) ?? false;
      const outcome = i.outcome as string | undefined;
      const mb = resolveMailbox(ctx);
      const identity = await register(mb, ctx);

      const targets = [identity.callerId];
      if (identity.baseId !== identity.callerId) targets.push(identity.baseId);
      targets.push(`@session:${identity.sessionId}`);
      const batches = await Promise.all(
        targets.map((to) =>
          mb
            .query({ to, unreadBy: identity.callerId, readerRole: identity.role, limit })
            .catch(() => [] as MailboxMessage[]),
        ),
      );
      const seen = new Set<string>();
      const messages = batches
        .flat()
        .filter((m) => {
          if (seen.has(m.id) || m.from === identity.callerId) return false;
          if (!isMailboxMessageVisibleTo(m, identity.callerId, identity.role)) return false;
          seen.add(m.id);
          return true;
        })
        .slice(0, limit);

      if (markRead || completed) {
        await mb
          .ackMany({
            acks: messages.map((m) => ({
              messageId: m.id,
              readerId: identity.callerId,
              read: markRead,
              completed,
              outcome: completed ? outcome : undefined,
            })),
          })
          .catch(() => null);
      }

      return {
        ok: true,
        you: identity.callerId,
        count: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          type: m.type,
          audience: m.audience ?? 'all',
          subject: m.subject,
          body: m.body.length > 2000 ? `${m.body.slice(0, 2000)}… [truncated]` : m.body,
          timestamp: m.timestamp,
          replyTo: m.replyTo,
        })),
        summary:
          messages.length === 0
            ? 'Inbox empty.'
            : `${messages.length} unread message(s)${markRead ? ' (marked read)' : ''}${completed ? ' (completed)' : ''}. Reply with mail_send using the sender id.`,
      };
    },
  } satisfies Tool;
}
