import type { EventBus } from '@wrongstack/core/kernel';
import type { WSServerMessage } from '../types.js';
import type { CollabContext } from './collab-context.js';

/**
 * Live kernel-event mirror (6A-2). Subscribes to the events an observer
 * cares about and forwards each to all joined participants as a generic
 * `collab.event` envelope so the client can render a flowing activity
 * strip. Filtering / denormalization happens on the client.
 *
 * Moved verbatim from CollaborationWebSocketHandler.subscribe(); the
 * disposers are pushed into the caller-owned `offs` array so dispose()
 * removes every subscription.
 */
export function subscribeCollabMirror(
  ctx: CollabContext,
  events: EventBus,
  offs: Array<() => void>,
): void {
  // Same trick as WorktreeWebSocketHandler: bind a single typed-on helper
  // to a string-keyed signature so we can register many handlers.
  const on = events.on.bind(events) as never as (
    ev: string,
    fn: (p: unknown) => void,
  ) => () => void;

  const forwarded: Array<[string, string]> = [
    ['iteration.started', 'iteration.started'],
    ['iteration.completed', 'iteration.completed'],
    ['tool.started', 'tool.started'],
    ['tool.progress', 'tool.progress'],
    ['tool.executed', 'tool.executed'],
    ['tool.confirm_needed', 'tool.confirm_needed'],
    ['subagent.spawned', 'subagent.spawned'],
    ['subagent.task_started', 'subagent.task_started'],
    ['subagent.iteration_summary', 'subagent.iteration_summary'],
    ['subagent.task_completed', 'subagent.task_completed'],
    ['subagent.done', 'subagent.done'],
  ];
  for (const [kernelEvent, kind] of forwarded) {
    offs.push(
      on(kernelEvent, (raw) => {
        // Bail before the clone when nobody is watching. This list includes
        // `tool.progress` and `subagent.iteration_summary` — per-delta hot
        // paths — and the deep clone below used to run on every kernel event
        // even with zero observers connected, because the only no-op guard
        // lived inside broadcastEvent().
        if (!ctx.registry.hasAnyParticipants()) return;
        // Best-effort payload shape: we don't deeply validate, but we
        // make sure it's serializable. Observers must never receive
        // non-serializable objects (Functions, circular refs).
        let payload: unknown = raw;
        try {
          payload = JSON.parse(JSON.stringify(raw));
        } catch {
          // Skip unserializable payloads — better to drop than to crash
          // the broadcast loop.
          return;
        }
        broadcastEvent(ctx, kind, payload);
      }),
    );
  }
}

function broadcastEvent(ctx: CollabContext, kind: string, payload: unknown): void {
  if (!ctx.registry.hasAnyParticipants()) return; // nobody watching — no-op
  const msg: WSServerMessage = {
    type: 'collab.event',
    payload: { kind, payload, at: new Date().toISOString() },
  };
  const activeSessionId = ctx.options.getActiveSessionId?.();
  if (activeSessionId !== undefined) {
    ctx.broadcast(activeSessionId, msg);
    return;
  }
  for (const sessionId of ctx.registry.sessionIds()) {
    ctx.broadcast(sessionId, msg);
  }
}
