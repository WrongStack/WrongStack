import type {
  CompactReport,
  Context,
  EventBus,
  HealthRegistry,
  MemoryStore,
  MetricsSink,
  ModeStore,
  Renderer,
  SessionStore,
  SkillLoader,
  SlashCommand,
  SlashCommandRegistry,
  TokenCounter,
  ToolRegistry,
  WstackPaths,
} from '@wrongstack/core';

export interface SlashCommandContext {
  registry: SlashCommandRegistry;
  toolRegistry: ToolRegistry;
  /** Resolved path helpers — use instead of constructing paths inline.
   *  Optional for unit tests that don't exercise commands requiring paths. */
  paths?: WstackPaths | undefined;
  compactor?: {
    compact(ctx: Context, opts?: { aggressive?: boolean | undefined }): Promise<CompactReport>;
  };
  sessionStore?: SessionStore | undefined;
  skillLoader?: SkillLoader | undefined;
  tokenCounter: TokenCounter;
  renderer: Renderer;
  /** App-level EventBus — used by AutoPhaseRunner to emit phase/graph events to the TUI. */
  events: EventBus;
  memoryStore?: MemoryStore | undefined;
  context?: Context | undefined;
  /** Working directory for the current session. */
  cwd: string;
  /** Project root (typically resolved from cwd). */
  projectRoot: string;
  metricsSink?: MetricsSink | undefined;
  healthRegistry?: HealthRegistry | undefined;
  modeStore?: ModeStore | undefined;
  /** Input reader for interactive pickers (arrow key navigation etc.). */
  inputReader?: import('@wrongstack/core').InputReader | undefined;
  onExit?: (() => void) | undefined;
  onBeforeExit?: () => Promise<{ abort?: boolean; message?: string | undefined } | void>;
  onClear?: (() => void) | undefined;
  /**
   * Called by /clear after wiping the session on disk and in the agent context.
   * The TUI installs a dispatch-backed handler here to also reset its UI state
   * (wipe rendered entries, reset fleet/leader stats, bump the context chip).
   */
  onNewSession?: (() => Promise<void>) | undefined;
  onDiag?: (() => string) | undefined;
  onStats?: (() => string | null) | undefined;
  /** Agent Monitor Service — tracks subagent conversations and streams to HQ. */
  agentMonitor?: import('@wrongstack/core/coordination').AgentMonitorService | undefined;
  /**
   * Generate a commit message by calling the LLM with the git diff.
   * Receives the raw diff, returns a commit message string.
   * When omitted /commit falls back to heuristics-only messages.
   */
  generateCommitMessage?: ((diff: string) => Promise<string>) | undefined;
  /** Fire-and-forget spawn — returns immediately with spawn metadata. Used by /spawn. */
  onSpawn?: (
    description: string,
    opts?: {
      provider?: string | undefined;
      model?: string | undefined;
      tools?: string[] | undefined;
      name?: string | undefined;
      /** Explicit capability allowlist for the subagent's auto-approve policy.
       *  When omitted the host applies the WIDE working default (read/write/
       *  net/shell/install) — or, for a scoped tools slice, that plus the
       *  tools' own capabilities. Pass this to narrow (e.g. read-only) or to
       *  grant an escape-hatch cap (fs.write.outside-project, config.mutate). */
      allowedCapabilities?: readonly string[] | undefined;
      /** Legacy Shadow Agent interval in ms. Only used when name === 'shadow'. */
      shadowIntervalMs?: number | undefined;
    },
  ) => Promise<string>;
  /**
   * Blocking spawn — waits for the subagent to complete and returns the full
   * result. Used by /techstack and any other command that needs the subagent's
   * actual output inline.
   */
  onSpawnAndWait?: (
    description: string,
    opts?: {
      provider?: string | undefined;
      model?: string | undefined;
      tools?: string[] | undefined;
      name?: string | undefined;
      /** Explicit capability allowlist for the subagent's auto-approve policy.
       *  When omitted the host applies the WIDE working default (read/write/
       *  net/shell/install) — or, for a scoped tools slice, that plus the
       *  tools' own capabilities. Pass this to narrow (e.g. read-only) or to
       *  grant an escape-hatch cap (fs.write.outside-project, config.mutate). */
      allowedCapabilities?: readonly string[] | undefined;
      /** Legacy Shadow Agent interval in ms. Only used when name === 'shadow'. */
      shadowIntervalMs?: number | undefined;
    },
  ) => Promise<string>;
  onAgents?: ((subagentId?: string) => string) | undefined;
  onFleet?: (
    action: 'status' | 'usage' | 'kill' | 'manifest' | 'concurrency' | 'retry' | 'log',
    target?: string | undefined,
  ) => Promise<string>;
  /**
   * Get live coordinator status for /fleet. Returns null when no fleet is active.
   */
  onFleetStatus?: (() => import('@wrongstack/core').CoordinatorStatus | null) | undefined;
  /**
   * Get fleet usage summary for /fleet usage.
   */
  onFleetUsage?: (() => import('@wrongstack/core').FleetUsage | null) | undefined;
  /**
   * Kill all running subagents. Returns count of killed subagents.
   */
  onFleetKill?: (() => number | Promise<number>) | undefined;
  /**
   * Abort the in-flight leader run. Installed by the surface (REPL/TUI) on
   * startup so `/interrupt` can stop the current iteration — slash commands
   * don't get the RunController directly. The default no-op returns false;
   * a real handler returns true when it actually aborted a run.
   */
  interruptController?:
    | {
        abortLeader: () => boolean;
      }
    | undefined;
  /**
   * Terminate a specific subagent by id. Returns true if terminated.
   */
  onFleetTerminate?: ((subagentId: string) => boolean | Promise<boolean>) | undefined;
  /**
   * Spawn a subagent of a given role. Returns the new subagent id.
   */
  onFleetSpawn?: ((role: string) => Promise<string>) | undefined;
  /**
   * Optional LLM classifier for `/fleet dispatch`. When wired, the smart
   * dispatcher uses it to resolve ambiguous routing decisions; without it the
   * dispatcher is heuristic-only. Built from the session provider in the host.
   */
  onDispatchClassify?: import('@wrongstack/core').DispatchClassifier | undefined;
  /**
   * Toggle subagent activity streaming into the leader's history. The
   * TUI installs the actual setter on mount via a shared controller;
   * before that, calls are buffered into the initial-value field so
   * `/fleet stream off` issued before mount still takes effect.
   */
  fleetStreamController?:
    | {
        /** Current state, readable for the slash command's reply. */
        enabled: boolean;
        /** Replaced by the TUI on mount with a dispatch-backed setter. */
        setEnabled: (enabled: boolean) => void;
      }
    | undefined;
  /**
   * Toggle prompt refinement ("did you mean this?"). The TUI installs the
   * actual dispatch-backed setter on mount via this shared controller; before
   * that, `enabled` just mirrors the requested value so a pre-mount toggle
   * still takes effect. Backed by `config.autonomy.enhance`.
   */
  enhanceController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  };
  /**
   * Re-run interrupted tasks from a prior director-state.json. Pass `undefined`
   * to list them, a specific task id to retry one, or 'all' to retry every
   * interrupted task. Returns a human-readable summary. Only wired when
   * director mode is enabled.
   */
  onFleetRetry?: ((taskId?: string) => Promise<string>) | undefined;
  /**
   * Inspect per-subagent JSONL transcripts under `<fleetRoot>/subagents/`.
   * Pass `undefined` to list available transcripts, a subagent id to show
   * a compact event summary, or a subagent id with `mode='raw'` to dump
   * the full JSONL. Only wired when a fleet root exists for this session.
   */
  onFleetLog?: (subagentId: string | undefined, mode: 'summary' | 'raw') => Promise<string>;
  /** Promote to director mode at runtime. Returns success message or null on failure. */
  onDirector?: (() => Promise<string | null>) | undefined;
  /** Manage plugin config from the interactive slash menu. */
  onPlugin?: ((args: string) => Promise<string>) | undefined;
  /** Set/query the effective context window for this session. */
  onContextLimit?: ((tokens?: number) => number) | undefined;
  /** Toggle or query YOLO mode at runtime. Pass undefined to query, boolean to set. */
  onYolo?: ((setTo?: boolean) => boolean) | undefined;
  /** Toggle or query next-task prediction. Pass undefined to query, boolean to set. */
  onNextPredict?: ((setTo?: boolean) => boolean) | undefined;
  /**
   * Store or retrieve the current suggestion list for `/next` selection.
   * Pass a string array to set suggestions. Call without args to get the
   * current list (returns empty array when no suggestions stored).
   */
  onSuggestions?: ((suggestions?: string[]) => string[]) | undefined;
  /** Toggle or query autonomy mode. Pass undefined to query, AutonomyMode to set. */
  onAutonomy?: (
    setTo?: import('./autonomy.js').AutonomyMode | undefined,
  ) => import('./autonomy.js').AutonomyMode;
  /**
   * Access the (possibly null) eternal-autonomy engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal'.
   */
  getEternalEngine?: (() => import('@wrongstack/core').EternalAutonomyEngine | null) | undefined;
  /**
   * Access the (possibly null) parallel-eternal engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal-parallel'.
   */
  getParallelEngine?: (() => import('@wrongstack/core').ParallelEternalEngine | null) | undefined;
  /**
   * Start the eternal/parallel autonomy engine. Called after `/autonomy eternal`
   * or `/autonomy parallel` confirms a goal exists and YOLO has been forced on.
   * Pass the mode so the REPL knows which engine to construct and drive.
   */
  onEternalStart?: ((mode?: import('./autonomy.js').AutonomyMode) => void) | undefined;
  /** Stop the eternal/parallel autonomy engine (mid-iteration abort + flag flip). */
  onEternalStop?: (() => void) | undefined;
  /**
   * Start the AutonomousCoordinator — project-level multi-session coordination
   * that tracks goals, tasks, knowledge, and consensus across all active sessions
   * in the same project. Fire-and-forget: run() loops asynchronously.
   * Pass the goal text to decompose and work on.
   */
  onCoordinatorStart?: ((goal?: string) => void) | undefined;
  /** Stop the AutonomousCoordinator loop. */
  onCoordinatorStop?: (() => void) | undefined;
  /**
   * List available coordinator tasks for the current terminal/session to claim.
   * Returns an array of pending tasks (id, title, priority, tags) or null when
   * no coordinator is active. Terminals are treated as eligible workers — an
   * open terminal session is sufficient; no subagent needs to be spawned.
   */
  onCoordinatorTasks?: (() => Promise<Array<{ id: string; title: string; priority: string; tags: string[] }> | null>) | undefined;
  /**
   * Claim a coordinator task from the terminal. On success returns the task
   * description so the caller can inject it as the next agent prompt.
   * Returns null when no coordinator is active, or an error message string.
   */
  onCoordinatorClaim?: ((taskId: string) => Promise<string | null | { description: string }>) | undefined;
  /** Mark a claimed task as completed. Returns null on success or an error message. */
  onCoordinatorComplete?: ((taskId: string, result?: string) => Promise<string | null>) | undefined;
  /** Mark a claimed task as failed. Returns null on success or an error message. */
  onCoordinatorFail?: ((taskId: string, error: string) => Promise<string | null>) | undefined;
  /** Get coordinator stats for status display. Returns null when no coordinator is active. */
  onCoordinatorStatus?: (() => Promise<{
    goals: { total: number; done: number; pending: number; failed: number };
    dag: { running: number; ready: number; done: number; failed: number };
    auction: { pending: number; inProgress: number };
  } | null>) | undefined;
  /**
   * Mutable holder for coordinator callbacks. Set by execution.ts when the
   * coordinator is created; read by slash commands. Mirrors the
   * `onPanelOpen.current` indirection pattern.
   */
  coordinatorController?: {
    onCoordinatorStart?: ((goal?: string) => void) | undefined;
    onCoordinatorStop?: (() => void) | undefined;
    onCoordinatorTasks?: (() => Promise<Array<{ id: string; title: string; priority: string; tags: string[] }> | null>) | undefined;
    onCoordinatorClaim?: ((taskId: string) => Promise<string | null | { description: string }>) | undefined;
    onCoordinatorComplete?: ((taskId: string, result?: string) => Promise<string | null>) | undefined;
    onCoordinatorFail?: ((taskId: string, error: string) => Promise<string | null>) | undefined;
    onCoordinatorStatus?: (() => Promise<{
      goals: { total: number; done: number; pending: number; failed: number };
      dag: { running: number; ready: number; done: number; failed: number };
      auction: { pending: number; inProgress: number };
    } | null>) | undefined;
  };
  /**
   * Ask the user a yes/no question on the REPL. Returns `true`/`false` for
   * Y/N answers, `null` when the user cancels (q). Resolves to `defaultYes`
   * on non-TTY / EOF so non-interactive callers don't hang. Slash commands
   * use this for destructive or surprising actions (e.g. starting eternal
   * mode against a stale goal).
   */
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean | null>;
  /**
   * Absolute path to the per-session plan JSON file. Read+written by the
   * `/plan` slash command. Optional — when omitted, `/plan` short-circuits
   * with a "not configured" message instead of crashing.
   */
  planPath?: string | undefined;
  /** Direct access to the session's LLM provider and model, available even before the first agent run. */
  llmProvider?: import('@wrongstack/core').Provider | undefined;
  llmModel?: string | undefined;
  /**
   * Create a Provider instance for any configured provider by its id.
   * Uses that provider's own API key (from config). Returns undefined
   * when the provider is not configured or has no valid key.
   *
   * This enables slash commands like /modeldiag eval to test models
   * across multiple providers, not just the currently active one.
   */
  createProvider?:
    | ((providerId: string) => import('@wrongstack/core').Provider | undefined)
    | undefined;
  /** StatusBar visibility config — loaded from ~/.wrongstack/statusline.json */
  statuslineConfig?: {
    get: () => Promise<import('./statusline.js').StatuslineConfig>;
    set: (cfg: import('./statusline.js').StatuslineConfig) => Promise<void>;
  };
  /**
   * Current list of hidden status bar items. Written by the /statusline command
   * so the TUI can update without a restart.
   */
  statuslineHiddenItems?: import('./statusline.js').StatuslineConfigKey[];
  setStatuslineHiddenItems?: (items: import('./statusline.js').StatuslineConfigKey[]) => void;
  /**
   * Atomically updates the in-memory hidden items list AND persists to
   * ~/.wrongstack/statusline.json. Used by the TUI's statusline picker.
   */
  saveStatuslineHiddenItems?: (items: import('./statusline.js').StatuslineConfigKey[]) => Promise<void>;
  /**
   * Controller for the agents monitor overlay. The TUI installs the actual
   * setter on mount via a shared controller; before that, calls are buffered
   * into the initial-value field so `/agents off` issued before mount still takes effect.
   */
  agentsMonitorController?:
    | {
        /** Current state, readable for the slash command's reply. */
        visible: boolean;
        /** Replaced by the TUI on mount with a dispatch-backed setter. */
        setVisible: (visible: boolean) => void;
      }
    | undefined;
  /** Manage MCP servers: add, remove, enable, disable, restart. */
  onMcp?: ((args: string) => Promise<string>) | undefined;
  /**
   * Fix a reported error or bug. Pass the error message or problem description.
   * Returns a structured diagnosis + fix plan, and sets up the next agent turn
   * with the appropriate skill (bug-hunter, typescript-strict, security-scanner).
   */
  onFix?: (
    errorText: string,
  ) => Promise<{ message?: string | undefined; runText?: string | undefined }>;
  /**
   * Start an SDD parallel fan-out run. Requires an active SDD session with
   * an approved spec and generated task graph.
   */
  onSddParallelRun?: (opts?: { parallelSlots?: number | undefined }) => Promise<string>;
  /** Stop the currently running SDD parallel fan-out. */
  onSddParallelStop?: (() => void) | undefined;
  /** Requeue every failed task in the active SDD run to pending. Returns the count requeued. */
  onSddRetryAllFailed?: (() => number) | undefined;
  /**
   * Split a task in the active SDD run into sub-tasks (refused while it runs).
   * Returns the new leaf ids, or null when there is no active run / unknown task.
   */
  onSddSplitTask?: ((taskId: string, subtasks: Array<{ title: string; description: string }>) => string[] | null) | undefined;
  /**
   * Remove the git worktrees + branches an SDD run created. Uses the live run
   * when one is active (after a stop), else sweeps the project's leftovers from
   * disk. Returns the number of worktrees removed.
   */
  onSddCleanWorktrees?: (() => Promise<number>) | undefined;
  /**
   * Roll back an SDD run's merged commits by reverting each on the base branch
   * (history-preserving). Refuses while a run is still live. Returns the outcome.
   */
  onSddRollback?: (() => Promise<{ ok: boolean; reverted: number; reason?: string }>) | undefined;
  /**
   * Destroy the SDD project: stop any active run, clean worktrees, and delete the
   * on-disk artifacts (specs, task-graphs, session, boards). Does NOT roll back
   * commits — that is the separate `/sdd rollback`.
   */
  onSddDestroy?: (() => Promise<{ worktreesRemoved: number; deleted: string[] }>) | undefined;
  /**
   * Start a real, LLM-driven AutoPhase run from a free-text goal. The host
   * plans phases (each holding many todos), persists the phase-graph as
   * per-project JSON, and drives the orchestrator — one subagent per task —
   * in the background. Returns the built graph or an error.
   */
  onAutoPhaseStart?: (opts: {
    goal: string;
    projectContext?: string | undefined;
  }) => Promise<
    { ok: true; graph: import('@wrongstack/core').PhaseGraph } | { ok: false; error: string }
  >;
  onAutoPhasePause?: (() => void) | undefined;
  onAutoPhaseResume?: (() => void) | undefined;
  onAutoPhaseStop?: (() => void) | undefined;
  /** Live, read-only view of the running AutoPhase (null when idle). */
  getAutoPhaseRunner?: () => {
    graph: import('@wrongstack/core').PhaseGraph;
    getProgress: () => import('@wrongstack/core').PhaseProgress | null;
    isRunning: () => boolean;
  } | null;
  /** Interactive board: move a task to another phase (returns false when idle/invalid). */
  onAutoPhaseMoveTask?: ((taskId: string, toPhaseId: string) => boolean) | undefined;
  /** Interactive board: (re)assign a task to an agent (clear with both omitted). */
  onAutoPhaseAssignTask?:
    | ((taskId: string, agentId?: string, agentName?: string) => boolean)
    | undefined;
  /** Interactive board: add a new task to a phase, returning its id (or null when idle). */
  onAutoPhaseAddTask?:
    | ((
        phaseId: string,
        spec: {
          title: string;
          description?: string;
          type?: import('@wrongstack/core').TaskNode['type'];
          priority?: import('@wrongstack/core').TaskNode['priority'];
        },
      ) => string | null)
    | undefined;
  /** Interactive board: requeue a task to pending so it (re)runs. */
  onAutoPhaseRetryTask?: ((taskId: string) => boolean) | undefined;
  /**
   * Manage git worktrees used for per-phase AutoPhase isolation.
   * `list` shows current worktrees, `merge <branch>` squash-merges a branch
   * into HEAD, `prune` removes stale entries, `clean` removes all
   * wstack-managed worktrees + branches. Backs the /worktree command.
   */
  onWorktree?: (action: 'list' | 'merge' | 'prune' | 'clean', target?: string) => Promise<string>;
  /**
   * The session's global Brain arbiter (policy → LLM → human chain).
   * `/brain ask <question>` consults it directly for decision support.
   */
  brain?: import('@wrongstack/core').BrainArbiter | undefined;
  /**
   * Live Brain autonomy settings — `/brain risk <level>` mutates
   * `maxAutoRisk` in place and the tiered arbiter reads it on every decision.
   */
  brainSettings?: { maxAutoRisk: import('@wrongstack/core').BrainAutoRisk } | undefined;
  /** Recent Brain decisions (newest last) for `/brain status`. */
  getBrainLog?:
    | (() => ReadonlyArray<{ at: number; kind: string; question: string; outcome: string }>)
    | undefined;
  /** Config store for reading/writing config sections at runtime (e.g. settings menu). */
  configStore: import('@wrongstack/core').ConfigStore;
  /** Models registry for looking up provider/model capabilities. */
  modelsRegistry?: import('@wrongstack/core').ModelsRegistry | undefined;
  /** Terminal reader for interactive user input (e.g. settings menu, auth menu). */
  reader: import('@wrongstack/core').InputReader;
  /**
   * Mutable ref for opening a TUI panel by dispatching its action type.
   * The slash commands call `onPanelOpen.current(action)` to open panels.
   * The TUI sets `onPanelOpen.current` to its actual dispatch function on mount.
   * This indirection lets the TUI set the function after slash commands are registered.
   */
  onPanelOpen: { current: ((action: string) => boolean) | null };
  /**
   * Tracks the active Shadow Agent subagent. Set by the host when a shadow
   * agent is spawned; cleared when the shadow agent terminates. Used by
   * /shadow start to reject spawn attempts when one is already running.
   */
  shadowController?: {
    /** id of the currently active Shadow Agent subagent, or null if none */
    activeId: string | null;
    /** Register a new shadow agent id. Throws if one is already active. */
    register(id: string): void;
    /** Clear the active shadow agent id (called on termination). */
    clear(): void;
    /** Read per-session defaults used by the next /shadow start. */
    getDefaults?: (() => { intervalMs?: number; provider?: string; model?: string }) | undefined;
    /** Update per-session defaults used by the next /shadow start. */
    setDefaults?:
      | ((defaults: { intervalMs?: number; provider?: string; model?: string }) => void)
      | undefined;
  } | undefined;
}

