import { stampAgentId } from '@wrongstack/core/storage';
import type { SessionWriter } from '@wrongstack/core/types';

/**
 * Session writer for a subagent that has no journal of its own: its events are
 * interleaved into the parent's JSONL.
 *
 * Pass `agentId` so those interleaved events carry attribution. Without it the
 * subagent's `tool_call_start`, `llm_response` and error records are byte-for-
 * byte indistinguishable from the leader's in the one file that holds both,
 * and every consumer that reads the leader transcript — resume timeline,
 * `/diag`, the HQ ledger, cost roll-ups — silently credits the leader for
 * work it did not do. It is optional only so existing callers that have not
 * resolved a name yet keep compiling; every real spawn site should pass one.
 *
 * Lifecycle and rewind *control* stay no-ops — `writeCheckpoint`,
 * `writeInFlightMarker`, `truncateToCheckpoint`, `clearSession` and `close`
 * belong to the parent, and a subagent driving them would corrupt the parent's
 * checkpoint chain and crash-recovery markers.
 *
 * Rewind *evidence* is a different thing and is forwarded. A subagent's file
 * mutations are real edits to the user's working tree, made under the parent
 * prompt that spawned it; dropping their `file_snapshot` records left `/rewind`
 * quietly unable to undo them, with nothing in the transcript saying so. The
 * parent writer files them against its own `activePromptIndex`, which is
 * exactly the prompt a user rewinding this work would target.
 */
export function createParentSubagentSessionWriter(
  parentSession: SessionWriter,
  agentId?: string,
): SessionWriter {
  const attribute = (event: Parameters<SessionWriter['append']>[0]) =>
    agentId ? stampAgentId({ ...event }, agentId) : { ...event };
  return {
    id: parentSession.id,
    transcriptPath: parentSession.transcriptPath,
    get pendingToolUses(): string[] {
      return [];
    },
    append: (event) => parentSession.append(attribute(event)),
    appendBatch: (events) => parentSession.appendBatch(events.map(attribute)),
    flush: () => parentSession.flush(),
    close: async () => {},
    recordFileChange: (input) => parentSession.recordFileChange(input),
    recordSideEffect: (input) => parentSession.recordSideEffect(input),
    writeCheckpoint: async () => {},
    writeFileSnapshot: async () => {},
    truncateToCheckpoint: async () => 0,
    clearSession: async () => {},
    writeInFlightMarker: async () => {},
    clearInFlightMarker: async () => {},
  };
}

/**
 * Wrap a subagent's own `SessionWriter` so its file mutations are ALSO recorded
 * against the parent session.
 *
 * When a subagent gets a real per-subagent JSONL, its `file_snapshot` events
 * land in that file — under the director run directory, which
 * `DefaultSessionRewinder` never reads: it resolves one path, the session being
 * rewound. So the richer, "proper" subagent-session path was the one that lost
 * rewind coverage entirely, while the fallback shim above at least had the
 * parent handle in reach.
 *
 * Recording to the parent as well keeps one authority for undo (the session the
 * user actually rewinds) without taking anything away from the subagent's own
 * transcript, which still receives every other event including the conversation
 * that produced the edit.
 */
export function withParentFileSnapshots(
  subagentSession: SessionWriter,
  parentSession: SessionWriter,
): SessionWriter {
  if (subagentSession === parentSession) return subagentSession;
  return new Proxy(subagentSession, {
    get(target, property, receiver) {
      if (property === 'recordFileChange') {
        return (input: Parameters<SessionWriter['recordFileChange']>[0]): void => {
          // The subagent journal keeps its own copy for transcript fidelity;
          // the parent's is the one `/rewind` reads.
          target.recordFileChange(input);
          parentSession.recordFileChange(input);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
