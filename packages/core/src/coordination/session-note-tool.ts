/**
 * `session_note` — same-session, in-process talk between the leader and
 * live agents. Not mailbox: nothing is persisted, other sessions never
 * see it, and `coordination.mail` is not required.
 *
 * One exception: a note to the session LEADER that finds no live inbox (the
 * leader finished its turn, or its loop is not running) falls back to durable
 * mail, so a worker's result is never silently dropped. Any other recipient
 * that is not live fails the call.
 *
 * @module session-note-tool
 */

import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { Tool } from '@wrongstack/contracts/types/tool';
import type { Context } from '../core/context.js';
import { resolveOwningSessionId } from '../core/context.js';
import type { SessionNoteKind } from '../core/session-notes.js';
import { ToolCapabilities } from '../security/capabilities.js';
import { type MailToolsOptions, makeMailSendTool } from './mail-tools.js';
import { mailboxIdentityBase } from './mailbox-types.js';
import { postSessionNote } from './session-note-hub.js';

const KINDS: readonly SessionNoteKind[] = ['note', 'result', 'ask', 'steer'];

function isKind(value: string): value is SessionNoteKind {
  return (KINDS as readonly string[]).includes(value);
}

/** Mailbox wiring for the leader fallback — same options as the mail tools. */
export type SessionNoteToolOptions = MailToolsOptions;

export function makeSessionNoteTool(opts: SessionNoteToolOptions = {}): Tool {
  // Reuse mail_send wholesale so the fallback inherits its codec, send policy
  // and owning-session affinity instead of re-implementing them.
  const mailSend = makeMailSendTool(opts);
  return {
    name: 'session_note',
    description:
      'Send an ephemeral note to the leader or another agent in THIS session. ' +
      'Delivered at their next iteration. Use it for same-session talk ' +
      '(findings, a short ask, a steer). Durable mail remains ' +
      'the durable cross-session channel. to="leader" reaches the session ' +
      'leader — if the leader is not live right now, the note is sent as durable mail ' +
      'to that leader instead; to="@session" fans out to every other live agent in the session; ' +
      'an exact agent id reaches one live peer (fails if it is not live — use mail_send). ' +
      'You never receive your own note.',
    usageHint: 'session_note to="leader" kind="result" body="file:line — what it is"',
    category: 'Coordination',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SESSION_NOTE],
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient: "leader", "@session", or a live agent id.',
        },
        body: { type: 'string', description: 'The note. Keep it compact.' },
        kind: {
          type: 'string',
          enum: [...KINDS],
          description: 'note (default), result, ask, or steer.',
        },
        subject: { type: 'string', description: 'Optional short subject (e.g. [explore]).' },
      },
      required: ['to', 'body'],
    },
    async execute(input: unknown, ctx: Context) {
      const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const to = typeof rec['to'] === 'string' ? rec['to'].trim() : '';
      const body = typeof rec['body'] === 'string' ? rec['body'] : '';
      const subject = typeof rec['subject'] === 'string' ? rec['subject'] : undefined;
      const kindRaw = typeof rec['kind'] === 'string' ? rec['kind'].trim().toLowerCase() : 'note';
      const kind: SessionNoteKind = isKind(kindRaw) ? kindRaw : 'note';
      if (!to || !body.trim()) {
        throw new ToolValidationError({ message: 'session_note: to and body are required.' });
      }
      const from =
        (typeof ctx.meta['globalAgentId'] === 'string' && ctx.meta['globalAgentId']) ||
        ctx.agentId ||
        mailboxIdentityBase(ctx.agentId);
      // The OWNING session, not the writer's: a worker handed its own journal
      // posts under a transcript the leader's inbox is not registered on, and
      // the note is dropped (`delivered: 0`) rather than mis-delivered.
      const { delivered } = postSessionNote({
        sessionId: resolveOwningSessionId(ctx),
        from,
        to,
        kind,
        body,
        subject,
      });
      if (delivered > 0) return { delivered, to, kind, channel: 'session' };

      const target = to.toLowerCase();
      if (target === '@session' || target === '*' || target === 'all') {
        // Nobody else is live in the session — a real "no audience" answer.
        return { delivered: 0, to, kind, channel: 'session' };
      }
      if (mailboxIdentityBase(target) !== 'leader') {
        throw new Error(
          `session_note: "${to}" is not a live agent in this session. Use mail_send for durable delivery.`,
        );
      }
      // The bare `leader` alias needs an owning-session stamp to be mailed
      // safely: without one, mail_send cannot scope it, and the mail would be
      // folded into EVERY leader on the project (other tabs, other sessions).
      // Fail closed — mis-delivery is worse than a visible failure.
      const owning = ctx.meta['sessionId'];
      if (target === 'leader' && (typeof owning !== 'string' || owning.length === 0)) {
        throw new Error(
          'session_note: the leader is not live in this session, and this agent has no ' +
            'owning-session stamp to address a mail fallback to the right leader.',
        );
      }
      let mail: { messageId?: unknown; to?: unknown };
      try {
        mail = (await mailSend.execute(
          { to, subject: subject ?? `[session_note] ${kind}`, body, type: kind },
          ctx,
        )) as { messageId?: unknown; to?: unknown };
      } catch (err) {
        throw new Error(
          `session_note: the leader is not live in this session and the mail fallback failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      return {
        delivered: 0,
        to,
        kind,
        channel: 'mail',
        messageId: mail.messageId,
        mailTo: mail.to,
      };
    },
  };
}
