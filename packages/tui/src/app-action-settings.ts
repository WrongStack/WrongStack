import type { FleetChatVerbosity, TokenSavingTier } from '@wrongstack/contracts/types';
import type {
  StatuslineDensities,
  StatuslineDensity,
  StatuslineLine,
  StatuslineLines,
  StatuslineOrder,
} from '@wrongstack/core/statusline';
import type { State } from './app-state.js';
import type {
  AuthCatalogRow,
  AuthConfirmAction,
  AuthFormFieldId,
  AuthFormState,
  AuthLocalPresetRow,
  AuthPanelView,
  AuthProviderRow,
} from './auth-panel-model.js';
import type { BrainLogEntry, BrainRiskLevel } from './brain-contracts.js';
import type { BrainPanelSettings } from './brain-panel-model.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import type {
  AuditLevel,
  CacheTtl,
  CompactorStrategy,
  ContextMode,
  LogLevel,
  ReasoningEffort,
  SettingsMode,
  SettingsPickerPatch,
  StatuslineMode,
  ToolResultViewMode,
} from './settings-contracts.js';
import type { ChipMeta, SubagentLaneView, SubagentRoleView } from './ui-contracts.js';
export type AppActionSettings =
  | {
      type: 'brainStatus';
      state: State['brain']['state'];
      source?: string | undefined;
      risk?: State['brain']['risk'] | undefined;
      summary?: string | undefined;
    }
  | { type: 'brainPromptSet'; prompt: NonNullable<State['brainPrompt']> }
  | { type: 'brainPromptClear' }
  | {
      type: 'subagentModelsOpen';
      lanes: SubagentLaneView[];
      roles: SubagentRoleView[];
      enabled: boolean;
      lock: boolean;
      followSessionModel: boolean;
      sessionTarget: string;
    }
  | { type: 'subagentModelsClose' }
  | { type: 'subagentModelsMove'; delta: number }
  | {
      type: 'subagentModelsUpdate';
      lanes: SubagentLaneView[];
      roles: SubagentRoleView[];
      enabled: boolean;
      lock: boolean;
      followSessionModel: boolean;
      sessionTarget: string;
    }
  | { type: 'subagentModelsHint'; text?: string | undefined }
  | { type: 'themePickerOpen'; selected?: number }
  | { type: 'themePickerClose' }
  | { type: 'themePickerMove'; delta: number }
  | { type: 'themePickerHint'; text?: string | undefined }
  | { type: 'themePickerFilter'; text: string }
  | { type: 'themePickerFilterMode'; on: boolean }
  | { type: 'themePickerPreview'; on: boolean }
  | { type: 'themePickerUndo' }
  | { type: 'themePickerSwapPrevious' }
  | {
      type: 'settingsOpen';
      mode: SettingsMode;
      delayMs: number;
      titleAnimation: boolean;
      yolo: boolean;
      fleetChat: FleetChatVerbosity;
      chime: boolean;
      confirmExit: boolean;
      nextPrediction: boolean;
      featureMcp: boolean;
      featurePlugins: boolean;
      featureMemory: boolean;
      featureSkills: boolean;
      featureModelsRegistry: boolean;
      featureToolCoach: boolean;
      tokenSavingTier: TokenSavingTier;
      allowOutsideProjectRoot: boolean;
      contextAutoCompact: boolean;
      contextStrategy: CompactorStrategy;
      contextMode: ContextMode;
      maxConcurrent: number;
      logLevel: LogLevel;
      auditLevel: AuditLevel;
      indexOnStart: boolean;
      multiDiffSummaryThreshold: number;
      /**
       * Animation style for the working/thinking chip in the status bar.
       * One of the renderable styles plus the meta-mode `'cycle'`. Persisted
       * to disk on every ←/→ change in `/settings`.
       */
      animationStyle: 'rainbow' | 'wave' | 'pulse' | 'dots' | 'breathe' | 'static' | 'cycle';
      /**
       * Persisted row index for where to land when the picker reopens.
       * See `Settings.lastSettingsField`.
       */
      lastSettingsField: number;
      maxIterations: number;
      autoProceedMaxIterations: number;
      enhanceDelayMs: number;
      enhanceEnabled: boolean;
      enhanceLanguage: 'original' | 'english';
      debugStream: boolean;
      statuslineMode: StatuslineMode;
      reasoningMode: 'auto' | 'on' | 'off';
      reasoningEffort: ReasoningEffort;
      /** Documented effort levels of the active model (absent = undocumented). */
      reasoningEffortLevels?: string[] | undefined;
      reasoningPreserve: boolean;
      thinkingWord: string;
      cacheTtl: CacheTtl;
      configScope: 'global' | 'project';
      breakerEnabled: boolean;
      breakerAutoKillResetMs: number;
      showModelReasoning: boolean;
      toolResultViewMode: ToolResultViewMode;
      selectionMode?: 'block' | 'text' | undefined;
      showAgentSwarmPanel: import('./app-settings-type.js').AgentSwarmPanelMode;
      showSidebar?: boolean | undefined;
      panelPositions: import('./ui-contracts.js').PanelPositionMap;
      readSymbols: boolean;
      showSageMemoryInject: boolean;
      sageMemoryInjectThreshold: number;
      nextStepsTool: boolean;
      nextStepsRequired: boolean;
      rememberStartupChoices: boolean;
      nextSystemPromptVariant: 'lite' | 'default' | 'pro' | 'scout';
      /**
       * WrongProxy / WrongTrace: master switch + configurable URL
       * (default http://localhost:3444). Mirrors `Settings.wrongProxy*`
       * and `SettingsPickerPatch.wrongProxy*`. Both fields land in
       * the Integrations section of the picker; the runtime probe
       * reads the values via the TUI settings adapter (see
       * `packages/cli/boot/tui-settings-adapter.ts`).
       */
      wrongProxyEnabled: boolean;
      wrongProxyUrl: string;
    }
  | { type: 'settingsClose' }
  | { type: 'settingsFieldMove'; delta: number }
  | { type: 'settingsFieldSet'; field: number }
  | { type: 'settingsValueChange'; delta: number }
  | { type: 'settingsValueSet'; patch: SettingsPickerPatch }
  | { type: 'settingsFilterSet'; filter: string }
  | { type: 'settingsHint'; text?: string | undefined }
  | { type: 'settingsThinkingEditStart' }
  | { type: 'settingsThinkingEditChange'; draft: string }
  | { type: 'settingsThinkingEditCommit' }
  | { type: 'settingsThinkingEditCancel' }
  | { type: 'settingsWrongProxyUrlEditStart' }
  | { type: 'settingsWrongProxyUrlEditChange'; draft: string }
  | { type: 'settingsWrongProxyUrlEditCommit' }
  | { type: 'settingsWrongProxyUrlEditCancel' }
  | {
      type: 'statuslineOpen';
      hiddenItems: StatuslineItem[];
      lines?: StatuslineLines | undefined;
      densities?: StatuslineDensities | undefined;
      order?: StatuslineOrder | undefined;
    }
  | { type: 'statuslineClose' }
  | { type: 'statuslineFieldMove'; delta: number }
  | { type: 'statuslineFieldSet'; field: number }
  | { type: 'statuslineToggle'; item: StatuslineItem }
  | { type: 'statuslineSetLine'; item: StatuslineItem; line: StatuslineLine }
  | { type: 'statuslineMoveLine'; item: StatuslineItem; delta: number }
  | { type: 'statuslineMoveOrder'; item: StatuslineItem; delta: number }
  | { type: 'statuslineSetDensity'; item: StatuslineItem; density?: StatuslineDensity | undefined }
  | { type: 'statuslineToggleLine'; line: StatuslineLine }
  | { type: 'statuslineResetLayout' }
  | { type: 'statuslineFilter'; text?: string | undefined; filtering?: boolean | undefined }
  | { type: 'statuslineHint'; text?: string | undefined }
  | { type: 'statuslineChipShow'; key: StatuslineItem; expiresIn?: number }
  | { type: 'statuslineChipExpire'; key: StatuslineItem }
  | { type: 'statuslineVisibleChipsSync'; visibleChips: ChipMeta[] }
  | {
      type: 'brainOpen';
      riskLevel: BrainRiskLevel;
      log: BrainLogEntry[];
      settings?: BrainPanelSettings | undefined;
    }
  | { type: 'brainClose' }
  | { type: 'brainMove'; delta: number }
  | { type: 'brainRiskChange'; delta: number }
  | { type: 'brainSetLog'; log: BrainLogEntry[] }
  | { type: 'brainHint'; text?: string | undefined }
  | { type: 'brainSettingsLoaded'; settings: BrainPanelSettings }
  | { type: 'brainView'; view: 'settings' | 'log' }
  | { type: 'brainRowMove'; delta: number }
  | { type: 'brainBusy'; busy: boolean }
  | {
      type: 'authOpen';
      view?: Extract<AuthPanelView, 'list' | 'oauth'> | undefined;
      providers?: AuthProviderRow[] | undefined;
      presets?: AuthLocalPresetRow[] | undefined;
      oauthStrategies?: import('./auth-panel-model.js').AuthOAuthStrategyRow[] | undefined;
    }
  | { type: 'authClose' }
  | { type: 'authProviders'; providers: AuthProviderRow[] }
  | { type: 'authCatalog'; catalog: AuthCatalogRow[] }
  | { type: 'authView'; view: AuthPanelView; providerId?: string | undefined }
  | { type: 'authMove'; delta: number }
  | { type: 'authBusy'; busy: boolean }
  | { type: 'authHint'; text?: string | undefined }
  | { type: 'authFilter'; filter: string }
  | { type: 'authFlowStart'; title: string }
  | { type: 'authFlowLog'; line: string }
  | { type: 'authFlowDone'; ok: boolean; message?: string | undefined }
  | { type: 'authPromptStart'; label: string; masked: boolean }
  | { type: 'authPromptChange'; draft: string }
  | { type: 'authPromptEnd' }
  | { type: 'authConfirmStart'; question: string; action: AuthConfirmAction }
  | { type: 'authConfirmEnd' }
  | { type: 'authFormStart'; form: AuthFormState }
  | { type: 'authFormChange'; field: AuthFormFieldId; value: string }
  | { type: 'authFormCancel' };
