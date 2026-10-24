import type { EventBus, EventMap } from '@wrongstack/contracts/kernel/events';
import type { SubagentConfig, TaskResult } from '@wrongstack/contracts/types/multi-agent';
import type { Director } from '../director.js';

/**
 * Opaque host interface so the delegate runtime doesn't have to depend on the
 * CLI's `MultiAgentHost`. Director Mode is permanently on, so
 * `ensureDirector()` always succeeds; promotion exists for back-compat.
 */
export interface DelegateHost {
  /** True if a Director is already attached and running. */
  isDirectorMode(): boolean;
  /** Build (or return the cached) Director. */
  ensureDirector(): Promise<Director | null>;
  /** Return the live Director. Idempotent. */
  promoteToDirector(): Promise<Director | null>;
}

/** The runtime knobs `delegate` needs, independent of the tool surface. */
export interface DelegationRuntimeOptions {
  host: DelegateHost;
  roster?: Record<string, SubagentConfig> | undefined;
  /** Host silence window / default subagent wall-clock (ms). */
  defaultTimeoutMs: number;
  sessionsRoot?: string | undefined;
  directorRunId?: string | undefined;
  subagentTimeoutBufferMs?: number | undefined;
  events?: EventBus | undefined;
  /**
   * Tier for a task that named none (`createSystemOneTierSuggester`). Only
   * consulted when the caller set no tier, model or provider; `undefined`
   * keeps the routing-table default.
   */
  suggestTier?:
    | ((input: {
        task: string | undefined;
        role?: string | undefined;
      }) => Promise<string | undefined>)
    | undefined;
}

export interface DelegateInput {
  task?: string | undefined;
  scope?: unknown;
  outOfScope?: unknown;
  role?: string | undefined;
  name?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  tier?: string | undefined;
  /** Leader-chosen reasoning effort; see `SubagentConfig.leaderEffort`. */
  effort?: string | undefined;
  /** Skills to load first; see `SubagentConfig.requestedSkills`. */
  skills?: string[] | undefined;
  systemPromptOverride?: string | undefined;
  timeoutMs?: number | undefined;
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  idleTimeoutMs?: number | undefined;
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
  maxHandoffs?: number | undefined;
  wait?: boolean | undefined;
}

/** `wait` = the leader blocks on the call; `background` = tracker-owned. */
export type DelegateMode = 'wait' | 'background';

export type StopReason =
  | 'end_turn'
  | 'budget_exhausted'
  | 'subagent_timeout'
  | 'host_timeout'
  | 'handoff_limit'
  | 'aborted'
  | 'error';

export interface DelegateHandoff {
  fromSubagentId: string;
  fromTaskId: string;
  status: TaskResult['status'];
  errorKind?: string | undefined;
  summary: string;
  remainingWork: string;
}

export interface DelegateContinuation {
  summary: string;
  remainingWork: string;
  partialText?: string | undefined;
}

export interface SubagentPartial {
  lastAssistantText?: string | undefined;
  lastStopReason?: string | undefined;
  toolUsesObserved: number;
  events: number;
}

/**
 * The object `delegate` hands back to the model. The shape is the historical
 * blocking result; fields are optional because the error/abort/timeout
 * branches carry different subsets.
 */
export interface DelegateResult {
  ok: boolean;
  stopReason?: StopReason | undefined;
  status?: string | undefined;
  error?: unknown;
  hint?: string | undefined;
  subagentId?: string | undefined;
  taskId?: string | undefined;
  partial?: unknown;
  handoffs?: DelegateHandoff[] | undefined;
  errorKind?: string | undefined;
  retryable?: boolean | undefined;
  backoffMs?: number | undefined;
  result?: unknown;
  report?: TaskResult['report'];
  iterations?: number | undefined;
  toolCalls?: number | undefined;
  durationMs?: number | undefined;
  summary?: string | undefined;
  [extra: string]: unknown;
}

export type DelegateCompletedPayload = EventMap['delegate.completed'];
