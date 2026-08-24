import type { FleetChatVerbosity, TokenSavingTier } from '@wrongstack/core/types';

/**
 * Settings payload shared by `saveSettings` (persist) and `applyLiveSettings`
 * (apply to the running session). Mirrors the fields the TUI `/settings` picker
 * cycles with left/right.
 */
export interface LiveSettingsInput {
  mode?: 'off' | 'suggest' | 'auto' | undefined;
  delayMs?: number | undefined;
  titleAnimation?: boolean | undefined;
  yolo?: boolean | undefined;
  /** Fleet-chat verbosity (off | full). */
  fleetChatVerbosity?: FleetChatVerbosity | undefined;
  chime?: boolean | undefined;
  confirmExit?: boolean | undefined;
  nextPrediction?: boolean | undefined;
  featureMcp?: boolean | undefined;
  featurePlugins?: boolean | undefined;
  featureMemory?: boolean | undefined;
  featureSkills?: boolean | undefined;
  featureModelsRegistry?: boolean | undefined;
  featureTokenSaving?: TokenSavingTier | undefined;
  allowOutsideProjectRoot?: boolean | undefined;
  contextAutoCompact?: boolean | undefined;
  contextStrategy?: string | undefined;
  contextMode?: string | undefined;
  maxConcurrent?: number | undefined;
  logLevel?: string | undefined;
  auditLevel?: string | undefined;
  indexOnStart?: boolean | undefined;
  maxIterations?: number | undefined;
  autoProceedMaxIterations?: number | undefined;
  /** When true, file tools are confined to the project root. Default false. */
  restrictFsToRoot?: boolean | undefined;
  debugStream?: boolean | undefined;
  configScope?: 'global' | 'project' | undefined;
  enhanceDelayMs?: number | undefined;
  enhanceEnabled?: boolean | undefined;
  enhanceLanguage?: string | undefined;
  /** Mid-run send-mode picker (queue/btw/steer) toggle. Default on. */
  midRunSendPicker?: boolean | undefined;
  /** Skip the confirmation prompt for the TUI `!<command>` shell shortcut. */
  shellBangWarningDontShowAgain?: boolean | undefined;
  mouseMode?: boolean | undefined;
  autonomyNextPrompt?: string | undefined;
  /** Whether the process circuit breaker gates bash/exec. Default false. */
  breakerEnabled?: boolean | undefined;
  /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
  breakerAutoKillResetMs?: number | undefined;
  /** TUI statusline density. Defaults to minimum when unset. */
  statuslineMode?: 'minimum' | 'detailed' | undefined;
  /** Single word shown in the TUI rainbow working-state chip. */
  thinkingWord?: string | undefined;
  /** Animation style for the TUI working-state chip. */
  animationStyle?: 'rainbow' | 'wave' | 'pulse' | 'dots' | 'breathe' | 'cycle' | undefined;
  /** Provider-runtime reasoning mode. */
  reasoningMode?: 'auto' | 'on' | 'off' | undefined;
  /** Provider-runtime reasoning effort. */
  reasoningEffort?: string | undefined;
  /** Preserve thinking blocks across turns when supported. */
  reasoningPreserve?: boolean | undefined;
  /** Prompt-cache TTL, or default to clear the explicit override. */
  cacheTtl?: 'default' | '5m' | '1h' | undefined;
  /** Show "Model Reasoning" blocks in chat history. Default: true. */
  showModelReasoning?: boolean | undefined;
  /** Agent swarm panel placement: 'bottom' (lower region), 'sidebar' (right sidebar), or 'off' (hidden).
   * Backward-compat: legacy boolean values are coerced by the TUI settings adapter. Default: 'bottom'. */
  showAgentSwarmPanel?: 'bottom' | 'sidebar' | 'off' | boolean | undefined;
  /**
   * Per-panel position map (one entry per F-key panel id). Each value is
   * 'bottom' (F-key behavior) or 'sidebar' (right-sidebar twin). Persisted
   * as `autonomy.panelPositions` in the project/profile config. The TUI
   * auto-save hook passes a full PanelPositionMap (13 entries); the adapter
   * stores it as-is. Default: every panel 'bottom' when unset.
   */
  panelPositions?: Readonly<Record<string, 'bottom' | 'sidebar'>> | undefined;
  /** Show SAGE Memory Inject blocks in tool results. Default: false. */
  showSageMemoryInject?: boolean | undefined;
  /**
   * When true, the read tool includes codebase-index symbols alongside
   * file content. Persisted as `autonomy.readAdvancedMode`.
   */
  readSymbols?: boolean | undefined;
  /**
   * Register the leader's agent-callable `nextsteps` tool. Persisted to
   * `tools.nextsteps.enabled`; read at boot, so it applies next session.
   */
  nextStepsTool?: boolean | undefined;
  /** Minimum relation strength for SAGE memory injection. Default: 0.85. */
  sageMemoryInjectThreshold?: number | undefined;
  /**
   * WrongProxy / WrongTrace: master switch. When true AND the daemon at
   * `wrongProxyUrl` is reachable, every provider's base URL is rewritten
   * through `${wrongProxyUrl}/proxy/<host><path>`. openai-codex is
   * excluded by spec. Persisted to `tools.wrongProxy.enabled` (read at
   * boot, applied mid-session by `applyLiveSettings`).
   */
  wrongProxyEnabled?: boolean | undefined;
  /**
   * WrongProxy / WrongTrace URL. Default `http://localhost:8000`. The
   * CLI's periodic probe targets `<wrongProxyUrl>/api/health`; a 2xx
   * response flips the runtime's `active` flag.
   */
  wrongProxyUrl?: string | undefined;
}
