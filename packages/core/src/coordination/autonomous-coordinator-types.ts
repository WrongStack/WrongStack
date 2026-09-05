import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../types/logger.js';
import type { LLMProvider } from './autonomous-brain.js';
import type { Director } from './director.js';
import type { FleetBus } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { Mailbox } from './mailbox-types.js';
import type { TaskAuctioneer } from './task-auctioneer.js';
import type { TaskDAG } from './task-dag.js';

/**
 * CoordinatorEvent — union of all event types emitted by the AutonomousCoordinator.
 * Consumed by the TUI to drive coordinator panel state and the reducer.
 */
export type CoordinatorEvent =
  | { type: 'goal:added'; goalId: string; title?: string; text?: string; participants?: string[] }
  | { type: 'goal:completed'; goalId: string; text?: string; participants?: string[] }
  | { type: 'goal:failed'; goalId: string; text?: string }
  | {
      type: 'task:ready';
      goalId: string;
      taskId: string;
      title?: string;
      assignedTo?: string;
      text?: string;
    }
  | { type: 'task:completed'; goalId: string; taskId: string; text?: string }
  | { type: 'knowledge:added'; knowledgeId: string; title?: string; text?: string }
  | { type: 'consensus:reached'; goalId: string; text?: string; participants?: string[] }
  | { type: 'deadlock:detected'; goalId: string; text?: string }
  | { type: 'coordinator:mode'; mode: 'standalone' | 'fleet' };

export interface AutonomousCoordinatorOptions {
  sessionDir: string;
  selfAgentId: string;
  selfAgentName: string;
  fleet?: FleetBus | undefined;
  fleetManager?: FleetManager | undefined;
  director?: Director | undefined;
  mailbox?: Mailbox | undefined;
  events?: EventBus | undefined;
  llmProvider: LLMProvider;
  /** Disable self-improvement. Default: false. */
  disableSelfImprove?: boolean;
  /** Max concurrent subagents. Default: 5. */
  maxConcurrentAgents?: number;
  /**
   * Called with every CoordinatorEvent so the caller (e.g. execution.ts)
   * can forward it to the TUI coordinator panel timeline.
   */
  onCoordinatorEvent?: (event: CoordinatorEvent) => void;
  /** Logger for structured error events. Falls back to console.error when omitted. */
  logger?: Logger | undefined;
}

export interface RunOptions {
  /** Top-level goal description. Default: "Improve the codebase". */
  goal?: string;
  /** If true, the loop runs until all goals are done (no timeout). Default: false. */
  runUntilComplete?: boolean;
  /** Max iterations. Default: 100. */
  maxIterations?: number;
  /** Stop if cost exceeds this. Default: no limit. */
  maxCostUsd?: number;
}

export interface CoordinatorStats {
  goals: { total: number; done: number; pending: number; failed: number; progress: number };
  dag: ReturnType<TaskDAG['stats']>;
  auction: ReturnType<TaskAuctioneer['getStats']>;
  changes: { proposed: number; approved: number; applied: number; rejected: number };
  decisions: number;
  costSoFar?: number | undefined;
}
