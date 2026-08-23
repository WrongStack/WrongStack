/**
 * Kanban board-store port for the storage area (goal coordination).
 *
 * `goal-kanban.ts` and `goal-coordination.ts` previously imported the
 * concrete functions from `@wrongstack/kanban` directly, keeping a
 * core → kanban runtime edge (the layering inversion catalogued as
 * roadmap #11 / report §2.1). This port is the leaf contract the storage
 * area codes against; the CLI composition root registers the real
 * implementation at boot (TOKENS-style dependency injection).
 *
 * Type-only imports of kanban's data shapes remain permitted — they erase
 * at compile time and do not create a runtime edge. Only *callable*
 * surface is ported.
 *
 * Un-registered default: goal features fail soft (board sync disabled)
 * exactly as before the extraction, so embedding contexts without kanban
 * keep working.
 */
import type {
  CreateKanbanBoardInput,
  CreateKanbanTaskInput,
  KanbanBoard,
  KanbanBoardSummary,
  KanbanEventContext,
  KanbanTask,
  UpdateKanbanTaskInput,
} from '@wrongstack/kanban';

export interface BoardStorePort {
  createBoard(projectRoot: string, input: CreateKanbanBoardInput): Promise<KanbanBoard>;
  listBoards(projectRoot: string): Promise<KanbanBoardSummary[]>;
  getBoard(projectRoot: string, boardId: string): Promise<KanbanBoard | null>;
  removeBoard(projectRoot: string, boardId: string): Promise<boolean>;
  addTask(
    projectRoot: string,
    boardId: string,
    input: CreateKanbanTaskInput,
    eventContext?: KanbanEventContext,
  ): Promise<{ board: KanbanBoard; task: KanbanTask } | null>;
  updateTask(
    projectRoot: string,
    boardId: string,
    taskId: string,
    input: UpdateKanbanTaskInput,
    eventContext?: KanbanEventContext,
  ): Promise<KanbanBoard | null>;
}

const notWired = (): never => {
  throw new Error(
    'Kanban BoardStorePort is not wired — register the implementation at the CLI composition root (see setBoardStorePort).',
  );
};

let port: BoardStorePort | undefined = undefined;

/** Composition-root hook: register the real kanban-backed implementation. */
export function setBoardStorePort(impl: BoardStorePort): void {
  port = impl;
}

/**
 * Resolve the board-store port. Callers that must fail soft should catch
 * the not-wired error, same semantics as kanban being absent.
 */
export function boardStore(): BoardStorePort {
  return port ?? notWired();
}

/**
 * Fail-soft resolver: the port when wired, otherwise `null`. For code paths
 * whose documented behavior when kanban is absent is a no-op or empty
 * result (goal sync, previews) — avoids the synchronous throw breaking
 * `.catch()` fail-soft chains in non-CLI embeddings.
 */
export function tryBoardStore(): BoardStorePort | null {
  return port ?? null;
}
