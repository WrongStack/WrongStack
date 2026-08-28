/**
 * `session_note` — same-session, in-process talk between the leader and
 * live agents. Not mailbox: nothing is persisted, other sessions never
 * see it, and `coordination.mail` is not required.
 *
 * @module session-note-tool
 */

import type { Context } from '../core/context.js';
import { resolveOwningSessionId } from '../core/context.js';
import type { SessionNoteKind } from '../core/session-notes.js';
import { ToolCapabilities } from '../security/capabilities.js';
import type { Tool } from '../types/tool.js';
import { mailboxIdentityBase } from './mailbox-types.js';
import { postSessionNote } from './session-note-hub.js';

const KINDS: readonly SessionNoteKind[] = ['note', 'result', 'ask', 'steer'];

function isKind(value: string): value is SessionNoteKind {
  return (KINDS as readonly string[]).includes(value);
}

export function makeSessionNoteTool(): Tool {
  return {
    name: 'session_note',
    description:
      'Send an ephemeral note to the leader or another agent in THIS session. ' +
      'Delivered at their next iteration. Use it for same-session talk ' +
      '(findings, a short ask, a steer). Durable mail remains ' +
      'the durable cross-session channel. to="leader" reaches the session ' +
      'leader; to="@session" fans out to every other live agent in the session; ' +
      'an exact agent id reaches one peer. You never receive your own note.',
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
        return { ok: false, delivered: 0, error: 'to and body are required' };
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
      return { ok: delivered > 0, delivered, to, kind };
    },
  };
}
