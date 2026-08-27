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
  log: { level: 'info' },
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
      // Off: task text searches for what the operator is doing, not for the
      // file the tool touched, and every match it adds is unrelated to the
      // result it lands on.
      taskAware: false,
      maxHintsPerTool: 8,
      maxCharsPerTool: 2800,
      maxTurnMemories: 8,
      maxCharsPerTurn: 2400,
      minScore: 0.72,
      minImportance: 0.5,
      // 0 = once per session. Re-showing a memory the model has already been
      // given spends context and adds nothing.
      repeatCooldownMs: 0,
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
  maxConcurrent: 4,
  // YOLO opt-in: users who want auto-approve behaviour set `yolo: true`.
  // Off by default so prompt injection in repository content, fetched
  // content, or mailbox messages cannot induce arbitrary shell calls or
  // write operations without human confirmation.
  yolo: false,
  nextPrediction: false,
  hints: true,
  debugStream: false,
  configScope: 'global',
  indexing: {
    onSessionStart: true,
    onEdit: true,
    watchExternal: true,
    debounceMs: 400,
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
    autoProceedMaxIterations: 50,
    autonomyNextPrompt: 'auto {{suggestion}}',
    terminalTitleAnimation: true,
    // Mirrored from the top-level yolo default so the autonomy subsystem
    // (which reads autonomy.yolo) stays consistent with config.yolo.
    yolo: false,
    fleetChatVerbosity: 'off',
    chime: false,
    confirmExit: true,
    mouseMode: false,
    enhance: true,
    enhanceDelayMs: 60_000,
    enhanceLanguage: 'original',
    // Product-wide statusline density default. Mirrored by the TUI's
    // DEFAULT_STATUSLINE_MODE (packages/tui/src/components/settings-picker-model.ts).
    statuslineMode: 'minimum',
    thinkingWord: DEFAULT_TUI_THINKING_WORD,
    showAgentSwarmPanel: 'bottom',
  },
  circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER_CONFIG },
  modelRuntime: {
    // `effort` is intentionally undefined by default. Leaving it unset lets
    // each model use its provider-recommended reasoning effort (or none at
    // all) instead of forcing an opinionated value that may be unsupported,
    // silently omitted, and surfaced as a per-request warning. Users who
    // want a specific effort can opt in via `/settings` or the WebUI panel.
    reasoning: { mode: 'auto' },
    cache: { ttl: '1h' },
  },
  systemPrompt: { variant: 'default' },
};
