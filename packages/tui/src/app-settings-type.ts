import type { FleetChatVerbosity, TokenSavingTier } from '@wrongstack/core/types';
import type {
  AgentSwarmPanelMode,
  CacheTtl,
  ContextMode,
  ReasoningEffort,
  StatuslineMode,
} from './settings-contracts.js';

export type { PanelId, PanelPosition, PanelPositionMap } from './ui-contracts.js';
export {
  coercePanelPositionMap,
  DEFAULT_PANEL_POSITIONS,
  PANEL_IDS,
} from './ui-contracts.js';
import type { PanelPositionMap } from './ui-contracts.js';

export type { AgentSwarmPanelMode } from './settings-contracts.js';

/**
 * Coerce a persisted showAgentSwarmPanel value (which may be a legacy boolean
 * or the new tri-state string) into a valid AgentSwarmPanelMode.
 * - true / undefined → 'bottom' (default)
 * - false → 'off'
 * - Valid string ('bottom' | 'sidebar' | 'off') → returned as-is
 * - Any other string → 'bottom' (safe fallback)
 *
 * This is the single canonical coercion — all read sites should call this
 * rather than re-implementing the mapping to avoid divergent defaults.
 */
export function coerceAgentSwarmMode(
  v: boolean | AgentSwarmPanelMode | string | undefined,
): AgentSwarmPanelMode {
  if (v === true || v === undefined) return 'bottom';
  if (v === false) return 'off';
  if (v === 'bottom' || v === 'sidebar' || v === 'off') return v;
  return 'bottom';
}

export type Settings = {
  mode: 'off' | 'suggest' | 'auto';
  delayMs: number;
  titleAnimation: boolean;
  yolo: boolean;
  /** Fleet-chat verbosity; wire name matches the CLI LiveSettingsInput. */
  fleetChatVerbosity: FleetChatVerbosity;
  chime: boolean;
  confirmExit: boolean;
  nextPrediction: boolean;
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  /** Token-saving tier: off | minimal | light | medium | aggressive. */
  featureTokenSaving: TokenSavingTier;
  /** Allow tools to access paths outside the project root. Default: true (open). */
  allowOutsideProjectRoot: boolean;
  contextAutoCompact: boolean;
  contextStrategy: 'hybrid' | 'intelligent' | 'selective';
  contextMode: ContextMode;
  maxConcurrent: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  auditLevel: 'minimal' | 'standard' | 'full';
  indexOnStart: boolean;
  /** Multi-file diff summary footer cutoff. 0 = off; positive = min file count. */
  multiDiffSummaryThreshold: number;
  lastSettingsField: number;
  maxIterations: number;
  /** Maximum auto-proceed iterations (0 = unlimited). */
  autoProceedMaxIterations: number;
  /** Prompt refinement preview countdown (ms). */
  enhanceDelayMs: number;
  /** Pre-refine grace period (seconds) before the refiner LLM call starts. 0 = skip. */
  preRefineSeconds: number;
  /** Enable/disable prompt refinement. */
  enhanceEnabled: boolean;
  /** Default language for refinement: original or english. */
  enhanceLanguage: 'original' | 'english';
  midRunSendPicker?: boolean | undefined;
  /** Raw SSE stream debugging — hex-dump every byte received from providers. */
  debugStream: boolean;
  /** Skip the confirmation prompt for the `!<command>` shell shortcut. */
  shellBangWarningDontShowAgain?: boolean | undefined;
  /** Statusline density mode. Defaults to minimum (DEFAULT_STATUSLINE_MODE). */
  statuslineMode: StatuslineMode;
  /** Reasoning mode: auto (provider default) | on | off. */
  reasoningMode: 'auto' | 'on' | 'off';
  /** Reasoning effort level. */
  reasoningEffort: ReasoningEffort;
  /** Preserve thinking across turns. */
  reasoningPreserve: boolean;
  /** Single word shown in the TUI rainbow working-state chip. */
  thinkingWord: string;
  showModelReasoning: boolean;
  /** Agent swarm panel placement: 'bottom' (lower region), 'sidebar' (right
   *  sidebar, vertical), or 'off' (hidden). Default: 'bottom'.
   *  Backward-compat: old boolean configs are coerced — true→'bottom', false→'off'. */
  showAgentSwarmPanel: AgentSwarmPanelMode;
  /**
   * Per-panel position map. Each F-key panel can be set to 'bottom' (F-key
   * behavior, the default) or 'sidebar' (rendered in the right sidebar).
   * The map is always normalized to a full PanelPositionMap at boot via
   * {@link coercePanelPositionMap}. Optional at the persisted-Settings
   * boundary so older configs without the key don't typecheck-fail; the
   * live-settings coercion always fills in a full map.
   */
  panelPositions?: Partial<PanelPositionMap>;
  /** Show SAGE Memory Inject chips in tool results. Default: true (compact). */
  showSageMemoryInject: boolean;
  /** Minimum relation strength for SAGE memory injection. Default: 0.85. */
  sageMemoryInjectThreshold: number;
  /** Register the leader's agent-callable `nextsteps` tool. Default: false. */
  nextStepsTool: boolean;
  /** Prompt cache TTL. */
  cacheTtl: CacheTtl;
  /** Where to persist settings: 'global' or 'project'. */
  configScope: 'global' | 'project';
  animationStyle: 'rainbow' | 'wave' | 'pulse' | 'dots' | 'breathe' | 'cycle';
  /** When true, read tool includes codebase-index symbols alongside file content. */
  readSymbols: boolean;
  /** Full mouse mode: in-app managed scroll + clickable UI (SGR tracking on). */
  mouseMode?: boolean | undefined;
  /**
   * Mouse tracking released to the terminal (`/mouse native`), restoring native
   * click-drag selection at the cost of in-app wheel scrolling. Outranks
   * {@link mouseMode}.
   */
  mouseNative?: boolean | undefined;
  /** Whether the process circuit breaker gates bash/exec. Default false (off). */
  breakerEnabled?: boolean | undefined;
  /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
  breakerAutoKillResetMs?: number | undefined;
  /**
   * WrongProxy / WrongTrace: master switch. When true AND the daemon at
   * `wrongProxyUrl` is reachable, every provider's base URL is rewritten
   * through `${wrongProxyUrl}/proxy/<host><path>`. openai-codex is
   * excluded by spec. Mirrors `SettingsPickerPatch.wrongProxyEnabled`.
   */
  wrongProxyEnabled?: boolean | undefined;
  /**
   * WrongProxy / WrongTrace URL. Default `http://localhost:8000`. Mirrors
   * `SettingsPickerPatch.wrongProxyUrl`.
   */
  wrongProxyUrl?: string | undefined;
};
