import { mutateBoard, readBoard } from '../storage.js';
import type { KanbanBoard, KanbanBoardPresence } from '../types.js';

export const DEFAULT_KANBAN_PRESENCE_TTL_MS = 2 * 60_000;

export interface TouchKanbanPresenceInput {
  sessionId: string;
  agentId: string;
  agentName?: string | undefined;
  taskId?: string | undefined;
  runTaskId?: string | undefined;
  seenAt?: string | undefined;
  ttlMs?: number | undefined;
}

function presenceId(input: Pick<TouchKanbanPresenceInput, 'sessionId' | 'agentId'>): string {
  return `${input.sessionId}:${input.agentId}`;
}

function normalizePresence(
  entries: readonly KanbanBoardPresence[] | undefined,
  now = new Date(),
): KanbanBoardPresence[] {
  const nowMs = now.getTime();
  return (entries ?? [])
    .map((entry) => ({ ...entry, active: Date.parse(entry.activeUntil) > nowMs }))
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
}

/** Return a board with live presence derived from its persisted expiry deadlines. */
export function withLiveKanbanPresence(board: KanbanBoard, now = new Date()): KanbanBoard {
  return { ...board, presence: normalizePresence(board.presence, now) };
}

/** Record that an agent/session is currently reading or mutating a board. */
export async function touchKanbanPresence(
  projectRoot: string,
  boardId: string,
  input: TouchKanbanPresenceInput,
): Promise<KanbanBoard | null> {
  if (!input.sessionId?.trim() || !input.agentId?.trim()) return readBoard(projectRoot, boardId);
  const seenAt = input.seenAt ?? new Date().toISOString();
  const seenMs = Date.parse(seenAt);
  const ttlMs = Math.max(1_000, Math.floor(input.ttlMs ?? DEFAULT_KANBAN_PRESENCE_TTL_MS));
  const activeUntil = new Date(
    (Number.isFinite(seenMs) ? seenMs : Date.now()) + ttlMs,
  ).toISOString();
  const id = presenceId(input);
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const current = board.presence?.find((entry) => entry.id === id);
    const entry: KanbanBoardPresence = {
      id,
      sessionId: input.sessionId,
      agentId: input.agentId,
      firstSeenAt: current?.firstSeenAt ?? seenAt,
      lastSeenAt: seenAt,
      activeUntil,
      active: true,
      ...((input.agentName ?? current?.agentName)
        ? { agentName: input.agentName ?? current?.agentName }
        : {}),
      ...((input.taskId ?? current?.taskId) ? { taskId: input.taskId ?? current?.taskId } : {}),
      ...((input.runTaskId ?? current?.runTaskId)
        ? { runTaskId: input.runTaskId ?? current?.runTaskId }
        : {}),
    };
    board.presence = [...(board.presence ?? []).filter((candidate) => candidate.id !== id), entry];
    return entry;
  });
  return updated ? withLiveKanbanPresence(updated.board, new Date(seenAt)) : null;
}

/** Read a board and derive active/inactive presence without persisting a write. */
export async function getBoardWithLivePresence(
  projectRoot: string,
  boardId: string,
  now = new Date(),
): Promise<KanbanBoard | null> {
  const board = await readBoard(projectRoot, boardId);
  return board ? withLiveKanbanPresence(board, now) : null;
}
