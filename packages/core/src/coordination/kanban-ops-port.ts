/**
 * Kanban operations port for the coordination area (director queue tools).
 *
 * The director queue helpers previously imported `describeKanbanBoundary`
 * (a pure formatter) directly from `@wrongstack/kanban`, keeping a
 * core → kanban runtime edge (roadmap #11 / report §2.1). This port is
 * the leaf contract; the CLI composition root registers the real
 * implementation at boot alongside the storage BoardStorePort.
 *
 * Type-only imports of kanban's data shapes remain permitted — they erase
 * at compile time and do not create a runtime edge.
 */
import type { KanbanBoundaryPolicy } from '@wrongstack/kanban';

export interface KanbanBoundaryOpsPort {
  describeKanbanBoundary(policy: KanbanBoundaryPolicy | undefined): string;
}

const notWired = (): never => {
  throw new Error(
    'KanbanBoundaryOpsPort is not wired — register the implementation at the CLI composition root (see setKanbanBoundaryOps).',
  );
};

let port: KanbanBoundaryOpsPort | undefined = undefined;

/** Composition-root hook: register the real kanban-backed implementation. */
export function setKanbanBoundaryOps(impl: KanbanBoundaryOpsPort): void {
  port = impl;
}

/** Resolve the boundary-ops port (throws when not wired, mirroring BoardStorePort). */
export function kanbanBoundaryOps(): KanbanBoundaryOpsPort {
  return port ?? notWired();
}
