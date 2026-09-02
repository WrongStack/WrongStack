import type { ReasoningEffort as CoreReasoningEffort } from '@wrongstack/core/types';

export type SettingsMode = 'off' | 'suggest' | 'auto';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type AuditLevel = 'minimal' | 'standard' | 'full';
export type CompactorStrategy = 'hybrid' | 'intelligent' | 'selective';
export type ContextMode = 'balanced' | 'frugal' | 'deep';
export type StatuslineMode = 'minimum' | 'detailed' | 'no-color';
export type ReasoningMode = 'auto' | 'on' | 'off';
/**
 * Reasoning effort levels. Re-exported from core's canonical union instead of
 * re-declared here: this file is a sync point consumed by app-state,
 * app-action-type, and app-settings-type, so a hand-maintained copy could
 * silently drift from what the runtime resolver accepts. Adding a level in
 * core flows through automatically; nothing in the TUI needs updating.
 */
export type ReasoningEffort = CoreReasoningEffort;
export type CacheTtl = 'default' | '5m' | '1h';
export type EnhanceLanguage = 'original' | 'english';
export type TokenSavingTierTui = 'auto' | 'off' | 'minimal' | 'light' | 'medium' | 'aggressive';
export type FleetChatVerbosityTui = 'off' | 'full';
export type ConfigScope = 'global' | 'project';
export type AnimationStyleChoice =
  | 'rainbow'
  | 'wave'
  | 'pulse'
  | 'dots'
  | 'breathe'
  | 'static'
  | 'cycle';

/** Where to render the agent swarm panel: lower region, sidebar, or hidden. */
export type AgentSwarmPanelMode = 'bottom' | 'sidebar' | 'off';

export type SettingsPickerPatch = Partial<{
  mode: SettingsMode;
  delayMs: number;
  titleAnimation: boolean;
  yolo: boolean;
  fleetChat: FleetChatVerbosityTui;
  chime: boolean;
  confirmExit: boolean;
  nextPrediction: boolean;
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  tokenSavingTier: TokenSavingTierTui;
  allowOutsideProjectRoot: boolean;
  contextAutoCompact: boolean;
  contextStrategy: CompactorStrategy;
  contextMode: ContextMode;
  maxConcurrent: number;
  logLevel: LogLevel;
  auditLevel: AuditLevel;
  indexOnStart: boolean;
  multiDiffSummaryThreshold: number;
  maxIterations: number;
  autoProceedMaxIterations: number;
  enhanceDelayMs: number;
  preRefineSeconds: number;
  enhanceEnabled: boolean;
  enhanceLanguage: EnhanceLanguage;
  debugStream: boolean;
  statuslineMode: StatuslineMode;
  reasoningMode: ReasoningMode;
  reasoningEffort: ReasoningEffort;
  reasoningPreserve: boolean;
  thinkingWord: string;
  cacheTtl: CacheTtl;
  configScope: ConfigScope;
  animationStyle: AnimationStyleChoice;
  breakerEnabled: boolean;
  breakerAutoKillResetMs: number;
  showModelReasoning: boolean;
  showAgentSwarmPanel: AgentSwarmPanelMode;
  showSidebar: boolean;
  /**
   * Per-panel position map (one entry per F-key panel id). Each value is
   * 'bottom' (F-key behavior) or 'sidebar' (right-sidebar twin). Callers
   * (resolveSettingsFieldValue, buildResetPatch) emit single-key partial
   * spreads — the settingsValueSet reducer deep-merges them so unrelated
   * panels survive. The type is `Partial<PanelPositionMap>` to reflect
   * that callers are not required to provide every entry.
   */
  panelPositions?: Partial<import('./ui-contracts.js').PanelPositionMap>;
  /**
   * When true, the read tool includes codebase-index symbols alongside
   * file content. Toggle via `/settings read-symbols on|off`.
   */
  readSymbols: boolean;
  /** Show SAGE Memory Inject blocks in tool results. Default: false. */
  showSageMemoryInject: boolean;
  /** Minimum relation strength for SAGE memory injection. Default: 0.85. */
  sageMemoryInjectThreshold: number;
  /**
   * Register the agent-callable `nextsteps` tool for the leader, alongside the
   * `<nextsteps>` block it can already write. Persisted to
   * `tools.nextsteps.enabled`; the registry is built at boot, so a change takes
   * effect in the next session. Default: false.
   */
  nextStepsTool: boolean;
  /**
   * WrongProxy / WrongTrace: master switch. When true AND the daemon at
   * `wrongProxyUrl` is reachable, every provider's base URL is rewritten
   * through `${wrongProxyUrl}/proxy/<host><path>`. openai-codex is
   * excluded by spec. Persisted to `config.features.wrongProxy*`
   * via the TUI settings adapter; CLI proxy-wiring module reacts.
   */
  wrongProxyEnabled: boolean;
  /**
   * WrongProxy / WrongTrace URL. Default `http://localhost:3444`. The
   * CLI's periodic probe targets `<wrongProxyUrl>/api/health`; a 2xx
   * response flips the runtime's `active` flag.
   */
  wrongProxyUrl: string;
}>;
