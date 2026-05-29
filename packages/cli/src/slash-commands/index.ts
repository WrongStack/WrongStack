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
  /** Resolved path helpers — use instead of constructing paths inline. */
  paths: WstackPaths;
  compactor?: {
    compact(ctx: Context, opts?: { aggressive?: boolean }): Promise<CompactReport>;
  };
  sessionStore?: SessionStore;
  skillLoader?: SkillLoader;
  tokenCounter: TokenCounter;
  renderer: Renderer;
  /** App-level EventBus — used by AutoPhaseRunner to emit phase/graph events to the TUI. */
  events: EventBus;
  memoryStore?: MemoryStore;
  context?: Context;
  /** Working directory for the current session. */
  cwd: string;
  /** Project root (typically resolved from cwd). */
  projectRoot: string;
  metricsSink?: MetricsSink;
  healthRegistry?: HealthRegistry;
  modeStore?: ModeStore;
  onExit?: () => void;
  onBeforeExit?: () => Promise<{ abort?: boolean; message?: string } | void>;
  onClear?: () => void;
  onDiag?: () => string;
  onStats?: () => string | null;
  /**
   * Generate a commit message by calling the LLM with the git diff.
   * Receives the raw diff, returns a commit message string.
   * When omitted /commit falls back to heuristics-only messages.
   */
  generateCommitMessage?: (diff: string) => Promise<string>;
  onSpawn?: (
    description: string,
    opts?: { provider?: string; model?: string; tools?: string[]; name?: string },
  ) => Promise<string>;
  onAgents?: (subagentId?: string) => string;
  onFleet?: (
    action: 'status' | 'usage' | 'kill' | 'manifest' | 'concurrency' | 'retry' | 'log',
    target?: string,
  ) => Promise<string>;
  /**
   * Get live coordinator status for /fleet. Returns null when no fleet is active.
   */
  onFleetStatus?: () => import('@wrongstack/core').CoordinatorStatus | null;
  /**
   * Get fleet usage summary for /fleet usage.
   */
  onFleetUsage?: () => import('@wrongstack/core').FleetUsage | null;
  /**
   * Kill all running subagents. Returns count of killed subagents.
   */
  onFleetKill?: () => number;
  /**
   * Terminate a specific subagent by id. Returns true if terminated.
   */
  onFleetTerminate?: (subagentId: string) => boolean;
  /**
   * Spawn a subagent of a given role. Returns the new subagent id.
   */
  onFleetSpawn?: (role: string) => Promise<string>;
  /**
   * Optional LLM classifier for `/fleet dispatch`. When wired, the smart
   * dispatcher uses it to resolve ambiguous routing decisions; without it the
   * dispatcher is heuristic-only. Built from the session provider in the host.
   */
  onDispatchClassify?: import('@wrongstack/core').DispatchClassifier;
  /**
   * Toggle subagent activity streaming into the leader's history. The
   * TUI installs the actual setter on mount via a shared controller;
   * before that, calls are buffered into the initial-value field so
   * `/fleet stream off` issued before mount still takes effect.
   */
  fleetStreamController?: {
    /** Current state, readable for the slash command's reply. */
    enabled: boolean;
    /** Replaced by the TUI on mount with a dispatch-backed setter. */
    setEnabled: (enabled: boolean) => void;
  };
  /**
   * Re-run interrupted tasks from a prior director-state.json. Pass `undefined`
   * to list them, a specific task id to retry one, or 'all' to retry every
   * interrupted task. Returns a human-readable summary. Only wired when
   * director mode is enabled.
   */
  onFleetRetry?: (taskId?: string) => Promise<string>;
  /**
   * Inspect per-subagent JSONL transcripts under `<fleetRoot>/subagents/`.
   * Pass `undefined` to list available transcripts, a subagent id to show
   * a compact event summary, or a subagent id with `mode='raw'` to dump
   * the full JSONL. Only wired when a fleet root exists for this session.
   */
  onFleetLog?: (subagentId: string | undefined, mode: 'summary' | 'raw') => Promise<string>;
  /** Promote to director mode at runtime. Returns success message or null on failure. */
  onDirector?: () => Promise<string | null>;
  /** Manage plugin config from the interactive slash menu. */
  onPlugin?: (args: string) => Promise<string>;
  /** Toggle or query YOLO mode at runtime. Pass undefined to query, boolean to set. */
  onYolo?: (setTo?: boolean) => boolean;
  /** Toggle or query autonomy mode. Pass undefined to query, AutonomyMode to set. */
  onAutonomy?: (setTo?: import('./autonomy.js').AutonomyMode) => import('./autonomy.js').AutonomyMode;
  /**
   * Access the (possibly null) eternal-autonomy engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal'.
   */
  getEternalEngine?: () => import('@wrongstack/core').EternalAutonomyEngine | null;
  /**
   * Access the (possibly null) parallel-eternal engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal-parallel'.
   */
  getParallelEngine?: () => import('@wrongstack/core').ParallelEternalEngine | null;
  /**
   * Start the eternal/parallel autonomy engine. Called after `/autonomy eternal`
   * or `/autonomy parallel` confirms a goal exists and YOLO has been forced on.
   * Pass the mode so the REPL knows which engine to construct and drive.
   */
  onEternalStart?: (mode?: import('./autonomy.js').AutonomyMode) => void;
  /** Stop the eternal/parallel autonomy engine (mid-iteration abort + flag flip). */
  onEternalStop?: () => void;
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
  planPath?: string;
  /** Direct access to the session's LLM provider and model, available even before the first agent run. */
  llmProvider?: import('@wrongstack/core').Provider;
  llmModel?: string;
  /** StatusBar visibility config — loaded from ~/.wrongstack/statusline.json */
  statuslineConfig?: {
    get: () => Promise<import('./statusline.js').StatuslineConfig>;
    set: (cfg: import('./statusline.js').StatuslineConfig) => Promise<void>;
  };
  /**
   * Current list of hidden status bar items. Written by the /statusline command
   * so the TUI can update without a restart.
   */
  statuslineHiddenItems?: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>;
  setStatuslineHiddenItems?: (items: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>) => void;
  /**
   * Controller for the agents monitor overlay. The TUI installs the actual
   * setter on mount via a shared controller; before that, calls are buffered
   * into the initial-value field so `/agents off` issued before mount still takes effect.
   */
  agentsMonitorController?: {
    /** Current state, readable for the slash command's reply. */
    visible: boolean;
    /** Replaced by the TUI on mount with a dispatch-backed setter. */
    setVisible: (visible: boolean) => void;
  };
  /** Manage MCP servers: add, remove, enable, disable, restart. */
  onMcp?: (args: string) => Promise<string>;
  /**
   * Fix a reported error or bug. Pass the error message or problem description.
   * Returns a structured diagnosis + fix plan, and sets up the next agent turn
   * with the appropriate skill (bug-hunter, typescript-strict, security-scanner).
   */
  onFix?: (errorText: string) => Promise<{ message?: string; runText?: string }>;
  /**
   * Start an SDD parallel fan-out run. Requires an active SDD session with
   * an approved spec and generated task graph.
   */
  onSddParallelRun?: (opts?: { parallelSlots?: number }) => Promise<string>;
  /** Stop the currently running SDD parallel fan-out. */
  onSddParallelStop?: () => void;
  /**
   * Start a real, LLM-driven AutoPhase run from a free-text goal. The host
   * plans phases (each holding many todos), persists the phase-graph as
   * per-project JSON, and drives the orchestrator — one subagent per task —
   * in the background. Returns the built graph or an error.
   */
  onAutoPhaseStart?: (opts: { goal: string; projectContext?: string }) => Promise<
    | { ok: true; graph: import('@wrongstack/core').PhaseGraph }
    | { ok: false; error: string }
  >;
  onAutoPhasePause?: () => void;
  onAutoPhaseResume?: () => void;
  onAutoPhaseStop?: () => void;
  /** Live, read-only view of the running AutoPhase (null when idle). */
  getAutoPhaseRunner?: () => {
    graph: import('@wrongstack/core').PhaseGraph;
    getProgress: () => import('@wrongstack/core').PhaseProgress | null;
    isRunning: () => boolean;
  } | null;
}

