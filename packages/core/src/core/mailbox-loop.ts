/**
 * mailbox-loop — Agent-loop integration for mailbox checking.
 *
 * Integrates the inter-agent mailbox into the agent's iteration cycle.
 * Before each LLM call, checks for unread messages from subagents and other
 * agents. ALL message types are injected inline so the leader sees and acts
 * on them even when mid-task — subagent results, asks, assigns, and
 * steer/btw are all folded into the conversation with a call to action.
 *
 * Uses the project-level GlobalMailbox for cross-session communication.
 *
 * @module mailbox-loop
 */

import type { Mailbox, MailboxMessage } from '../coordination/mailbox-types.js';
import { toErrorMessage } from '../utils/error.js';

export interface MailboxLoopOptions {
  mailbox: Mailbox;
  /**
   * The agent's globally unique mailbox identity (e.g. `leader@a1b2c3d4`,
   * session-bound). Read receipts are recorded under this id, so two
   * sessions whose leaders share a base name never consume each other's
   * receipts. Pass a GETTER when the identity can change at runtime (an
   * in-process session swap moves the leader onto a new session tag).
   */
  agentId: string | (() => string);
  /**
   * Additional addresses this agent also answers to — typically the bare
   * base id (`leader`). Lets other agents (and humans) address "leader"
   * without knowing the session tag; every live leader session receives it.
   */
  aliases?: string[] | undefined;
  /** Optional delivery predicate applied before dedup/read receipts. */
  include?: ((message: MailboxMessage) => boolean) | undefined;
  /** Mark returned messages as read. Defaults to true for normal delivery. */
  ack?: boolean | undefined;
}

export function createMailboxChecker(
  opts: MailboxLoopOptions,
): () => Promise<MailboxMessage[]> {
  const { mailbox } = opts;
  const currentId = typeof opts.agentId === 'function' ? opts.agentId : () => opts.agentId as string;

  const injectedIds = new Set<string>();

  return async (): Promise<MailboxMessage[]> => {
    try {
      const agentId = currentId();
      const targets = [
        agentId,
        ...(opts.aliases ?? []).filter((al) => al && al !== agentId),
      ];
      // Query ALL unread messages across every address this agent answers
      // to (unique id, base-id aliases; '*' broadcasts match each query and
      // are deduped below). Receipts always use the unique id.
      const batches = await Promise.all(
        targets.map((to) =>
          mailbox.query({ to, unreadBy: agentId, limit: 10 }).catch(() => [] as MailboxMessage[]),
        ),
      );
      const seen = new Set<string>();
      const messages: MailboxMessage[] = [];
      for (const batch of batches) {
        for (const m of batch) {
          if (seen.has(m.id)) continue;
          if (opts.include && !opts.include(m)) continue;
          seen.add(m.id);
          messages.push(m);
        }
      }

      // Filter out already-injected and completed messages
      const fresh = messages.filter(
        (m) => !injectedIds.has(m.id) && !m.completed,
      );

      // Track as injected
      for (const m of fresh) {
        injectedIds.add(m.id);
      }

      // Auto-read all fresh messages (adds read receipt) in a single batched
      // call. The previous per-message ack() did a full read-modify-rewrite
      // of the mailbox file for every fresh message — N fresh messages
      // meant N full-file rewrites in a row on every iteration.
      if (fresh.length > 0 && opts.ack !== false) {
        void mailbox
          .ackMany({
            acks: fresh.map((m) => ({
              messageId: m.id,
              readerId: agentId,
              read: true,
            })),
          })
          .catch(() => {});
      }

      // GC
      if (injectedIds.size > 1000) {
        const recent = new Set([...injectedIds].slice(-500));
        injectedIds.clear();
        for (const id of recent) injectedIds.add(id);
      }

      return fresh;
    } catch {
      return [];
    }
  };
}

/**
 * Human-readable emoji prefix for each message type. Types not in this map
 * fall through to a generic `📨 <TYPE>` prefix so a newly-added MailboxMessageType
 * still renders sensibly without needing an immediate code change here.
 */
const TYPE_LABEL: Partial<Record<MailboxMessage['type'], string>> = {
  steer: '🔄 STEER',
  btw: '💬 BTW',
  ask: '❓ ASK',
  assign: '📋 ASSIGN',
  result: '✅ RESULT',
  review: '🔍 REVIEW',
};

export function buildMailboxBtwAwarenessBlock(messages: MailboxMessage[]): { type: 'text'; text: string } {
  if (messages.length === 0) throw new Error('buildMailboxBtwAwarenessBlock called with empty messages');

  const parts: string[] = [];
  parts.push('[MAILBOX BTW] Mailbox awareness update:');
  parts.push('');
  parts.push(
    'Disclaimer: an agent just sent mail to everyone or to you. Do not stop your current work to look at it; this is only for awareness. This notification came from the WrongStack mailbox system.',
  );
  parts.push('');

  for (const m of messages) {
    const typeLabel = TYPE_LABEL[m.type] ?? `📨 ${m.type.toUpperCase()}`;
    const scope = m.to === '*' ? 'broadcast to everyone' : `addressed to ${m.to}`;
    parts.push(`--- ${typeLabel} from ${m.from} (${scope}) ---`);
    parts.push(`Subject: ${m.subject}`);
    parts.push('');
    parts.push(m.body);
    parts.push('');
  }

  parts.push('[END MAILBOX BTW]');
  return { type: 'text', text: parts.join('\n') };
}

