/**
 * Structural host contracts consumed by Director-facing tools.
 *
 * Keep these ports independent from the concrete Director class: tool policy,
 * orchestration implementation, and read-model evolution can then change
 * without creating a type-level dependency cycle.
 */
import type {
  AwaitAnyResult,
  CoordinatorStatus,
  SubagentConfig,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import type { CollabDebugReport, CollabSessionOptions } from './collab-debug.js';
import type { DispatchClassifier } from './dispatcher.js';
import type { FleetBus, FleetUsage } from './fleet-bus.js';
import type { IFleetManager } from './ifleet-manager.js';

interface DirectorSpawnPort {
  spawn(config: SubagentConfig): Promise<string>;
}

/** Admission includes optional smart-dispatch policy used before spawning. */
export interface DirectorAdmissionPort extends DirectorSpawnPort {
  readonly dispatchClassifier?: DispatchClassifier | undefined;
}

interface DirectorBudgetPort {
  getRemainingBudgetUsd(): number | undefined;
}

export interface DirectorAssignmentPort {
  assign(task: TaskSpec): Promise<string>;
  awaitTasks(taskIds: string[]): Promise<TaskResult[]>;
  awaitTasksAny(taskIds: string[], opts?: { timeoutMs?: number }): Promise<AwaitAnyResult>;
}

/** Independent reviewer/verifier work plus an optional implementer repair pass. */
export interface DirectorRepairPort extends DirectorSpawnPort, DirectorAssignmentPort {}

export interface DirectorQuestionPort {
  ask<T = unknown>(subagentId: string, payload: unknown, timeoutMs?: number): Promise<T>;
  rollUp(taskIds: string[], style?: 'markdown' | 'json'): string;
}

export interface DirectorLifecyclePort {
  terminate(subagentId: string): Promise<void>;
  terminateAll(): Promise<void>;
  workComplete(): void;
}

export interface DirectorAnswerStorePort {
  readonly largeAnswerStore: {
    storeAnswer(value: unknown): { key?: string | undefined; summary: string; inline: boolean };
    retrieveAnswer(key: string): unknown | undefined;
  };
}

export interface DirectorPublishingPort {
  readonly id: string;
  readonly fleet: Pick<FleetBus, 'emit'>;
}

/** Lease supervision only needs terminal fleet events and worker teardown. */
export interface DirectorLeaseRecoveryPort
  extends DirectorSpawnPort,
    DirectorBudgetPort,
    DirectorAssignmentPort,
    Pick<DirectorLifecyclePort, 'terminate'> {
  readonly fleet: Pick<FleetBus, 'subscribe'>;
}

export interface DirectorReadModelPort {
  readonly fleetManager:
    | Pick<IFleetManager, 'getFleetStats' | 'getFleetStatus' | 'snapshot'>
    | undefined;
  status(): CoordinatorStatus;
  snapshot(): FleetUsage;
  readSession(
    subagentId: string,
    tail?: number | undefined,
  ): Promise<{
    lastAssistantText?: string | undefined;
    lastStopReason?: string | undefined;
    toolUsesObserved: number;
    events: number;
    path?: string | undefined;
  } | null>;
}

export interface DirectorCollabPort {
  spawnCollab(options: CollabSessionOptions): Promise<CollabDebugReport>;
}