// Re-export helpers for external consumers (pre-launch.ts)
export type { ProjectFacts } from './helpers.js';
export { detectProjectFacts, renderAgentsTemplate } from './helpers.js';

import { buildClearCommand } from './clear.js';
import {
  buildCommitCommand,
  buildGitcheckCommand,
  buildPushCommand,
} from './commit.js';
import { buildCompactCommand } from './compact.js';
import { buildContextCommand } from './context.js';
import { buildDiagCommand, buildStatsCommand } from './diag-stats.js';
import { buildFleetCommand } from './fleet.js';
import { buildHealthCommand } from './health.js';
import { buildHelpCommand } from './help.js';
import { buildInitCommand } from './init.js';
import { buildMcpSlashCommand } from './mcp.js';
import { buildMemoryCommand } from './memory.js';
import { buildMetricsCommand } from './metrics.js';
import { buildPlanCommand } from './plan.js';
import { buildPluginCommand } from './plugin.js';
import { buildExitCommand, buildLoadCommand, buildSaveCommand } from './session.js';
import { buildSkillCommand } from './skill.js';
import { buildAgentsCommand, buildDirectorCommand, buildSpawnCommand } from './spawn-agents.js';
import { buildTodosCommand } from './todos.js';
import { buildToolsCommand } from './tools.js';
import { buildYoloCommand } from './yolo.js';
import { buildAutonomyCommand } from './autonomy.js';
import { buildBtwCommand } from './btw.js';
import { buildGoalCommand } from './goal.js';
import { buildModeCommand } from './mode.js';
import { buildSddCommand } from './sdd.js';
import { buildSkillGeneratorCommand } from './skill-generator.js';
import { buildSecurityCommand } from './security.js';
import { buildStatuslineCommand } from './statusline.js';
import { buildFixCommand } from './fix.js';
import {
  buildSkillInstallCommand,
  buildSkillUpdateCommand,
  buildSkillUninstallCommand,
} from './skill-install.js';
import { buildAutoPhaseCommand } from './autophase.js';

