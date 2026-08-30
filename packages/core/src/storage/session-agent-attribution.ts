/**
 * Writer-boundary agent attribution.
 *
 * A leader's journal can contain events that a SUBAGENT produced. That is not
 * a bug: `createParentSubagentSessionWriter` deliberately forwards a
 * subagent's appends into the leader's JSONL when that subagent has no journal
 * of its own, because the leader's file is the one `/rewind` and the resume
 * timeline read. What WAS a bug is that the forwarded events arrived
 * unlabelled — a subagent's `tool_call_start` looked exactly like the
 * leader's, so no reader could attribute the work.
 *
 * Stamping belongs here rather than at the emit sites. Every producer
 * (director, fleet manager, tool loop, context) appends through a writer it
 * was handed and has no idea whether that writer is its own or a parent's;
 * the wrapper is the single place that does know. Doing it at the boundary
 * also means a new emit site cannot forget.
 *
 * The stamp is never overwritten: an event that already carries an `agentId`
 * came from a deeper agent whose own wrapper labelled it first, and that
 * inner attribution is the more specific truth.
 */
import type { SessionEvent, SessionWriter } from '../types/session.js';

/** Apply `agentId` to an event unless it already carries one. */
export function stampAgentId(event: SessionEvent, agentId: string): SessionEvent {
  if (event.agentId !== undefined) return event;
  return { ...event, agentId };
}

/**
 * Wrap a writer so every event appended through it is attributed to `agentId`.
 *
 * Only `append`/`appendBatch` are intercepted. `recordFileChange` and
 * `recordSideEffect` build their events inside the underlying writer, so a
 * wrapper cannot reach them — those paths keep the writer's own identity,
 * which for the parent-interleaved case is the correct owner anyway (the
 * parent files them against its own prompt index so `/rewind` can undo them).
 *
 * An empty `agentId` returns the writer untouched rather than stamping an
 * empty string, so a caller that has not resolved a name yet degrades to
 * today's behaviour instead of writing a meaningless label.
 */
export function withAgentAttribution(writer: SessionWriter, agentId: string): SessionWriter {
  const cleanId = agentId?.trim();
  if (!cleanId) return writer;
  return new Proxy(writer, {
    get(target, property, receiver) {
      if (property === 'append') {
        return (event: SessionEvent): Promise<void> => target.append(stampAgentId(event, cleanId));
      }
      if (property === 'appendBatch') {
        return (events: SessionEvent[]): Promise<void> =>
          target.appendBatch(events.map((event) => stampAgentId(event, cleanId)));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}
