import type {
  CollabClient,
  CollabMessage,
  CollabPendingTool,
} from '@wrongstack/project-surfaces/collab/CollabPanel';
import type { EngineEvent } from './engine-state';

/** What the collaboration client needs of a conversation's journal reader. */
export interface CollabStream {
  listen(listener: (event: EngineEvent) => void): () => void;
  send(type: string, payload: Record<string, unknown>): Promise<void>;
}

/** Frames this long before the panel opened still count as live (journal stamping skew). */
const LIVE_SKEW_MS = 1000;

/**
 * The collaboration panel's connection to a desktop conversation. The journal reader also
 * replays the conversation's history, so only frames stamped after the panel opened reach it:
 * an old run's participants never show up as present. A message the engine refused reaches
 * the panel as a collaboration error.
 */
export function collabClient(stream: CollabStream, since = Date.now()): CollabClient {
  const from = since - LIVE_SKEW_MS;
  const errors = new Set<(message: CollabMessage) => void>();
  return {
    on(type, handler) {
      if (type === 'error') errors.add(handler);
      const off = stream.listen((event) => {
        if (event.type === type && (event.at ?? from) >= from)
          handler({ type, payload: event.payload });
      });
      return () => {
        errors.delete(handler);
        off();
      };
    },
    send(type, payload) {
      void stream.send(type, payload).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        for (const handler of errors)
          handler({ type: 'error', payload: { phase: 'collab', message } });
      });
    },
  };
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** Tool calls that started and have not finished yet, oldest first. */
export function pendingToolCalls(activity: readonly EngineEvent[]): CollabPendingTool[] {
  const pending = new Map<string, CollabPendingTool>();
  for (const event of activity) {
    const id = text(event.payload['id']);
    if (!id) continue;
    if (event.type === 'tool.started')
      pending.set(id, {
        toolUseId: id,
        toolName: text(event.payload['name']),
        toolInput: event.payload['input'],
      });
    else if (event.type === 'tool.executed') pending.delete(id);
  }
  return [...pending.values()];
}
