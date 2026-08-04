export interface ToolsConfig {
  defaultExecutionStrategy: 'parallel' | 'sequential' | 'smart';
  maxIterations: number;
  iterationTimeoutMs: number;
  /** Hard upper bound for a single tool call timeout. Defaults to 5 minutes. */
  maxToolTimeoutMs?: number | undefined;
  sessionTimeoutMs: number;
  perIterationOutputCapBytes: number;
  /**
   * Per-tool prose budget for the tool's top-level description and usage hint.
   * Missing entries default to "extend".
   */
  descriptionMode?: ToolDescriptionModeConfig | undefined;
  /**
   * Per-tool on-screen result rendering mode (terminal / WebUI / TUI).
   * Missing entries default to "extend". Independent of `descriptionMode`:
   * `/tool <name> result simple` toggles this without touching the
   * LLM-side description length.
   */
  resultRenderMode?: ToolResultRenderModeConfig | undefined;
  /**
   * Tool names to disable. Disabled tools are excluded from the tool registry
   * (`ToolRegistry.list()` / `get()`), so they do NOT appear in the system
   * prompt's "## Tool usage" block — reducing per-request token consumption.
   * Override per-session with `/tool enable <name>` or re-enable all via
   * `/tool enable-all`.
   */
  disabledTools?: string[] | undefined;
  /**
   * When true (default), the agent automatically extends its iteration
   * limit by 100 when hit. Set to false to require user confirmation.
   */
  autoExtendLimit?: boolean | undefined;
  /**
   * When true, file tools (read/write/edit/grep/glob/install) are confined to
   * the project root and `set_working_dir` may not leave it. Default: false —
   * tools may access paths outside the project root, still subject to each
   * tool's permission tier (writes/edits prompt for confirmation). Toggle via
   * `/settings` ("Filesystem access").
   */
  restrictToProjectRoot?: boolean | undefined;
  /**
   * Per-command policy for the `exec` tool's allowlist. The tool ships a
   * curated default allowlist of dev/build commands; this extends or trims it.
   *
   * SECURITY: `allow` EXPANDS what the agent may execute, so it is honored only
   * from the trusted active-profile config — the config loader
   * strips `tools.exec.allow` from the untrusted, repo-committed
   * `<project>/.wrongstack/config.json`. `deny` only ever REMOVES commands, so
   * it is honored from any source.
   */
  exec?: ExecToolConfig | undefined;
  /**
   * Agent-callable `council` tool: which panel profile it runs by default and
   * which extra lenses/profiles are available to it.
   *
   * Distinct from `brain.council`, which is the Brain's own decision tier —
   * that one is convened by the Brain on high-risk questions, this one is
   * invoked by the agent.
   *
   * SECURITY: in the in-project DENY list. A persona's `instruction` is
   * rendered into the voter SYSTEM prompt, and a profile seat may pin a
   * `providerId`/`model` — so a repo-committed config could otherwise inject
   * system-level instructions into every seat and reroute the calls to an
   * attacker-chosen provider. Only honoured from the active-profile config.
   */
  council?: CouncilToolConfig | undefined;
  /**
   * Agent-loop repetition detector tuning. The detector watches two signals:
   * consecutive effectively-identical iterations (same tool-name set + inputs
   * + text) and per-call repeats (the same tool invoked with identical
   * arguments N times within a sliding window, even when interleaved with
   * other calls). In the default `steer-then-cut` mode the first detection
   * folds a corrective note into the conversation and lets the run continue;
   * only persistent repetition cuts the turn. Omitted fields use built-in
   * defaults (see DEFAULT_TOOLS_CONFIG.loopDetection).
   */
  loopDetection?: LoopDetectionConfig | undefined;
}

/** Tuning for the agent-loop repetition detector (`tools.loopDetection`). */
export interface LoopDetectionConfig {
  /**
   * `steer-then-cut` (default): inject a corrective note at the steer
   * threshold, cut the turn only if repetition persists to the cut threshold.
   * `cut`: legacy behavior — hard-stop at the steer threshold, per-call
   * detector disabled. `off`: disable loop detection entirely.
   */
  mode?: 'steer-then-cut' | 'cut' | 'off' | undefined;
  /** Consecutive identical iterations before the detector acts (default 3, min 2). */
  steerThreshold?: number | undefined;
  /**
   * Consecutive identical iterations at which the turn is cut in
   * `steer-then-cut` mode (default steerThreshold + 2, min steerThreshold + 1).
   */
  cutThreshold?: number | undefined;
  /** Sliding window of recent tool calls for per-call repeat detection (default 12, min 4). */
  windowSize?: number | undefined;
  /**
   * Identical (name + canonicalized args) calls within the window that
   * trigger a steer note (default 4, min 2).
   */
  callRepeatThreshold?: number | undefined;
}

/**
 * Configuration for the agent-callable `council` tool.
 *
 * The Council orchestrator has always accepted custom persona and profile
 * registries, but no host ever built one — the tool was pinned to the three
 * built-in profiles with no way to add a lens, change the default panel, or
 * tune concurrency. This is that surface.
 */
