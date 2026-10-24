/** Fleet and subagent hooks: spawn, monitor, budget, kill, retry and logs. */
export interface SlashFleetCommandContext {
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
      fallbackModels?: string[] | undefined;
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
      /**
       * Free-form task context propagated into the spawned `TaskSpec.context`.
       * Used by `/kanban task dispatch` to carry `{ kanban: { boardId, taskId } }`
       * so the tool-runtime boundary gate (`evaluateToolKanbanBoundary`) can
       * resolve the live policy instead of failing open.
       */
      context?:
        | {
            kanban?: { boardId?: string; taskId?: string; projectRoot?: string };
          }
        | undefined;
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
      fallbackModels?: string[] | undefined;
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
      /**
       * Free-form task context propagated into the spawned `TaskSpec.context`.
       * Used by `/kanban task dispatch` to carry `{ kanban: { boardId, taskId } }`
       * so the tool-runtime boundary gate (`evaluateToolKanbanBoundary`) can
       * resolve the live policy instead of failing open.
       */
      context?:
        | {
            kanban?: { boardId?: string; taskId?: string; projectRoot?: string };
          }
        | undefined;
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
  onFleetStatus?:
    | (() => import('@wrongstack/contracts/types').CoordinatorStatus | null)
    | undefined;
  /**
   * Read-only concurrency + lifetime spawn budget for `/fleet status`.
   * Returns null when no fleet host is available.
   */
  onFleetBudget?:
    | (() => {
        maxConcurrent: number;
        activeAgents: number;
        maxSpawns: number;
        usedSpawns: number;
        remainingSpawns: number;
        maxTokens?: number | undefined;
        usedTokens?: number | undefined;
        remainingTokens?: number | undefined;
        maxCostUsd?: number | undefined;
        usedCostUsd?: number | undefined;
        remainingCostUsd?: number | undefined;
        checkpointMaxSpawns?: number | undefined;
        ceilingMismatch?: boolean | undefined;
      } | null)
    | undefined;
  /**
   * Get fleet usage summary for /fleet usage.
   */
  onFleetUsage?: (() => import('@wrongstack/core/coordination').FleetUsage | null) | undefined;
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
        /**
         * Report whether an operation (leader run, autonomy loop, or SDD run)
         * is currently in flight. Used by `/clear` to confirm before wiping a
         * session that still has active work. Absent → treated as idle.
         */
        isRunning?: (() => boolean) | undefined;
        /**
         * Ask the owning interactive surface to confirm a destructive clear.
         * The TUI installs a panel-backed implementation; plain terminals
         * fall back to the generic `confirm` callback below.
         */
        confirmClear?:
          | ((info: { leaderActive: boolean; subagentCount: number }) => Promise<boolean>)
          | undefined;
        /** Render a generic slash-command confirmation in the owning surface. */
        confirmSlash?:
          | ((question: string, defaultYes: boolean) => Promise<boolean | null>)
          | undefined;
        /** Drop buffered output that belongs to the session being cleared. */
        resetSession?: (() => void) | undefined;
        /** Wait until the aborted leader turn can no longer mutate context. */
        waitForIdle?: (() => Promise<void>) | undefined;
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
  onDispatchClassify?: import('@wrongstack/core/coordination').DispatchClassifier | undefined;
  /**
   * Toggle subagent activity streaming into the leader's history. The
   * TUI installs the actual setter on mount via a shared controller;
   * before that, calls are buffered into the initial-value field so
   * `/fleet stream off` issued before mount still takes effect.
   */
  fleetStreamController?:
    | {
        /** Fleet-chat verbosity (off | compact | full). */
        mode: import('@wrongstack/contracts/types').FleetChatVerbosity;
        /** Replaced by the TUI on mount with a dispatch-backed setter. */
        setMode: (mode: import('@wrongstack/contracts/types').FleetChatVerbosity) => void;
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
}
