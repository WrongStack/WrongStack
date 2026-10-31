/**
 * Live notes to a running external ACP worker.
 *
 * A WrongStack agent registers in the session note hub and folds notes in at
 * its next iteration. An external agent (Claude Code over ACP) has no such
 * loop, so while its turn runs this registers an inbox for it that injects
 * each note into the turn through the agent's steering extension. The leader
 * then reaches the worker with `session_note`, as it reaches its own workers.
 */
import type { AcpSteerOutcome } from '@wrongstack/acp';
import type { SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import { type SessionNoteHub, sessionNoteHub } from '@wrongstack/coordination';
import { toErrorMessage } from '@wrongstack/core/utils';

interface Note {
  from: string;
  kind: string;
  body: string;
  subject?: string | undefined;
}

/** The note as the worker reads it: who sent it, as what, then the text. */
export function steerMessage(note: Note): string {
  const head = `[WrongStack ${note.kind} from ${note.from}${note.subject ? ` — ${note.subject}` : ''}]`;
  return `${head}\n${note.body}`;
}

/**
 * Register `ctx.subagentId` (and its display name) as a live agent of the
 * delegating session for the length of the turn. Returns the unregister, or
 * undefined when no WrongStack session delegated the task.
 */
export function registerAcpSteerInbox(
  ctx: SubagentRunContext,
  _task: TaskSpec,
  steer: (text: string) => Promise<AcpSteerOutcome>,
  hub: Pick<SessionNoteHub, 'register'> = sessionNoteHub,
  onUndelivered: (outcome: string) => void = () => {},
): (() => void) | undefined {
  const sessionId = ctx.sessionId;
  if (!sessionId) return undefined;
  const name = ctx.config.name;
  return hub.register({
    sessionId,
    agentId: ctx.subagentId,
    ...(name && name !== ctx.subagentId ? { aliases: [name] } : {}),
    // A steer interrupts the worker's generation; peer chatter must not.
    ignorePeerBroadcasts: true,
    deliver: (note) => {
      steer(steerMessage(note)).then(
        (outcome) => {
          if (outcome !== 'injected') onUndelivered(outcome);
        },
        (err: unknown) => onUndelivered(toErrorMessage(err)),
      );
    },
  });
}