export interface CouncilToolConfig {
  /**
   * Profile the tool runs when a call names none. Must be a built-in id
   * (`balanced`, `fast`, `risk-review`) or one defined in `profiles`.
   * Default `balanced`.
   */
  defaultProfile?: string | undefined;
  /** Seats polled concurrently, 1..8. Default 3. */
  maxConcurrency?: number | undefined;
  /**
   * Extra decision lenses, registered alongside the six built-ins. Each needs
   * a kebab-case `id`, a `name`, a `description` and the `instruction` that
   * becomes the seat's system prompt.
   */
  personas?: CouncilPersonaDefinition[] | undefined;
  /**
   * Extra panel profiles, registered alongside the built-ins. A profile whose
   * id matches a built-in replaces it.
   */
  profiles?: CouncilToolProfileDefinition[] | undefined;
}

/** A custom Council decision lens declared in configuration. */
export interface CouncilPersonaDefinition {
  /** Kebab-case identifier, e.g. "latency-hawk". */
  id: string;
  name: string;
  description: string;
  /** Trusted system-level instruction for this lens. */
  instruction: string;
  defaultWeight?: number | undefined;
  defaultVeto?: boolean | undefined;
  tags?: string[] | undefined;
}

/**
 * A custom Council panel declared in configuration.
 *
 * Structurally the config-facing half of `CouncilProfileConfig`; kept as its
 * own type so the config surface stays JSON-shaped (no readonly arrays) and
 * documents itself where users read it.
 */
export interface CouncilToolProfileDefinition {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  seats: Array<{
    id?: string | undefined;
    label?: string | undefined;
    /** Persona id — a built-in or one declared in `personas`. */
    persona: string;
    target?:
      | {
          providerId?: string | undefined;
          model?: string | undefined;
          /** Model-matrix role, resolved before the explicit target. */
          role?: string | undefined;
          fallbackProfile?: string | undefined;
          fallbackModels?: string[] | undefined;
        }
      | undefined;
    weight?: number | undefined;
    veto?: boolean | undefined;
  }>;
  /** `false` disables judging; omitted also means no judge. */
  judge?:
    | false
    | {
        providerId?: string | undefined;
        model?: string | undefined;
        role?: string | undefined;
        fallbackProfile?: string | undefined;
        fallbackModels?: string[] | undefined;
      }
    | undefined;
  quorumFraction?: number | undefined;
  approvalFraction?: number | undefined;
  distinctness?: 'none' | 'model' | 'provider' | undefined;
  voterMaxTokens?: number | undefined;
  judgeMaxTokens?: number | undefined;
  perCallTimeoutMs?: number | undefined;
  overallTimeoutMs?: number | undefined;
}

/** Allow/deny extension of the `exec` tool's built-in command allowlist. */
export interface ExecToolConfig {
  /**
   * Extra command names to add to the allowlist (e.g. `["make", "dotnet"]`).
   * Trusted sources only — stripped from in-project repo config.
   */
  allow?: string[] | undefined;
  /**
   * Command names to remove from the allowlist. Honored from any source —
   * removing a command can only narrow what runs, so it is always safe.
   */
  deny?: string[] | undefined;
  /**
   * Per-rule bypass for the heuristic danger detector. Each entry is a
   * stable `matchedRule` id (e.g. `rm-recursive`, `git-push-force`); a
   * matched rule whose id is in this list is suppressed.
   *
   * Use case: a project that legitimately runs `rm -rf ./build` on every
   * CI run can add `"rm-recursive"` to bypass so the detector stops
   * emitting banners for that one rule — without disabling it for every
   * other `rm -rf` invocation.
   *
   * **Trusted sources only.** Bypassing a danger rule means the user
   * agreed to a specific destructive pattern; in-project repo config
   * could otherwise be used to silently opt everyone in. The boot path
   * strips this field from `<project>/.wrongstack/config.json` the
   * same way it strips `allow`.
   */
  danger?: ExecDangerConfig | undefined;
}

export interface ExecDangerConfig {
  /**
   * List of danger rule ids to skip. Each id corresponds to a rule in
   * `@wrongstack/tools/src/_danger-detect.ts` (e.g. `rm-recursive`,
   * `git-push-force`, `inline-eval`, `sudo`). Unknown ids are ignored
   * (forward-compat: a rule added in a future version can be referenced
   * before the user upgrades).
   */
  bypass?: string[] | undefined;
}

export type ToolDescriptionMode = 'extend' | 'simple';
export type ToolDescriptionModeConfig = Record<string, ToolDescriptionMode | undefined>;

/**
 * Per-tool on-screen result rendering mode. Independent of
 * {@link ToolDescriptionMode}: `descriptionMode` controls the prose the
 * model sees in the system prompt, `resultRenderMode` controls how the
 * tool's RESULT is printed to the user (terminal / WebUI / TUI).
 *
 * - `simple` — meta only (filename, line count, exit code). Body is hidden
 *   by default; the user can still expand on demand where the renderer
 *   supports it.
 * - `extend` — full preview, up to 10 lines for read-like tools.
 *
 * The two modes are toggled independently via `/tool <name> desc simple`
 * and `/tool <name> result simple`. The legacy `/tool <name> simple`
 * command sets BOTH at once for backward compatibility.
 */
export type ToolResultRenderMode = 'extend' | 'simple';
export type ToolResultRenderModeConfig = Record<string, ToolResultRenderMode | undefined>;
