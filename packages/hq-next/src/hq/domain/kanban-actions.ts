/**
 * Kanban control rules shared by the mobile and desktop dashboards.
 *
 * The commands (`kanban-transition`, `kanban-assign`, `kanban-dispatch`) run
 * through the project owner's lifecycle gate on the client machine; these
 * helpers only decide which of them the UI offers for a task.
 *
 * @module domain/kanban-actions
 */
import type { HqSnapshot } from '@wrongstack/hq';
import type { HqKanbanTaskView } from './kanban-model.js';

export type LifecycleStage = 'backlog' | 'todo' | 'running' | 'review' | 'done';

const STAGES: readonly LifecycleStage[] = ['backlog', 'todo', 'running', 'review', 'done'];

function stageFromTask(task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage'>): LifecycleStage {
  if (task.lifecycleStage !== undefined) return task.lifecycleStage;
  if (task.status === 'ready') return 'todo';
  if (task.status === 'in_progress') return 'running';
  if (task.status === 'review') return 'review';
  if (task.status === 'completed') return 'done';
  return 'backlog';
}

export function kanbanTransitionOptions(
  task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage'>,
): LifecycleStage[] {
  const currentIndex = STAGES.indexOf(stageFromTask(task));
  if (currentIndex < 0 || currentIndex === STAGES.length - 1) return [];
  return STAGES.filter((_, index) => Math.abs(index - currentIndex) === 1);
}

export function suggestedKanbanStage(
  task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage'>,
): LifecycleStage {
  return kanbanTransitionOptions(task).at(-1) ?? stageFromTask(task);
}

export function canAssignKanbanTask(
  task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage' | 'assignmentStatus'>,
): boolean {
  return (
    stageFromTask(task) !== 'done' &&
    task.status !== 'archived' &&
    task.assignmentStatus !== 'queued' &&
    task.assignmentStatus !== 'running'
  );
}

export function canDispatchKanbanTask(
  task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage' | 'assignmentStatus'>,
): boolean {
  return (
    stageFromTask(task) === 'todo' &&
    task.assignmentStatus !== 'queued' &&
    task.assignmentStatus !== 'running'
  );
}

/** The connected clients that can take Kanban commands for a project. */
export function kanbanControlClients(
  snapshot: HqSnapshot | null,
  projectId: string,
): {
  control: HqSnapshot['clients'][number] | null;
  dispatch: HqSnapshot['clients'][number] | null;
} {
  const candidates = (snapshot?.clients ?? []).filter(
    (client) =>
      client.connected &&
      client.projectId === projectId &&
      client.capabilities.includes('control.receive'),
  );
  return {
    control: candidates[0] ?? null,
    dispatch: candidates.find((client) => client.capabilities.includes('kanban.dispatch')) ?? null,
  };
}
