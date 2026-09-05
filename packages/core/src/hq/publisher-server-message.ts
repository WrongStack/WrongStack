import type { HqServerCommandBatchMessage, HqServerKanbanSnapshotMessage } from './protocol.js';
import { extractSocketMessageData } from './publisher-socket.js';

export function parseHqServerMessage(
  event: unknown,
  projectId: string,
): HqServerCommandBatchMessage | HqServerKanbanSnapshotMessage | null {
  const data = extractSocketMessageData(event);
  if (data === null) return null;
  try {
    const parsed = JSON.parse(data) as
      | Partial<HqServerCommandBatchMessage>
      | Partial<HqServerKanbanSnapshotMessage>;
    if (parsed.type === 'hq.command_batch' && Array.isArray(parsed.commands)) {
      return parsed as HqServerCommandBatchMessage;
    }
    if (parsed.type === 'hq.kanban_snapshot') {
      const payload = (parsed as Partial<HqServerKanbanSnapshotMessage>).payload;
      if (
        payload !== undefined &&
        typeof payload === 'object' &&
        typeof payload.projectId === 'string' &&
        payload.projectId === projectId &&
        Array.isArray(payload.boards) &&
        Array.isArray(payload.tombstones)
      ) {
        return parsed as HqServerKanbanSnapshotMessage;
      }
    }
    return null;
  } catch {
    return null;
  }
}
