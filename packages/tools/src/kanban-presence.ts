import { touchKanbanPresence } from '@wrongstack/kanban';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';

interface KanbanPresenceContext {
  session?: { id?: string | undefined } | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
}

export function createKanbanPresenceWrapper(
  projectRoot: string,
  input: KanbanToolInput,
  ctx: KanbanPresenceContext,
) {
  return async (result: KanbanToolOutput): Promise<KanbanToolOutput> => {
    const boardId = result.board?.id ?? input.boardId;
    if (!result.ok || !boardId || !ctx.session?.id || !ctx.agentId) return result;
    try {
      const board = await touchKanbanPresence(projectRoot, boardId, {
        sessionId: ctx.session.id,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        taskId: input.taskId ?? result.task?.id,
        runTaskId: input.runTaskId,
      });
      return board ? { ...result, board } : result;
    } catch {
      return result;
    }
  };
}
