import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../types/logger.js';
import type { GoalOptions, PhaseExecutionContext, PhaseGraph } from './types.js';

export interface PhaseOrchestratorOptions extends GoalOptions {
  graph: PhaseGraph;
  ctx: PhaseExecutionContext;
  logger?: Logger | undefined;
}

export type NormalizedGoalOptions = Omit<
  GoalOptions,
  | 'maxConcurrentPhases'
  | 'maxConcurrentTasks'
  | 'maxRetries'
  | 'maxVerifyAttempts'
  | 'autonomous'
  | 'phaseDelayMs'
  | 'stopOnFailure'
  | 'taskTimeoutMs'
  | 'events'
  | 'worktrees'
> & {
  maxConcurrentPhases: number;
  maxConcurrentTasks: number;
  maxRetries: number;
  maxVerifyAttempts: number;
  autonomous: boolean;
  phaseDelayMs: number;
  stopOnFailure: boolean;
  taskTimeoutMs: number;
  events: EventBus;
};