// Re-export helpers for external consumers (pre-launch.ts)
export type { ProjectFacts } from './helpers.js';
export { detectProjectFacts, renderAgentsTemplate } from './helpers.js';

import { buildAuthCommand } from './auth.js';
import { buildAutonomyCommand } from './autonomy.js';
import { buildAutoPhaseCommand } from './autophase.js';
import { buildBrainCommand } from './brain.js';
import { buildBtwCommand } from './btw.js';
import { buildClearCommand } from './clear.js';
import { buildCodebaseReindexCommand } from './codebase-reindex.js';
import { buildCollabCommand } from './collab.js';
import { buildCompactCommand } from './compact.js';
import { buildContextCommand } from './context.js';
import { buildDelegateCommand } from './delegate.js';
import { buildDevCommand } from './dev.js';
import { buildDiagCommand, buildStatsCommand } from './diag-stats.js';
import { buildDoctorCommand } from './doctor.js';
import { buildEnhanceCommand } from './enhance.js';
import { buildEnsembleCommand } from './ensemble.js';
import { buildFallbackCommand } from './fallback.js';
import { buildFixCommand } from './fix.js';
import { buildFleetCommand } from './fleet.js';
import { buildFKeysCommand, buildFKeyAliasCommands } from './f-keys.js';
import { buildGoalCommand } from './goal.js';
import { buildHelpCommand } from './help.js';
import { buildInitCommand } from './init.js';
import { buildInterruptCommand } from './interrupt.js';
import { buildMailboxCommand } from './mailbox.js';
import { buildMailboxDemoCommand } from './mailbox-demo.js';
import { buildMcpSlashCommand } from './mcp.js';
import { buildMemoryCommand } from './memory.js';
import { buildDesignCommand } from './design.js';
import { buildModeCommand } from './mode.js';
import { buildModelCapsCommand } from './modelcaps.js';
import { buildModelsCommand } from './models.js';
import { buildNextCommand } from './next.js';
import { buildPluginCommand } from './plugin.js';
import { buildPruneCommand } from './prune.js';
import { buildSddCommand } from './sdd.js';
import { buildExitCommand, buildLoadCommand, buildSaveCommand } from './session.js';
import { buildSetModelCommand } from './setmodel.js';
import { buildSuggestCommand } from './suggest.js';
import { buildCoordinatorCommand } from './coordinator.js';

