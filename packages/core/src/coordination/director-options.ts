import type { Config } from '../types/config.js';
import type { Logger } from '../types/logger.js';
import type {
  MultiAgentConfig,
  SubagentConfig,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import type { SessionWriter } from '../types/session.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { BrainArbiter } from './brain.js';
import type { DispatchClassifier } from './dispatcher.js';
import type { FleetManager } from './fleet-manager.js';
import type { ModelMatrixSource } from './model-matrix.js';
import type { ProviderModelStatusTracker } from './provider-status-tracker.js';
import type { FleetWorktreePolicy } from './worktree-task-runner.js';

/**
 * Payload handed to {@link DirectorOptions.taskResultNotifier} when a
 * fire-and-forget task completes (no `awaitTasks` waiter was pending).
 */
export interface TaskResultNotification {
  taskId: string;
  /** Task description (or task id when no description was recorded). */
  title: string;
  status: TaskResult['status'];
  subagentId: string;
  /** Human-readable subagent name from the fleet manifest, when known. */
  subagentName?: string | undefined;
  /** The subagent's textual result (stringified when structured). */
  resultText?: string | undefined;
  /** Flattened `kind: message` error string for non-success statuses. */
  errorText?: string | undefined;
  /** Bounded incomplete text recovered before a non-successful exit. */
  partialText?: string | undefined;
  /** Machine-readable result submitted through submit_result. */
  report?: TaskResult['report'] | undefined;
  iterations: number;
  toolCalls: number;
  durationMs: number;
}

export interface DirectorOptions {
  config: MultiAgentConfig;
  runner?: SubagentRunner | undefined;
  /** Optional Brain arbiter above the director for policy/decision escalation. */
  brain?: BrainArbiter | undefined;
  /**
   * Called when a task completes with NO pending `awaitTasks` waiter.
   * Internal tasks (shadow passes) are excluded. Errors are swallowed.
   */
  taskResultNotifier?: ((n: TaskResultNotification) => void | Promise<void>) | undefined;
  /** Remove a spawned or between-task subagent after this much idle time. */
  subagentIdleTimeoutMs?: number | undefined;
  /** Retire a subagent immediately after its final task result when idle. */
  retireSubagentOnTaskComplete?: boolean | undefined;
  /** Optional logger for structured debug/error logging. Falls back to console if omitted. */
  logger?: Logger | undefined;
  /** Absolute file path where the director writes a replayable fleet manifest. */
  manifestPath?: string | undefined;
  /** Optional roster used by `leaderSystemPrompt()` to render a roles summary. */
  roster?: Record<string, SubagentConfig>;
  /** Override the built-in fleet preamble. Empty string suppresses it. */
  directorPreamble?: string | undefined;
  /** Override the built-in subagent baseline. Empty string suppresses it. */
  subagentBaseline?: string | undefined;
  /** Shared scratchpad directory for fleet coordination. */
  sharedScratchpadPath?: string | undefined;
  /** Maximum number of spawns this director can perform across its lifetime. */
  maxSpawns?: number | undefined;
  /** Maximum nesting depth for spawns. */
  maxSpawnDepth?: number | undefined;
  /** Current spawn-chain depth for this director instance. */
  spawnDepth?: number | undefined;
  /** Absolute path to a live director-state checkpoint file. */
  stateCheckpointPath?: string | undefined;
  /** Session writer the director should forward task lifecycle events to. */
  sessionWriter?: SessionWriter | undefined;
  /** Session id for live fleet/coordinator events. */
  sessionId?: string | (() => string | undefined) | undefined;
  /** Debounce window for periodic manifest writes. */
  manifestDebounceMs?: number | undefined;
  /** Fleet-wide cost/token ceiling. */
  directorBudget?:
    | {
        maxCostUsd?: number | undefined;
        maxTokens?: number | undefined;
      }
    | undefined;
  /** Maximum auto-extensions per subagent per budget kind. */
  maxBudgetExtensions?: number | undefined;
  /** Debounce window for state-checkpoint writes. */
  checkpointDebounceMs?: number | undefined;
  /** Sessions root directory for per-subagent JSONL transcripts. */
  sessionsRoot?: string | undefined;
  /** Director run id used under `sessionsRoot`. */
  directorRunId?: string | undefined;
  /** Pre-built fleet manager for policy isolation. */
  fleetManager?: FleetManager | undefined;
  /** Optional LLM classifier for the smart dispatcher. */
  dispatchClassifier?: DispatchClassifier | undefined;
  /** Max leader context load before a new spawn is rejected. */
  maxLeaderContextLoad?: number | undefined;
  /** Provider's max context window in tokens. */
  maxContext?: number | (() => number | undefined) | undefined;
  /**
   * Live app config source for the deterministic model-tier layer. A getter is
   * preferred so tier edits (WebUI / TUI / `/tier`) take effect on the next
   * spawn without a restart, exactly like `modelMatrix`.
   */
  appConfig?: Config | (() => Config | undefined) | undefined;
  /** Per-task model matrix. */
  modelMatrix?: ModelMatrixSource | undefined;
  /** Optional git-worktree manager for Director fleet isolation. */
  worktrees?: WorktreeManager | undefined;
  /** Worktree policy. Defaults to `auto` when `worktrees` is provided. */
  worktreePolicy?: FleetWorktreePolicy | undefined;
  /** Optional guarded merge-conflict resolver. */
  worktreeConflictResolver?:
    | ((info: {
        task: TaskSpec;
        config: SubagentConfig;
        conflictFiles: string[];
        cwd: string;
      }) => Promise<boolean>)
    | undefined;
  /** Shared provider/model status tracker. */
  statusTracker?: ProviderModelStatusTracker | undefined;
  /** Session/leader's own provider id. */
  sessionProvider?: string | undefined;
  /** Session/leader's own model id. */
  sessionModel?: string | undefined;
}
