/**
 * Kanban governance-evaluation port for the security area.
 *
 * `kanban-boundary.ts` previously imported the boundary evaluation and
 * board-read functions directly from `@wrongstack/kanban`, keeping a
 * core → kanban runtime edge (roadmap #11 / report §2.1). This port is
 * the leaf contract; the CLI composition root registers the real
 * implementation at boot alongside the storage and coordination ports.
 *
 * Type-only imports of kanban's data shapes remain permitted — they erase
 * at compile time and do not create a runtime edge.
 */
import type {
  KanbanBoundaryAccess,
  KanbanBoundaryEvaluation,
  KanbanBoundaryLayer,
  KanbanBoard,
  KanbanContractReadinessIssue,
  KanbanTask,
} from '@wrongstack/kanban';

export interface KanbanGovernancePort {
  readBoard(projectRoot: string, boardId: string): Promise<KanbanBoard | null>;
  resolveKanbanBoundaryLayers(
    board: KanbanBoard,
    task: Pick<KanbanTask, 'boundary'> | null | undefined,
  ): KanbanBoundaryLayer[];
  evaluateKanbanBoundaryOpaque(
    layers: KanbanBoundaryLayer[],
    toolName: string,
  ): KanbanBoundaryEvaluation;
  evaluateKanbanBoundaryPath(
    layers: KanbanBoundaryLayer[],
    candidate: unknown,
    access: KanbanBoundaryAccess,
  ): KanbanBoundaryEvaluation;
  evaluateContractGraphReadiness(
    board: KanbanBoard,
    taskId: string,
  ): { ready: boolean; issues: KanbanContractReadinessIssue[] };
}

const notWired = (): never => {
  throw new Error(
    'KanbanGovernancePort is not wired — register the implementation at the CLI composition root (see setKanbanGovernance).',
  );
};

let port: KanbanGovernancePort | undefined;

/** Composition-root hook: register the real kanban-backed implementation. */
export function setKanbanGovernance(impl: KanbanGovernancePort): void {
  port = impl;
}

/** Resolve the governance port (throws when not wired, mirroring BoardStorePort). */
export function kanbanGovernance(): KanbanGovernancePort {
  return port ?? notWired();
}
