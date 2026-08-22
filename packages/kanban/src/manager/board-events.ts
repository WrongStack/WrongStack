import { randomUUID } from 'node:crypto';
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
  details: Partial<Omit<KanbanEvent, 'id' | 'boardId' | 'taskId' | 'type' | 'ts'>> = {},
): KanbanEvent {
  return {
    id: randomUUID(),
    boardId,
    taskId: task.id,
    type,
    ts: nowIso(),
    ...(task.assignment?.agentId !== undefined ? { actor: task.assignment.agentId } : {}),
    ...(task.assignment?.subagentId !== undefined
      ? { subagentId: task.assignment.subagentId }
      : {}),
    ...(task.assignment?.runTaskId !== undefined ? { runTaskId: task.assignment.runTaskId } : {}),
    ...details,
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
