import { randomUUID } from 'node:crypto';
import { requireSessionId } from '@wrongstack/primitives';
import { appendBoardHistory, appendKanbanEvent } from '../storage.js';
import type {
  KanbanAgentRunStatus,
  KanbanBoardHistoryEntry,
  KanbanEvent,
  KanbanTask,
} from '../types.js';
import { nowIso } from './basic-helpers.js';

export function createKanbanEvent(
  boardId: string,
  task: KanbanTask,
  type: string,
  details: Partial<Omit<KanbanEvent, 'id' | 'boardId' | 'taskId' | 'type' | 'ts' | 'sessionId'>> & {
    sessionId: string;
  },
): KanbanEvent {
  // Read defensively: the type makes `details` required, but an untyped caller
  // that omits it should hear the domain's own "session id is required", not a
  // TypeError about reading a property of undefined.
  const sessionId = requireSessionId(details?.sessionId, `kanban event ${type}`);
  return {
    id: randomUUID(),
    boardId,
    taskId: task.id,
    type,
    ts: nowIso(),
    // Assignment-derived attribution first, caller details second: an explicit
    // `actor` on the request describes who asked for this mutation and outranks
    // whoever the card happens to be assigned to.
    ...(task.assignment?.agentId !== undefined ? { actor: task.assignment.agentId } : {}),
    ...(task.assignment?.subagentId !== undefined
      ? { subagentId: task.assignment.subagentId }
      : {}),
    ...(task.assignment?.runTaskId !== undefined ? { runTaskId: task.assignment.runTaskId } : {}),
    ...(details ?? {}),
    sessionId,
  };
}

export async function emitKanbanEvent(projectRoot: string, event: KanbanEvent): Promise<void> {
  try {
    await appendKanbanEvent(projectRoot, event.boardId, event);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[kanban] emitKanbanEvent: failed to append event ${event.type} ` +
        `for board ${event.boardId}: ${msg}\n`,
    );
  }
}

export function createBoardHistoryEntry(
  boardId: string,
  boardTitle: string,
  type: string,
  details: Partial<
    Omit<KanbanBoardHistoryEntry, 'id' | 'boardId' | 'boardTitle' | 'type' | 'ts'>
  > = {},
): KanbanBoardHistoryEntry {
  return {
    id: randomUUID(),
    boardId,
    boardTitle,
    type,
    ts: nowIso(),
    ...details,
  };
}

export async function emitBoardHistoryEvent(
  projectRoot: string,
  entry: KanbanBoardHistoryEntry,
): Promise<void> {
  try {
    await appendBoardHistory(projectRoot, entry);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[kanban] emitBoardHistoryEvent: failed to append ${entry.type} ` +
        `for board ${entry.boardId}: ${msg}\n`,
    );
  }
}

export function assignmentEventType(status: KanbanAgentRunStatus): string {
  return status === 'completed'
    ? 'task.assignment.completed'
    : status === 'failed'
      ? 'task.assignment.failed'
      : status === 'running'
        ? 'task.assignment.running'
        : status === 'cancelled'
          ? 'task.assignment.cancelled'
          : 'task.assignment.updated';
}
