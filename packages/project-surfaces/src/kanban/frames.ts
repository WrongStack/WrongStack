import { type KanbanResultPayload, useKanbanStore } from './kanban-store';

/**
 * Every engine frame the Kanban store folds: request replies and the board broadcasts
 * (`kanban.get`, `kanban.list`, `kanban.delete`, verification and decomposition events).
 * The WebUI routes the same set through its typed handler map.
 */
export const KANBAN_RESULT_TYPES = [
  'kanban.list',
  'kanban.get',
  'kanban.health',
  'kanban.workbench',
  'kanban.create',
  'kanban.duplicate',
  'kanban.update',
  'kanban.delete',
  'kanban.generate',
  'kanban.snapshot',
  'kanban.taskgraph.export',
  'kanban.taskgraph.sync',
  'kanban.contract.configure',
  'kanban.task.ready',
  'kanban.task.add',
  'kanban.task.split',
  'kanban.task.merge',
  'kanban.task.update',
  'kanban.task.move',
  'kanban.task.copy',
  'kanban.task.transfer',
  'kanban.task.transition',
  'kanban.task.chain',
  'kanban.task.chain.get',
  'kanban.task.claim',
  'kanban.task.release',
  'kanban.task.metric.add',
  'kanban.task.metric.update',
  'kanban.task.check.add',
  'kanban.task.check.update',
  'kanban.task.note.add',
  'kanban.task.activity.add',
  'kanban.task.assign',
  'kanban.task.dispatch',
  'kanban.task.remove',
  'kanban.task.get',
  'kanban.task.verify',
  'kanban.task.verification_started',
  'kanban.task.verification_completed',
  'kanban.board.history',
  'kanban.run.start',
  'kanban.supervisor.status',
  'kanban.supervisor.audit',
  'kanban.decomposition.approve',
  'kanban.decomposition.reject',
  'kanban.decomposition.resolved',
  'kanban.decomposition.applied',
] as const;

/** Folds every Kanban frame `on` delivers into the shared store; returns the unsubscribe. */
export function bindKanbanFrames(
  on: (type: string, handler: (message: { payload: unknown }) => void) => () => void,
): () => void {
  const offs = KANBAN_RESULT_TYPES.map((type) =>
    on(type, (message) =>
      useKanbanStore.getState().handleResult(type, message.payload as KanbanResultPayload),
    ),
  );
  return () => {
    for (const off of offs) off();
  };
}
