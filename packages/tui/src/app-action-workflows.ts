import type { AutonomyStage } from '@wrongstack/contracts/types';
import type { WorktreeTimelineEvent } from '@wrongstack/contracts/types/worktree-timeline';
import type { SddBoardSnapshot } from '@wrongstack/sdd';
import type { State } from './app-state.js';
import type { GoalSummary } from './app-state-core-types.js';
import type { FleetEntry } from './app-state-fleet.js';
import type { AutonomyOption, ShadowState, WorktreeRow } from './ui-contracts.js';
export type AppActionWorkflows =
  | { type: 'autonomyPickerOpen'; options: AutonomyOption[] }
  | { type: 'autonomyPickerClose' }
  | { type: 'autonomyPickerMove'; delta: number }
  | { type: 'autonomyPickerHint'; text?: string | undefined }
  | { type: 'shadowOpen'; shadow: ShadowState }
  | { type: 'shadowClose' }
  | { type: 'shadowUpdate'; shadow: ShadowState }
  | { type: 'shadowHint'; text?: string | undefined }
  | { type: 'bugHuntContinueOpen'; info: NonNullable<State['bugHuntContinue']> }
  | { type: 'bugHuntContinueClose' }
  | { type: 'bugHuntRunningOpen'; info: NonNullable<State['bugHuntRunning']> }
  | { type: 'bugHuntRunningClose' }
  | { type: 'fleetSeed'; entries: FleetEntry[]; cost: number }
  | {
      type: 'fleetSpawn';
      id: string;
      name?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      transcriptPath?: string | undefined;
    }
  | { type: 'fleetStart'; id: string; taskId?: string | undefined; task?: string | undefined }
  | { type: 'fleetDelta'; id: string; text: string }
  | { type: 'fleetMessage'; id: string; text: string }
  | {
      type: 'fleetTool';
      id: string;
      name?: string | undefined;
      ok?: boolean | undefined;
      durationMs?: number | undefined;
      outputBytes?: number | undefined;
      outputLines?: number | undefined;
    }
  | { type: 'fleetToolStart'; id: string; name: string }
  | { type: 'fleetToolEnd'; id: string }
  | {
      type: 'fleetUsage';
      id: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | {
      type: 'fleetDone';
      id: string;
      status: FleetEntry['status'];
      iterations: number;
      toolCalls: number;
      /** Human-readable failure reason, e.g. "provider_auth", "rate_limit", "timeout". */
      failureReason?: string | undefined;
      /** The task that ended, when the start event did not carry it. */
      task?: string | undefined;
    }
  | { type: 'fleetRemove'; id: string }
  | {
      type: 'fleetBudgetWarning';
      id: string;
      kind: string;
      used: number;
      limit: number;
    }
  | {
      type: 'fleetBudgetExtended';
      id: string;
      totalExtensions: number;
    }
  | {
      type: 'fleetCtxPct';
      id: string;
      load: number;
      tokens: number;
      maxContext: number;
      /** Estimated USD cost of the context tokens (optional — computed when pricing known). */
      ctxCost?: number | undefined;
    }
  | {
      type: 'fleetCost';
      cost: number;
      input?: number | undefined;
      output?: number | undefined;
      /** Per-subagent usage keyed by subagent id (from the director snapshot). */
      perAgent?: Record<string, { cost: number }>;
    }
  | { type: 'fleetConcurrency'; n: number }
  | {
      type: 'eternalStage';
      stage: AutonomyStage;
    }
  | { type: 'goalSummary'; summary: GoalSummary }
  | { type: 'goalRunInit'; title: string }
  | {
      type: 'goalRunPhaseUpdate';
      phaseId: string;
      name: string;
      status: string;
      completedTasks: number;
      totalTasks: number;
      startedAt?: number | undefined;
    }
  | { type: 'goalRunRunningPhases'; phaseIds: string[] }
  | { type: 'goalRunElapsed'; ms: number }
  | {
      type: 'goalRunTaskActive';
      phaseId: string;
      taskId: string;
      title: string;
      agent?: string | undefined;
      /** True when the task starts, false when it completes/fails. */
      active: boolean;
    }
  | {
      /** A task finished successfully; the reducer owns the count arithmetic. */
      type: 'goalRunTaskCompleted';
      phaseId: string;
      taskId: string;
    }
  | {
      /** Attach the assigned agent to an already-active task (reducer-owned). */
      type: 'goalRunTaskAgent';
      phaseId: string;
      taskId: string;
      agent?: string | undefined;
    }
  | { type: 'goalRunMonitorToggle' }
  | { type: 'goalRunReset' }
  | { type: 'sddBoardSnapshot'; snapshot: SddBoardSnapshot }
  | { type: 'sddBoardFocusNext' }
  | { type: 'sddBoardFocusPrev' }
  | {
      type: 'worktreeUpsert';
      handleId: string;
      row: Partial<WorktreeRow & { baseBranch?: string | undefined }>;
      baseBranch?: string | undefined;
    }
  | { type: 'worktreeRemove'; handleId: string }
  | { type: 'worktreeTimelineEvent'; event: WorktreeTimelineEvent }
  | {
      type: 'collabBugFound';
      sessionId: string;
      bugId: string;
      severity: string;
      description: string;
    }
  | {
      type: 'collabPlanEmitted';
      sessionId: string;
      planId: string;
      riskScore: string;
      phaseCount: number;
    }
  | {
      type: 'collabEvalComplete';
      sessionId: string;
      evalId: string;
      verdict: string;
      score: number;
    }
  | {
      type: 'collabSessionDone';
      sessionId: string;
      verdict: 'approve' | 'needs_revision' | 'reject';
    }
  | { type: 'collabSubagentSpawned'; subagentId: string; role: string };