// modeldiag is now a CLI subcommand (wstack modeldiag), not a slash command.

import { buildMouseCommand } from './mouse.js';
import { buildProjectCommand } from './project.js';
import { buildReviewCommand } from './review.js';
import { buildSecurityCommand } from './security.js';
import { buildSettingsCommand } from './settings.js';
import { buildHqCommand } from './hq.js';
import { buildAgentsCommand } from './agents.js';
import { buildDirectorCommand, buildSpawnCommand } from './spawn-agents.js';
import { buildStatuslineCommand } from './statusline.js';
import { buildTasksCommand } from './tasks.js';
import { buildTechStackCommand } from './techstack.js';
import { buildTelegramSetupCommand } from './telegram-setup.js';
import { buildTelegramSettingsCommand } from './telegram-settings.js';
import { buildTodosCommand } from './todos.js';
import { buildToolCommand } from './tool.js';
import { buildToolsCommand } from './tools.js';
import { buildWorkingDirCommand } from './working-dir.js';
import { buildWorktreeCommand } from './worktree.js';
import { buildYoloCommand } from './yolo.js';
import { buildShadowCommand } from './shadow.js';

export function buildBuiltinSlashCommands(opts: SlashCommandContext): SlashCommand[] {
  return [
    buildHelpCommand(opts),
    buildInitCommand(opts),
    buildClearCommand(opts),
    buildInterruptCommand(opts),
    buildCompactCommand(opts),
    buildContextCommand(opts),
    buildDelegateCommand(opts),
    buildDevCommand(opts),
    buildDoctorCommand(opts),
    buildCodebaseReindexCommand(opts),
    buildTechStackCommand(opts),
    buildToolCommand(opts),
    buildToolsCommand(opts),
    buildPluginCommand(opts),
    buildPruneCommand(opts),
    buildMcpSlashCommand(opts),
    buildSuggestCommand(opts),
    buildAuthCommand(opts),
    buildDiagCommand(opts),
    buildStatsCommand(opts),
    buildSpawnCommand(opts),
    buildAgentsCommand(opts),
    buildDirectorCommand(opts),
    buildFleetCommand(opts),
    buildFKeysCommand(opts),
    ...buildFKeyAliasCommands(opts),
    buildEnhanceCommand(opts),
    buildEnsembleCommand(opts),
    buildMemoryCommand(opts),
    buildTodosCommand(opts),
    buildTasksCommand(opts),
    buildSddCommand(opts),
    buildSaveCommand(opts),
    buildLoadCommand(opts),
    buildYoloCommand(opts),
    buildMouseCommand(opts),
    buildAutonomyCommand(opts),
    buildGoalCommand(opts),
    buildCoordinatorCommand(opts),
    buildBrainCommand(opts),
    buildBtwCommand(opts),
    buildNextCommand(opts),
    buildModeCommand(opts),
    buildDesignCommand(opts),
    buildMailboxDemoCommand(opts),
    buildMailboxCommand(opts),
    buildExitCommand(opts),
    buildFixCommand(opts),
    buildAutoPhaseCommand(opts),
    buildWorktreeCommand(opts),
    buildSettingsCommand(opts),
    buildHqCommand(opts),
    buildTelegramSetupCommand(opts),
    buildTelegramSettingsCommand(opts),
    buildSetModelCommand(opts),
    buildFallbackCommand(opts),
    buildModelCapsCommand(opts),
    buildModelsCommand(opts),
    buildCollabCommand(opts),
    buildReviewCommand(opts),
    buildSecurityCommand(opts),
    buildProjectCommand(opts),
    buildWorkingDirCommand(opts),
    buildStatuslineCommand({
      cwd: opts.cwd,
      hiddenItems: opts.statuslineHiddenItems ?? [],
      setHiddenItems: opts.setStatuslineHiddenItems ?? (() => {}),
      getConfig: opts.statuslineConfig?.get ?? (async () => ({})),
      setConfig: opts.statuslineConfig?.set ?? (async () => {}),
      saveStatuslineHiddenItems: opts.saveStatuslineHiddenItems ?? (async () => {}),
    }),
    buildShadowCommand(opts),
  ];
}
