/**
 * Types shared by the kernel event-map modules (`events/*.ts`) and the
 * `events.ts` hub. They live in this leaf so an event-map module never has to
 * import the hub that imports it; `events.ts` re-exports them unchanged.
 */

/** Distress signals the BrainMonitor watches. See `brain/brain-monitor.ts`. */
export type BrainInterventionKind =
  | 'tool_failure_streak'
  | 'error_storm'
  | 'agent_stall'
  | 'file_churn';

/**
 * Structural shape of a tracked agent as flushed by AgentStatusTracker. Kept
 * structural (not imported from the root `session-registry` module) so the
 * low-level kernel layer takes on no dependency on composition modules. The
 * real `AgentEntry` is assignable to this.
 */
export interface TrackedAgentSnapshot {
  id: string;
  name: string;
  startedAt?: string | undefined;
  status: string;
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  taskId?: string | undefined;
  iterations: number;
  toolCalls: number;
  costUsd?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  ctxPct?: number | undefined;
  model?: string | undefined;
  partialText?: string | undefined;
  todos?:
    | Array<{
        id: string;
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        activeForm?: string | undefined;
      }>
    | undefined;
  latestPrompt?: string | undefined;
  latestPromptAt?: number | undefined;
  lastActivityAt: string;
}
