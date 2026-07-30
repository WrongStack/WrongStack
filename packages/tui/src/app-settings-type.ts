import type { FleetChatVerbosity, TokenSavingTier } from '@wrongstack/core/types';
import type {
  CacheTtl,
  ContextMode,
  ReasoningEffort,
  StatuslineMode,
} from './settings-contracts.js';

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
  /** Statusline density mode. Defaults to detailed. */
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
  /** Show the persistent AGENT SWARM and todo mission queue panel. Default: true. */
  showAgentSwarmPanel: boolean;
  /** Show SAGE Memory Inject blocks in tool results. Default: false (hidden). */
  showSageMemoryInject: boolean;
  /** Minimum relation strength for SAGE memory injection. Default: 0.85. */
  sageMemoryInjectThreshold: number;
  /** Prompt cache TTL. */
  cacheTtl: CacheTtl;
  /** Where to persist settings: 'global' or 'project'. */
  configScope: 'global' | 'project';
  animationStyle: 'rainbow' | 'wave' | 'pulse' | 'dots' | 'breathe' | 'cycle';
  /** When true, read tool includes codebase-index symbols alongside file content. */
  readSymbols: boolean;
  /** Full mouse mode: in-app managed scroll + clickable UI (SGR tracking on). */
  mouseMode?: boolean | undefined;
  /** Whether the process circuit breaker gates bash/exec. Default false (off). */
  breakerEnabled?: boolean | undefined;
  /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
  breakerAutoKillResetMs?: number | undefined;
};
