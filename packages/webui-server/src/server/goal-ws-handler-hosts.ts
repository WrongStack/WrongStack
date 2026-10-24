import type { PhaseTemplate } from '@wrongstack/goal';
import {
  planPhases as delegatePlanPhases,
  runChimeraReview as delegateRunChimeraReview,
  type GoalPhasePlanningHost,
} from './goal-phase-planning.js';
import type { GoalRunHost } from './goal-run.js';
import type { GoalWorkerHost } from './goal-workers.js';
import type { GoalWsHandlerInternals } from './goal-ws-handler-internals.js';

/**
 * Host adapters for `GoalWebSocketHandler`: live getter/setter views over the
 * handler's fields that the extracted Goal planning / run / worker modules
 * consume, plus the isolated-agent wrappers for planning and review turns.
 */
export function buildGoalPhasePlanningHost(self: GoalWsHandlerInternals): GoalPhasePlanningHost {
  return {
    get agent() {
      return self.agent;
    },
    get logger() {
      return self.logger;
    },
  };
}

export function buildGoalRunHost(self: GoalWsHandlerInternals): GoalRunHost {
  return {
    get goalId() {
      return self.goalId;
    },
    get abort() {
      return self.abort;
    },
    set abort(value) {
      self.abort = value;
    },
    planPhases: (...args) => self.planPhases(...args),
    get stopping() {
      return self.stopping;
    },
    broadcast: (...args) => self.broadcast(...args),
    get runStatus() {
      return self.runStatus;
    },
    set runStatus(value) {
      self.runStatus = value;
    },
    get logger() {
      return self.logger;
    },
    get graph() {
      return self.graph;
    },
    set graph(value) {
      self.graph = value;
    },
    get worktrees() {
      return self.worktrees;
    },
    set worktrees(value) {
      self.worktrees = value;
    },
    get runBase() {
      return self.runBase;
    },
    set runBase(value) {
      self.runBase = value;
    },
    get events() {
      return self.events;
    },
    get projectRoot() {
      return self.projectRoot;
    },
    get context() {
      return self.context;
    },
    get persistence() {
      return self.persistence;
    },
    runRepairPhase: (...args) => self.runRepairPhase(...args),
    executeTaskWithAgent: (...args) => self.executeTaskWithAgent(...args),
    runChimeraReview: (...args) => self.runChimeraReview(...args),
    persistDetached: (...args) => self.persistDetached(...args),
    broadcastState: (...args) => self.broadcastState(...args),
    get orchestrator() {
      return self.orchestrator;
    },
    set orchestrator(value) {
      self.orchestrator = value;
    },
    startBroadcast: (...args) => self.startBroadcast(...args),
    get runPromise() {
      return self.runPromise;
    },
    set runPromise(value) {
      self.runPromise = value;
    },
    stopBroadcast: (...args) => self.stopBroadcast(...args),
    releaseActiveRunLease: (...args) => self.releaseActiveRunLease(...args),
  };
}

export function buildGoalWorkerHost(self: GoalWsHandlerInternals): GoalWorkerHost {
  return {
    get usedNicknames() {
      return self.usedNicknames;
    },
    broadcastState: (...args) => self.broadcastState(...args),
    get abort() {
      return self.abort;
    },
    get taskAgentFactory() {
      return self.taskAgentFactory;
    },
    get context() {
      return self.context;
    },
    get agent() {
      return self.agent;
    },
    get projectRoot() {
      return self.graph?.workspace?.dir ?? self.projectRoot;
    },
    get logger() {
      return self.logger;
    },
    get assessAbort() {
      return self.assessAbort;
    },
    set assessAbort(value) {
      self.assessAbort = value;
    },
    get assessSeq() {
      return self.assessSeq;
    },
    set assessSeq(value) {
      self.assessSeq = value;
    },
  };
}

/** Plan phases+todos for the goal via the LLM; reject unusable plans.
 *  The caller passes the run's abort signal so a stop during planning cancels
 *  the LLM turn (the previous fresh, never-aborted controller made planning
 *  uninterruptible). */
export async function planGoalPhases(
  self: GoalWsHandlerInternals,
  goal: string,
  signal?: AbortSignal,
): Promise<PhaseTemplate[]> {
  if (self.goalId && self.taskAgentFactory) {
    const built = await self.taskAgentFactory({
      name: `goal-planner-${self.goalId}`.slice(0, 48),
      role: 'planner',
      cwd: self.projectRoot,
      allowedCapabilities: ['fs.read'],
      // An explicit empty list keeps the planner role's skill pool out (#416):
      // those skills teach a Markdown plan layout, and a model that followed
      // them instead of the JSON-only phase prompt produced no phases at all.
      skillNames: [],
    });
    try {
      return await delegatePlanPhases({ agent: built.agent, logger: self.logger }, goal, signal);
    } finally {
      await built.dispose?.();
    }
  }
  return delegatePlanPhases(buildGoalPhasePlanningHost(self), goal, signal);
}

/** Run a lightweight chimera-style review before the task is settled. */
export async function runGoalChimeraReview(
  self: GoalWsHandlerInternals,
  task: import('@wrongstack/contracts/types').TaskNode,
  phaseId: string,
  result: unknown,
  cwd?: string | undefined,
): Promise<void> {
  if (self.taskAgentFactory) {
    const built = await self.taskAgentFactory({
      name: `goal-review-${task.title}`.slice(0, 48),
      role: 'reviewer',
      cwd,
      spawnBudgetExempt: true,
      allowedCapabilities: ['fs.read'],
    });
    try {
      return await delegateRunChimeraReview(
        { agent: built.agent, logger: self.logger },
        task,
        phaseId,
        result,
        cwd,
      );
    } finally {
      await built.dispose?.();
    }
  }
  return delegateRunChimeraReview(buildGoalPhasePlanningHost(self), task, phaseId, result, cwd);
}