export function buildBuiltinSlashCommands(opts: SlashCommandContext): SlashCommand[] {
  return [
    buildHelpCommand(opts),
    buildInitCommand(opts),
    buildClearCommand(opts),
    buildCompactCommand(opts),
    buildContextCommand(opts),
    buildToolsCommand(opts),
    buildSkillCommand(opts),
    buildSkillGeneratorCommand(opts),
    buildSkillInstallCommand(opts),
    buildSkillUpdateCommand(opts),
    buildSkillUninstallCommand(opts),
    buildPluginCommand(opts),
    buildMcpSlashCommand(opts),
    buildDiagCommand(opts),
    buildStatsCommand(opts),
    buildSpawnCommand(opts),
    buildAgentsCommand(opts),
    buildDirectorCommand(opts),
    buildFleetCommand(opts),
    buildMetricsCommand(opts),
    buildHealthCommand(opts),
    buildMemoryCommand(opts),
    buildTodosCommand(opts),
    buildPlanCommand(opts),
    buildSddCommand(opts),
    buildSaveCommand(opts),
    buildLoadCommand(opts),
    buildYoloCommand(opts),
    buildAutonomyCommand(opts),
    buildGoalCommand(opts),
    buildBtwCommand(opts),
    buildModeCommand(opts),
    buildExitCommand(opts),
    buildCommitCommand(opts),
    buildGitcheckCommand(opts),
    buildPushCommand(opts),
    buildSecurityCommand(opts),
    buildFixCommand(opts),
    buildAutoPhaseCommand(opts),
    buildStatuslineCommand({
      cwd: opts.cwd,
      hiddenItems: opts.statuslineHiddenItems ?? [],
      setHiddenItems: opts.setStatuslineHiddenItems ?? (() => {}),
      getConfig: opts.statuslineConfig?.get ?? (async () => ({})),
      setConfig: opts.statuslineConfig?.set ?? (async () => {}),
    }),
  ];
}