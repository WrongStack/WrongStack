/**
 * kanban-dispatch-port — composition seam for the Director's kanban
 * dispatch and assignment operations (Roadmap #11).
 *
 * The coordination layer must not import `@wrongstack/kanban` at runtime;
 * it resolves the concrete operations through this port, wired at the
 * CLI composition root (see `setKanbanDispatch`). Type imports from
 * `@wrongstack/kanban` are erased at compile time and do not create a
 * runtime edge.
 */
import type {
  CompleteDispatchInput,
  CompleteDispatchResult,
  FailDispatchInput,
  HeartbeatKanbanTaskAssignmentInput,
  KanbanAgentAssignment,
  KanbanAgentRunStatus,
  KanbanBoard,
  KanbanEventContext,
  KanbanSearchInput,
  KanbanSearchResult,
  ReserveDispatchInput,
  ReserveDispatchResult,
  StartDispatchInput,
  StartDispatchResult,
} from '@wrongstack/kanban';

export interface KanbanDispatchPort {
  getBoard(projectRoot: string, boardId: string): Promise<KanbanBoard | null>;
  listReadyTasks(
    projectRoot: string,
    input?: KanbanSearchInput & { limit?: number | undefined },
  ): Promise<KanbanSearchResult[]>;
  reserveKanbanDispatch(
    projectRoot: string,
    input: ReserveDispatchInput,
  ): Promise<ReserveDispatchResult | null>;
  startKanbanDispatch(
    projectRoot: string,
    input: StartDispatchInput,
  ): Promise<StartDispatchResult | null>;
  completeKanbanDispatch(
    projectRoot: string,
    input: CompleteDispatchInput,
  ): Promise<CompleteDispatchResult | null>;
  failKanbanDispatch(projectRoot: string, input: FailDispatchInput): Promise<KanbanBoard | null>;
  updateTaskAssignment(
    projectRoot: string,
    boardId: string,
    taskId: string,
    patch: Partial<KanbanAgentAssignment> & { status?: KanbanAgentRunStatus | undefined },
    eventContext: KanbanEventContext,
  ): Promise<KanbanBoard | null>;
  heartbeatTaskAssignment(
    projectRoot: string,
    boardId: string,
    taskId: string,
    input: HeartbeatKanbanTaskAssignmentInput,
    eventContext: KanbanEventContext,
  ): Promise<KanbanBoard | null>;
}

const notWired = (): never => {
  throw new Error(
    'Kanban dispatch port is not wired — register the implementation at the CLI composition root (see setKanbanDispatch).',
  );
};

let port: KanbanDispatchPort | undefined;

/** Composition-root hook: register the real kanban-backed implementation. */
export function setKanbanDispatch(impl: KanbanDispatchPort): void {
  port = impl;
}

/** Runtime accessor used by director-tools; throws loudly when unwired. */
export function kanbanDispatch(): KanbanDispatchPort {
  if (!port) notWired();
  return port!;
}
