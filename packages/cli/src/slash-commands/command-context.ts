import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  CompactOptions,
  CompactReport,
  HealthRegistry,
  MemoryPort,
  MetricsRuntimeStatus,
  MetricsSink,
  ModeStore,
  PermissionPolicy,
  Renderer,
  SessionStore,
  SkillLoader,
  TokenCounter,
} from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import type { SlashCommandRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { SummarizerPort } from '@wrongstack/tools';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import type { SlashFleetCommandContext } from './command-context-fleet.js';
import type { SlashSddGoalCommandContext } from './command-context-sdd-goal.js';

/** Host capabilities supplied to command adapters. */
export interface SlashCommandContext extends SlashFleetCommandContext, SlashSddGoalCommandContext {
  registry: SlashCommandRegistry;
  toolRegistry: ToolRegistry;
  /**
   * The agent's permission policy: `/permissions rules|explain` read it, and
   * it reads each session's `/permissions allow|deny` rules from that
   * session's context.
   */
  permissionPolicy?: PermissionPolicy | undefined;
  /** Run one tool through the active ToolExecutor and its permission policy. */
  executeTool?:
    | ((name: string, input: Record<string, unknown>, ctx: Context) => Promise<{ detail: string }>)
    | undefined;
  /** Resolved path helpers — use instead of constructing paths inline.
   *  Optional for unit tests that don't exercise commands requiring paths. */
  paths?: WstackPaths | undefined;
  /** Explicit legacy SDD session codec for compatibility tests/old hosts. */
  sddSessionTransport?: 'kanban' | 'legacy-file' | undefined;
  compactor?: {
    compact(ctx: Context, opts?: CompactOptions): Promise<CompactReport>;
  };
  sessionStore?: SessionStore | undefined;
  sessionRef?:
    | { current?: import('@wrongstack/contracts/types').SessionWriter | undefined }
    | undefined;
  skillLoader?: SkillLoader | undefined;
  tokenCounter: TokenCounter;
  renderer: Renderer;
  /** App-level EventBus — used by GoalRunner to emit phase/graph events to the TUI. */
  events: EventBus;
  memoryStore?: MemoryPort | undefined;
  /**
   * Optional vector memory store. Wired when the host has enabled the
   * dual-channel system; slash commands like `/memory diagnostics`
   * and `/memory race` use it to surface cross-system health and
   * run lexical vs semantic channel comparisons.
   */
  vectorMemoryStore?: VectorMemoryStore | undefined;
  context?: Context | undefined;
  /** Working directory for the current session. */
  cwd: string;
  /** Project root (typically resolved from cwd). */
  projectRoot: string;
  /**
   * Model port for the codebase index's concept layer. Present only when
   * `indexing.concepts.enabled` is true — its absence is what `/codebase-map
   * --enrich` reports instead of silently doing nothing.
   */
  codebaseConceptSummarizer?: SummarizerPort | undefined;
  metricsSink?: MetricsSink | undefined;
  healthRegistry?: HealthRegistry | undefined;
  metricsStatus?: MetricsRuntimeStatus | undefined;
  modeStore?: ModeStore | undefined;
  /** Input reader for interactive pickers (arrow key navigation etc.). */
  inputReader?: import('@wrongstack/contracts/types').InputReader | undefined;
  onExit?: (() => void | Promise<void>) | undefined;
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
  /** Promote to director mode at runtime. Returns success message or null on failure. */
  onDirector?: (() => Promise<string | null>) | undefined;
  /** Manage plugin config from the interactive slash menu. */
  onPlugin?: ((args: string) => Promise<string>) | undefined;
  /** Set/query the effective context window for this session. */
  onContextLimit?: ((tokens?: number) => number) | undefined;
  /** Toggle or query YOLO mode at runtime. Pass undefined to query, boolean to set. */
  onYolo?: ((setTo?: boolean) => boolean) | undefined;
  /** Read or set YOLO+ (nothing ever asks). On implies YOLO. */
  onYoloPlus?: ((setTo?: boolean) => boolean) | undefined;
  /**
   * Read, or set, which kinds of damage still prompt while YOLO is on.
   *
   * Returns the EFFECTIVE map after any update — the locked kinds report `true`
   * whatever was asked, so a caller can tell an ignored "off" from a real one.
   */
  onYoloConfirm?:
    | ((update?: {
        kind: import('@wrongstack/core/security').DestructiveKind;
        confirm: boolean;
      }) => Record<string, boolean>)
    | undefined;
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
    setTo?: import('../services/autonomy-mode.js').AutonomyMode | undefined,
  ) => import('../services/autonomy-mode.js').AutonomyMode;
  /**
   * Access the (possibly null) eternal-autonomy engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal'.
   */
  getEternalEngine?:
    | (() => import('@wrongstack/core/execution').EternalAutonomyEngine | null)
    | undefined;
  /**
   * Access the (possibly null) parallel-eternal engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal-parallel'.
   */
  getParallelEngine?:
    | (() => import('@wrongstack/core/coordination').ParallelEternalEngine | null)
    | undefined;
  /**
   * Start the eternal/parallel autonomy engine. Called after `/autonomy eternal`
   * or `/autonomy parallel` confirms a goal exists and YOLO has been forced on.
   * Pass the mode so the REPL knows which engine to construct and drive.
   */
  onEternalStart?:
    | ((mode?: import('../services/autonomy-mode.js').AutonomyMode) => void)
    | undefined;
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
  onCoordinatorTasks?:
    | (() => Promise<Array<{ id: string; title: string; priority: string; tags: string[] }> | null>)
    | undefined;
  /**
   * Claim a coordinator task from the terminal. On success returns the task
   * description so the caller can inject it as the next agent prompt.
   * Returns null when no coordinator is active, or an error message string.
   */
  onCoordinatorClaim?:
    | ((taskId: string) => Promise<string | null | { description: string }>)
    | undefined;
  /** Mark a claimed task as completed. Returns null on success or an error message. */
  onCoordinatorComplete?: ((taskId: string, result?: string) => Promise<string | null>) | undefined;
  /** Mark a claimed task as failed. Returns null on success or an error message. */
  onCoordinatorFail?: ((taskId: string, error: string) => Promise<string | null>) | undefined;
  /** Get coordinator stats for status display. Returns null when no coordinator is active. */
  onCoordinatorStatus?:
    | (() => Promise<{
        goals: { total: number; done: number; pending: number; failed: number };
        dag: { running: number; ready: number; done: number; failed: number };
        auction: { pending: number; inProgress: number };
      } | null>)
    | undefined;
  /**
   * Mutable holder for coordinator callbacks. Set by execution.ts when the
   * coordinator is created; read by slash commands. Mirrors the
   * `onPanelOpen.current` indirection pattern.
   */
  coordinatorController?: {
    onCoordinatorStart?: ((goal?: string) => void) | undefined;
    onCoordinatorStop?: (() => void) | undefined;
    onCoordinatorTasks?:
      | (() => Promise<Array<{
          id: string;
          title: string;
          priority: string;
          tags: string[];
        }> | null>)
      | undefined;
    onCoordinatorClaim?:
      | ((taskId: string) => Promise<string | null | { description: string }>)
      | undefined;
    onCoordinatorComplete?:
      | ((taskId: string, result?: string) => Promise<string | null>)
      | undefined;
    onCoordinatorFail?: ((taskId: string, error: string) => Promise<string | null>) | undefined;
    onCoordinatorStatus?:
      | (() => Promise<{
          goals: { total: number; done: number; pending: number; failed: number };
          dag: { running: number; ready: number; done: number; failed: number };
          auction: { pending: number; inProgress: number };
        } | null>)
      | undefined;
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
  llmProvider?: import('@wrongstack/contracts/types').Provider | undefined;
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
    | ((providerId: string) => import('@wrongstack/contracts/types').Provider | undefined)
    | undefined;
  /** StatusBar visibility config — loaded from the active profile/statusline.json */
  statuslineConfig?: {
    get: () => Promise<import('../services/statusline-config.js').StatuslineDocument>;
    set: (cfg: import('../services/statusline-config.js').StatuslineDocument) => Promise<void>;
  };
  /**
   * Current list of hidden status bar items. Written by the /statusline command
   * so the TUI can update without a restart.
   */
  statuslineHiddenItems?: import('../services/statusline-config.js').StatuslineConfigKey[];
  setStatuslineHiddenItems?: (
    items: import('../services/statusline-config.js').StatuslineConfigKey[],
  ) => void;
  /**
   * Atomically updates the in-memory hidden items list AND persists to
   * Active profile/statusline.json. Used by the TUI's statusline picker.
   */
  saveStatuslineHiddenItems?: (
    items: import('../services/statusline-config.js').StatuslineConfigKey[],
  ) => Promise<void>;
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
  /** Live registry used for explicit MCP resource/prompt discovery and insertion. */
  mcpRegistry?: import('@wrongstack/mcp').MCPRegistry | undefined;
  /**
   * Structured MCP server status for diagnostics (e.g. /tuneup). Backed by
   * `mcpRegistry.describe()` — includes disabled + failed servers, unlike the
   * rendered string `onMcp` returns. Undefined when no registry is wired.
   */
  mcpStatus?:
    | (() => Array<{ name: string; state: string; enabled: boolean; toolCount: number }>)
    | undefined;
  /**
   * Fix a reported error or bug. Pass the error message or problem description.
   * Returns a structured diagnosis + fix plan, and sets up the next agent turn
   * with the appropriate skill (bug-hunter, typescript-strict, security-scanner).
   */
  onFix?: (
    errorText: string,
  ) => Promise<{ message?: string | undefined; runText?: string | undefined }>;
  /**
   * Manage git worktrees used for per-phase Goal isolation.
   * `list` shows current worktrees, `merge <branch>` squash-merges a branch
   * into HEAD, `prune` removes stale entries, `clean` removes all
   * wstack-managed worktrees + branches. Backs the /worktree command.
   */
  onWorktree?: (action: 'list' | 'merge' | 'prune' | 'clean', target?: string) => Promise<string>;
  /**
   * The session's global Brain arbiter (policy → LLM → human chain).
   * `/brain ask <question>` consults it directly for decision support.
   */
  brain?: import('@wrongstack/core/coordination').BrainArbiter | undefined;
  /**
   * Live Brain autonomy settings — `/brain risk <level>` mutates
   * `maxAutoRisk` and `/brain mode <m>` mutates `mode` in place; the brain
   * chain reads both on every decision. `poolLabels`/`councilLabels` are
   * static wiring facts surfaced by `/brain status`.
   */
  brainSettings?:
    | {
        maxAutoRisk: import('@wrongstack/core/execution').BrainAutoRisk;
        mode?: import('@wrongstack/core/coordination').BrainEscalationMode | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
        ledgerPath?: string | undefined;
      }
    | undefined;
  /**
   * Live-editable Brain config owner — `/brain model|models|strategy|
   * timeout|council|ledger` setters call `apply()` (live rebuild +
   * persist to the global config).
   */
  brainRuntime?: import('@wrongstack/core/execution').BrainRuntime | undefined;
  /** Recent Brain decisions (newest last) for `/brain status`. */
  getBrainLog?:
    | (() => ReadonlyArray<{
        at: number;
        kind: string;
        question: string;
        outcome: string;
        /** Tier that resolved the decision, when the chain recorded one. */
        tier?: string | undefined;
      }>)
    | undefined;
  /**
   * Session-lifetime per-tier decision tally for `/brain stats`.
   *
   * Optional: hosts that only wire `getBrainLog` (the WebUI route context,
   * bare test containers) fall back to counting the ring buffer, which is
   * capped at 20 entries and therefore only ever describes the recent past.
   */
  brainTierStats?: (() => import('@wrongstack/core/coordination').BrainTierStats) | undefined;
  /** Config store for reading/writing config sections at runtime (e.g. settings menu). */
  configStore: import('@wrongstack/contracts/types').ConfigStore;
  /**
   * Host hook that adopts the store's new merged config after an in-process
   * selection change (today only `/profile switch`). The host's own `config`
   * object is a distinct snapshot from the store's, so a command that mutates
   * the store must hand the result back or the host keeps reading the values
   * it booted with.
   *
   * Optional by design: only the interactive CLI has a live merged config to
   * keep in step. Surfaces that leave it unset still persist the selection to
   * the bootstrap and pick it up on their next start.
   */
  onActiveProfileChange?:
    | ((next: import('@wrongstack/contracts/types').Config) => void)
    | undefined;
  /**
   * Optional accessor for the Chronicle metrics store. When wired, the
   * `/tool autothin candidates` and `apply` commands can read the
   * cross-session `tool_daily` rollup. Hosts that have not opened
   * Chronicle (e.g. the bare TUI) leave this undefined and the
   * in-process event-bridge Map is used as fallback.
   */
  getChronicle?:
    | (() => import('@wrongstack/core/chronicle').ChronicleMetricsStore | undefined)
    | undefined;
  /**
   * Optional accessor for the in-process per-tool usage Map populated by
   * `wireMetricsToEvents`. Used as the auto-thinning fallback when
   * Chronicle is unavailable.
   */
  getToolUsage?:
    | (() => import('@wrongstack/core/observability').ToolUsageSnapshot | undefined)
    | undefined;
  /** Models registry for looking up provider/model capabilities. */
  modelsRegistry?: import('@wrongstack/contracts/types').ModelsRegistry | undefined;
  /** Terminal reader for interactive user input (e.g. settings menu, auth menu). */
  reader: import('@wrongstack/contracts/types').InputReader;
  /** Read a secret without echoing it or recording it in input history. */
  readSecret?: ((prompt: string) => Promise<string>) | undefined;
  /** Read visible text through the owning interactive surface. */
  readText?: ((prompt: string) => Promise<string>) | undefined;
  /** Real boot-time vault used for secret-bearing config writes. */
  vault?: import('@wrongstack/contracts/types').SecretVault | undefined;
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
  shadowController?:
    | {
        /** id of the currently active Shadow Agent subagent, or null if none */
        activeId: string | null;
        /** Register a new shadow agent id. Throws if one is already active. */
        register(id: string): void;
        /** Clear the active shadow agent id (called on termination). */
        clear(): void;
        /** Read per-session defaults used by the next /shadow start. */
        getDefaults?:
          | (() => { intervalMs?: number; provider?: string; model?: string })
          | undefined;
        /** Update per-session defaults used by the next /shadow start. */
        setDefaults?:
          | ((defaults: { intervalMs?: number; provider?: string; model?: string }) => void)
          | undefined;
      }
    | undefined;
  /**
   * Shared provider/model status tracker. When set, the `/provider-status`
   * command can render live health information.
   */
  statusTracker?: import('@wrongstack/core/coordination').ProviderModelStatusTracker | undefined;
}
