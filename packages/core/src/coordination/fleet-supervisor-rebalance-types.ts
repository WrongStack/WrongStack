import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { FleetSupervisorConfig } from '@wrongstack/contracts/types/config';
import type { TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import type { BrainArbiter } from '../brain/brain.js';

import type { FleetBus } from './fleet-bus.js';

/** One subagent row of the snapshot the supervisor reasons over. */
export interface SupervisedSubagent {
  id: string;
  name: string;
  status: 'running' | 'idle' | 'stopped' | 'error';
  currentTask?: string | undefined;
}

/** Read port — implemented over Director/coordinator state by the host. */
export interface FleetSupervisorSource {
  subagents(): SupervisedSubagent[];
  listPendingTasks(): readonly TaskSpec[];
  isWorkComplete(): boolean;
}

/** Action port — every mutation the supervisor may perform, brain-gated. */
export interface FleetSupervisorActions {
  /** Move a still-pending task to another (or any idle) worker. */
  retargetPendingTask(taskId: string, subagentId: string | undefined): boolean | Promise<boolean>;
  /** Spawn an additional helper worker. Return {error} to degrade gracefully. */
  spawnHelper(input: {
    reason: string;
    /** Oldest queued task used to route the helper's role/tool profile. */
    task?: TaskSpec | undefined;
  }): Promise<{ subagentId: string } | { error: string }>;
  /** High-priority steer mail to one agent. */
  steerAgent(subagentId: string, subject: string, body: string): Promise<void>;
  /**
   * Status note to the session leader.
   *
   * `subagentId` names the worker the note is ABOUT, when there is one. The
   * host resolves the conversation from it: with several tabs sharing this
   * fleet, "the session leader" is not one address, and a note about tab 3's
   * worker sent to the boot tab's leader reaches nobody who can act on it.
   * Omitted for fleet-wide observations, which fall back to the host session.
   */
  notifyLeader(subject: string, body: string, subagentId?: string): Promise<void>;
  /** Abort a subagent (only used when config.allowTerminate). */
  terminate(subagentId: string): Promise<void>;
}

export interface FleetSupervisorOptions {
  events: EventBus;
  fleet: FleetBus;
  brain: BrainArbiter;
  source: FleetSupervisorSource;
  actions: FleetSupervisorActions;
  /** Active host session id, read lazily (resume/session-swap safe). */
  sessionId?: (() => string | undefined) | undefined;
  config?: FleetSupervisorConfig | undefined;
  /** Injectable clock for tests. Default Date.now. */
  now?: (() => number) | undefined;
}

export interface SupervisorLogEntry {
  at: number;
  kind: string;
  subagentId?: string | undefined;
  taskId?: string | undefined;
  proposedAction: string;
  outcome: 'approved' | 'denied' | 'escalated' | 'skipped' | 'error';
  detail: string;
}

export interface ResolvedSupervisorConfig {
  enabled: boolean;
  intervalMs: number;
  cooldownMs: number;
  maxInterventionsPerSubagent: number;
  pinnedWaitMs: number;
  overloadPinnedThreshold: number;
  backlogFactor: number;
  stuckMs: number;
  failureStreak: number;
  loopStreak: number;
  allowSpawn: boolean;
  allowTerminate: boolean;
}
