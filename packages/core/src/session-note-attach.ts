/**
 * Bind a running agent to the same-session note hub so peers can reach it
 * without mailbox. Unregisters via the agent hook on teardown.
 *
 * @module session-note-attach
 */

import { isMailboxLeader } from './coordination/mailbox-types.js';
import { sessionNoteHub } from './coordination/session-note-hub.js';
import type { AgentInternals } from './core/agent-internals.js';
import { resolveOwningSessionId } from './core/context.js';
import { enqueueSessionNote } from './core/session-notes.js';

export function attachSessionNotes(a: AgentInternals): void {
  // Every Agent runs through here at construction, and not every caller hands
  // over a fully-built Context: test doubles and the thin contexts some hosts
  // pass have no `agentId` and no `registerAgentHook`. `Context` itself
  // defaults the id to 'unknown', so mirror that rather than reading through
  // to `mailboxIdentityBase`, which splits the string and threw — taking the
  // whole `new Agent()` down with it.
  const agentId = typeof a.ctx.agentId === 'string' && a.ctx.agentId ? a.ctx.agentId : 'unknown';
  const aliases: string[] = [];
  if (agentId === 'leader' || isMailboxLeader(agentId)) aliases.push('leader');
  const off = sessionNoteHub.register({
    sessionId: () => {
      try {
        // Owning session, matching the poster (`session_note`): a worker with
        // its own journal must be reachable on the conversation that spawned
        // it, not on its private transcript — otherwise `@session` fan-out and
        // leader→worker steers miss every worker the moment `sessionsRoot` is
        // configured.
        return resolveOwningSessionId(a.ctx);
      } catch {
        return undefined;
      }
    },
    agentId,
    aliases,
    deliver: (note) => {
      enqueueSessionNote(a.ctx, note);
    },
    events: a.events,
  });
  if (typeof a.ctx.registerAgentHook !== 'function') {
    // Nothing will ever unregister this inbox, so do not register it at all —
    // a leaked inbox on a dead context would keep receiving its session's
    // notes forever.
    off();
    return;
  }
  a.ctx.registerAgentHook(() => {
    off();
  });
}