export function buildMailboxBlock(messages: MailboxMessage[]): { type: 'text'; text: string } {
  if (messages.length === 0) throw new Error('buildMailboxBlock called with empty messages');

  const parts: string[] = [];
  parts.push('[MAILBOX] New message(s) from other agents:');
  parts.push('');

  const hasActionable = messages.some(
    (m) =>
      m.type === 'ask' ||
      m.type === 'assign' ||
      m.type === 'result' ||
      m.type === 'review',
  );

  // Steer messages always come first — they are mid-task behavior changes
  // and the model must see them before any other action items, otherwise
  // it can finish an ask/assign/result before adjusting course. We do NOT
  // mutate `messages` itself (the caller still owns it for dedup) — we
  // build a local render order via a single-pass partition.
  const steers: MailboxMessage[] = [];
  const rest: MailboxMessage[] = [];
  for (const m of messages) {
    if (m.type === 'steer') steers.push(m);
    else rest.push(m);
  }
  const ordered = [...steers, ...rest];

  for (const m of ordered) {
    const typeLabel = TYPE_LABEL[m.type] ?? `📨 ${m.type.toUpperCase()}`;
    parts.push(`--- ${typeLabel} from ${m.from} ---`);
    parts.push(`Subject: ${m.subject}`);
    parts.push('');
    parts.push(m.body);
    parts.push('');
    if (m.type === 'steer') {
      parts.push('After your current operation reaches a stopping point, adjust your approach per the instruction above.');
      parts.push('');
    }
    if (m.type === 'ask') {
      parts.push('↳ This agent is waiting for your answer. Reply directly or use mailbox action=send to respond.');
      parts.push('');
    }
    if (m.type === 'assign') {
      parts.push('↳ This is a task assignment. Act on it when your current operation allows.');
      parts.push('');
    }
    if (m.type === 'result') {
      parts.push('↳ A subagent has completed its work. Factor this result into your next decision.');
      parts.push('');
    }
    if (m.type === 'btw') {
      parts.push('↳ FYI only — absorb the information and stay on your current task; no reply needed.');
      parts.push('');
    }
    if (m.type === 'status') {
      parts.push('↳ Peer status update — use it to avoid duplicate or conflicting work; no reply needed.');
      parts.push('');
    }
    if (m.type === 'review') {
      parts.push('↳ This is a review request. Inspect the referenced code/doc/PR when convenient; an immediate reply is not required.');
      parts.push('');
    }
  }

  if (hasActionable) {
    parts.push('Action required: address the items above. When done, use `mailbox action=ack messageId=<id> completed=true` to mark them complete.');
    parts.push('');
  }

  parts.push('[END MAILBOX]');
  return { type: 'text', text: parts.join('\n') };
}

// ── Integration hooks ────────────────────────────────────────────────────
// attachMailboxChecker (which constructs the concrete GlobalMailbox) lives
// in ../mailbox-attach.ts — the composition layer — so this file stays free
// of runtime coordination/ imports (architecture Rule 3).

/** Result of an inject pass — signals an out-of-band control request. */
export interface MailboxInjectResult {
  /** A fresh `control:interrupt` message asked this agent to stop. */
  interrupt: boolean;
  /** Operator-supplied reason for the interrupt, if any. */
  interruptReason?: string | undefined;
}

export async function injectPendingMailboxMessages(
  checkMailbox: () => Promise<MailboxMessage[]>,
  foldFn: (block: { type: 'text'; text: string }) => void,
  a: { events: { emit: (type: string, payload: unknown) => void }; logger: { debug?: (...args: unknown[]) => void } },
): Promise<MailboxInjectResult> {
  let messages: MailboxMessage[];
  try {
    messages = await checkMailbox();
  } catch {
    return { interrupt: false };
  }

  // Emit events for all found messages
  for (const m of messages) {
    a.events.emit('mailbox.received', {
      messageId: m.id, from: m.from, type: m.type, subject: m.subject,
    });
  }

  if (messages.length === 0) return { interrupt: false };

  // `control` messages are out-of-band signals (e.g. an operator interrupt
  // from Fleet HQ), NOT conversation content — keep them out of the folded
  // block so they never pollute the transcript. Everything else (results,
  // asks, assigns, notes, steer/btw) is injected inline so the leader sees
  // and acts on it even mid-task.
  const control = messages.filter((m) => m.type === 'control');
  const content = messages.filter((m) => m.type !== 'control');

  if (content.length > 0) {
    try { foldFn(buildMailboxBlock(content)); } catch (err) {
      (a.logger.debug ?? console.debug)?.(
        `mailbox: failed to fold messages: ${toErrorMessage(err)}`,
      );
    }
  }

  // An interrupt control message (subject/body naming a stop) asks the loop to
  // halt cooperatively at the next iteration boundary.
  const interruptMsg = control.find(
    (m) => /\b(interrupt|stop|halt|abort|cancel)\b/i.test(`${m.subject} ${m.body}`),
  );
  return interruptMsg
    ? { interrupt: true, interruptReason: interruptMsg.body || interruptMsg.subject || 'operator interrupt' }
    : { interrupt: false };
}
