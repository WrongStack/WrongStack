import type { Context } from '@wrongstack/core/agent';
import type { AutonomousCoordinator, CoordinatorEvent } from '@wrongstack/core/coordination';
import type { TuiRuntimeState } from './tui-runtime-state.js';

interface TuiCoordinatorCallbacksContext {
  state: TuiRuntimeState;
  context: Context;
  coordinatorEvents: Set<(event: CoordinatorEvent) => void>;
  ensureAutonomousCoordinator: () => AutonomousCoordinator | null;
}

export function createTuiCoordinatorCallbacks({
  state,
  context,
  coordinatorEvents,
  ensureAutonomousCoordinator,
}: TuiCoordinatorCallbacksContext) {
  return {
    getAutonomousCoordinator: () => ensureAutonomousCoordinator(),
    subscribeCoordinatorEvents: (fn: (event: CoordinatorEvent) => void) => {
      coordinatorEvents.add(fn);
      return () => {
        coordinatorEvents.delete(fn);
      };
    },
    onCoordinatorStart: (goal?: string) => {
      const coordinator = ensureAutonomousCoordinator();
      if (!coordinator) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'coordinator.not_ready',
            message: 'no director available',
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }
      if (state.coordinatorRun) return;
      state.coordinatorRun = coordinator
        .run({ goal: goal ?? 'Improve the codebase', runUntilComplete: true })
        .then(() => undefined)
        .catch((err) => {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'coordinator.run_failed',
              message: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .finally(() => {
          state.coordinatorRun = null;
        });
    },
    onCoordinatorStop: () => {
      state.autonomousCoordinator?.stop();
    },
    onCoordinatorTasks: async () => {
      const coordinator = ensureAutonomousCoordinator();
      if (!coordinator) return null;
      await coordinator.graph.load();
      return coordinator.auction.getPendingTasks().map((task) => ({
        id: task.id,
        title: task.title,
        priority: task.priority,
        tags: task.tags,
      }));
    },
    onCoordinatorClaim: async (taskId: string) => {
      const coordinator = ensureAutonomousCoordinator();
      if (!coordinator) return 'No coordinator is active.';
      await coordinator.graph.load();
      const goal = coordinator.graph.get(taskId) as
        | import('@wrongstack/core/coordination').GoalNode
        | undefined;
      if (goal?.type !== 'goal') {
        return `Task ${taskId.slice(0, 8)} not found in the coordinator graph.`;
      }
      if (goal.status !== 'pending') {
        return `Task ${taskId.slice(0, 8)} is ${goal.status}, not claimable.`;
      }
      const ok = await coordinator.auction.claim(
        taskId,
        `terminal@${context.session.id ?? 'unknown'}`,
        'Terminal worker',
      );
      if (!ok) {
        return `Task ${taskId.slice(0, 8)} could not be claimed (status changed?).`;
      }
      return { description: goal.description };
    },
    onCoordinatorComplete: async (taskId: string, result?: string) => {
      const coordinator = ensureAutonomousCoordinator();
      if (!coordinator) return 'No coordinator is active.';
      await coordinator.graph.load();
      const goal = coordinator.graph.get(taskId) as
        | import('@wrongstack/core/coordination').GoalNode
        | undefined;
      if (goal?.type !== 'goal') {
        return `Task ${taskId.slice(0, 8)} not found in the coordinator graph.`;
      }
      if (goal.status !== 'in_progress') {
        return `Task ${taskId.slice(0, 8)} is ${goal.status}, cannot complete.`;
      }
      await coordinator.reportTaskCompletion(
        taskId,
        result ?? 'Terminal worker completed the task',
      );
      return null;
    },
    onCoordinatorFail: async (taskId: string, error: string) => {
      const coordinator = ensureAutonomousCoordinator();
      if (!coordinator) return 'No coordinator is active.';
      await coordinator.graph.load();
      const goal = coordinator.graph.get(taskId) as
        | import('@wrongstack/core/coordination').GoalNode
        | undefined;
      if (goal?.type !== 'goal') {
        return `Task ${taskId.slice(0, 8)} not found in the coordinator graph.`;
      }
      if (goal.status !== 'in_progress') {
        return `Task ${taskId.slice(0, 8)} is ${goal.status}, cannot fail.`;
      }
      await coordinator.reportTaskFailure(taskId, error);
      return null;
    },
    onCoordinatorStatus: async () => {
      const coordinator = ensureAutonomousCoordinator();
      if (!coordinator) return null;
      await coordinator.syncFromGraph();
      const stats = coordinator.getStats();
      return {
        goals: {
          total: stats.goals.total,
          done: stats.goals.done,
          pending: stats.goals.pending,
          failed: stats.goals.failed,
        },
        dag: {
          running: stats.dag.running,
          ready: stats.dag.ready,
          done: stats.dag.done,
          failed: stats.dag.failed,
        },
        auction: {
          pending: stats.auction.pending,
          inProgress: stats.auction.in_progress,
        },
      };
    },
  };
}
