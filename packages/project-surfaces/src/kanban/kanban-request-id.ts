import { safeId } from '../lib/utils';

/**
 * Kanban replies that carry the task alone, with no board id. Their request is
 * stamped with a requestId the server echoes on the reply (`correlatedReply`),
 * so the store can tell which board the reply belongs to.
 *
 * Kept out of `kanban-store.ts` so a surface that mocks the store still sends.
 */
export const BARE_TASK_REPLY_TYPES: ReadonlySet<string> = new Set([
  'kanban.task.add',
  'kanban.task.update',
  'kanban.task.move',
  'kanban.task.assign',
  'kanban.task.get',
]);

/** `payload` with a fresh requestId when its reply will carry a bare task. */
export function withKanbanRequestId(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return BARE_TASK_REPLY_TYPES.has(type) &&
    typeof payload.boardId === 'string' &&
    payload.requestId === undefined
    ? { ...payload, requestId: `kanban_${safeId()}` }
    : payload;
}
