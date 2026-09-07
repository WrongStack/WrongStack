import { type Config, DEFAULT_TUI_THINKING_WORD } from '../../types/config.js';
import { DEFAULT_CONTEXT_WINDOW_MODE_ID } from '../../types/context-window.js';
import {
  DEFAULT_AUTONOMY_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_SESSION_LOGGING_CONFIG,
  DEFAULT_TOOLS_CONFIG,
} from '../../types/default-config.js';

/**
 * Defaults express *behavior*, not identity. Provider and model are NOT
 * hardcoded — they must be resolved at runtime from config + env + the
 * ModelsRegistry. A bare Config returned by this loader will throw when
 * the agent tries to construct a provider, with a message that points
 * users at `wstack init`.
 */
export const CONFIG_BEHAVIOR_DEFAULTS: Omit<Config, 'provider' | 'model'> = {
  version: 1,
  context: {
    mode: DEFAULT_CONTEXT_WINDOW_MODE_ID,
    warnThreshold: DEFAULT_CONTEXT_CONFIG.warnThreshold,
    softThreshold: DEFAULT_CONTEXT_CONFIG.softThreshold,
    hardThreshold: DEFAULT_CONTEXT_CONFIG.hardThreshold,
    targetLoad: DEFAULT_CONTEXT_CONFIG.targetLoad,
    autoCompact: true,
    preserveK: DEFAULT_CONTEXT_CONFIG.preserveK,
    eliseThreshold: DEFAULT_CONTEXT_CONFIG.eliseThreshold,
    strategy: 'hybrid',
  },
  tools: {
    defaultExecutionStrategy: DEFAULT_TOOLS_CONFIG.defaultExecutionStrategy,
    maxIterations: DEFAULT_TOOLS_CONFIG.maxIterations,
    iterationTimeoutMs: DEFAULT_TOOLS_CONFIG.iterationTimeoutMs,
    maxToolTimeoutMs: DEFAULT_TOOLS_CONFIG.maxToolTimeoutMs,
    sessionTimeoutMs: DEFAULT_TOOLS_CONFIG.sessionTimeoutMs,
    perIterationOutputCapBytes: DEFAULT_TOOLS_CONFIG.perIterationOutputCapBytes,
    descriptionMode: DEFAULT_TOOLS_CONFIG.descriptionMode,
    disabledTools: DEFAULT_TOOLS_CONFIG.disabledTools as string[],
    autoExtendLimit: DEFAULT_TOOLS_CONFIG.autoExtendLimit,
    restrictToProjectRoot: DEFAULT_TOOLS_CONFIG.restrictToProjectRoot,
    kanbanGovernance: DEFAULT_TOOLS_CONFIG.kanbanGovernance,
    loopDetection: DEFAULT_TOOLS_CONFIG.loopDetection,
    autoThin: { ...DEFAULT_TOOLS_CONFIG.autoThin },
  },
  log: { level: 'warn' },
  features: {
    mcp: true,
    plugins: true,
    memory: true,
    modelsRegistry: true,
    skills: true,
    prompts: true,
    // 'auto' → resolveTokenSavingTier picks a concrete tier from the model's
    // context window ONCE per session (cache-safe): lean prompt on small
    // windows (<32k medium, <128k light) where the fixed identity+tool prose
    // is a big fraction; minimal trimming on >=128k so modern large-window
    // models still get cost savings without capability loss. Explicit tiers
    // are respected verbatim.
    tokenSavingMode: 'auto',
    // Derived, never written by hand: this and `tools.restrictToProjectRoot`
    // (line 41) are the two halves of one switch, and they used to be declared
    // independently in this same object — one `true`, one `true` — with
    // session.ts resolving the contradiction via `??` in favour of the
    // permissive half. The confinement guard therefore shipped disabled on a
    // fresh install even though the other half asked for it (WS-075).
    allowOutsideProjectRoot: !DEFAULT_TOOLS_CONFIG.restrictToProjectRoot,
  },
  Sage: {
    enabled: true,
    storage: {
      projectLocal: true,
      directory: '.wrongstack/memories',
    },
    inject: {
      // Keep the ordinary turn prompt clean. Project memory is surfaced
      // on-demand beside relevant tool results, where the path/query that
      // caused retrieval is known and the hint can be independently capped.
      turnContext: false,
      toolResults: true,
      // Task-aware retrieval ON (owner default, profiles/default 2026-09-06).
      taskAware: true,
      maxHintsPerTool: 8,
      maxCharsPerTool: 2800,
      maxTurnMemories: 8,
      maxCharsPerTurn: 2400,
      minScore: 0.65,
      minImportance: 0.5,
      // Re-show a memory after a 30-minute cooldown instead of once per
      // session (owner default) — long autonomous sessions benefit from
      // periodic re-surfacing at a bounded context cost.
      repeatCooldownMs: 1_800_000,
      relationFloor: 0.9,
    },
    hygiene: {
      autoAfterSession: true,
      autoOnFileChange: true,
      retentionDays: 90,
      archiveLowConfidenceAfterDays: 30,
    },
    embeddings: {
      enabled: false,
    },
  },
  skills: { readClaudeSkills: true, mode: 'progressive' },
  mcpServers: {},
  fallbackAuto: true,
  maxConcurrent: 10,
  // YOLO is ON by default (owner product decision, 2026-09-06 — mirrors
  // profiles/default). Trade-off accepted: auto-approve is the shipped
  // experience; prompt-injection defenses remain the loop detector, the
  // permission surfaces, and /settings yolo off for users who want manual
  // confirmation of shell/write operations.
  yolo: true,
  nextPrediction: true,
  hints: true,
  debugStream: true,
  configScope: 'global',
  indexing: {
    onSessionStart: true,
    onEdit: true,
    watchExternal: true,
    debounceMs: 400,
    // The concept layer is the only part of indexing that spends money, so it
    // stays opt-in: `/codebase-map --enrich` after turning this on.
    concepts: { enabled: false, concurrency: 5, subsystems: true },
    // Needs the optional transformers runtime and a model download.
    embeddings: { enabled: false, batchSize: 16 },
    // On by default: it costs a few hundred tokens once per session, rides
    // the live-context tail so it does not disturb the prompt cache, and
    // contributes nothing at all when the index has not been built.
    atlas: { injectOnSessionStart: true, briefMaxTokens: 800 },
  },
  session: { ...DEFAULT_SESSION_LOGGING_CONFIG },
  autonomy: {
    // 'auto' by default: the agent self-drives (picks the top next-step after
    // each turn). This is a startup default, not a runtime flip — the
    // autoProceedMaxIterations cap + autoProceedDelayMs cooldown + Ctrl+C /
    // [GOAL_COMPLETE] stops remain in force. Explicit 'off'
    // in a config file is preserved (opt-out respected).
    defaultMode: 'auto',
    autoProceedDelayMs: DEFAULT_AUTONOMY_CONFIG.autoProceedDelayMs,
    // 0 = unlimited: auto-proceed keeps going until the user stops it
    // (Ctrl+C / [GOAL_COMPLETE] / loop guard), matching tools.maxIterations.
    autoProceedMaxIterations: 0,
    autonomyNextPrompt: 'auto {{suggestion}}',
    terminalTitleAnimation: true,
    // Mirrored from the top-level yolo default so the autonomy subsystem
    // (which reads autonomy.yolo) stays consistent with config.yolo.
    yolo: true,
    fleetChatVerbosity: 'off',
    chime: true,
    confirmExit: true,
    mouseMode: false,
    enhance: true,
    enhanceDelayMs: 15_000,
    enhanceLanguage: 'english',
    // Product-wide statusline density default. Mirrored by the TUI's
    // DEFAULT_STATUSLINE_MODE (packages/tui/src/components/settings-picker-model.ts).
    statuslineMode: 'minimum',
    thinkingWord: DEFAULT_TUI_THINKING_WORD,
    showAgentSwarmPanel: 'bottom',
    showModelReasoning: false,
  },
  circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER_CONFIG },
  modelRuntime: {
    // Owner default (profiles/default 2026-09-06): explicit medium effort,
    // no thinking preservation. Sent only to models advertising the
    // capability flags; `mode: 'auto'` keeps provider defaults for the rest.
    reasoning: { mode: 'auto', effort: 'medium', preserve: false },
    cache: { ttl: '1h' },
  },
  systemPrompt: { variant: 'pro' },
};
