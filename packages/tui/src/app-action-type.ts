import type {
  AutonomyStage,
  ContextSnapshot,
  DesignKitEntry,
  FleetChatVerbosity,
  SkillEntry,
  TokenSavingTier,
} from '@wrongstack/core/types';
import type { SddBoardSnapshot } from '@wrongstack/sdd';
import type { State } from './app-state.js';
import type {
  DraftEntry,
  GoalSummary,
  QueueItem,
  ResumeSessionEntry,
  SlashCommandMatch,
} from './app-state-core-types.js';
import type { FleetEntry } from './app-state-fleet.js';
import type {
  AuthCatalogRow,
  AuthConfirmAction,
  AuthLocalPresetRow,
  AuthPanelView,
  AuthProviderRow,
} from './auth-panel-model.js';
import type { BrainLogEntry, BrainRiskLevel } from './brain-contracts.js';
import type { BrainPanelSettings } from './brain-panel-model.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import type { HistoryEntry } from './history-entry.js';
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
} from './settings-contracts.js';
import type {
  AutonomyOption,
  ChipMeta,
  HelpEntry,
  LiveSessionEntry,
  McpPickerItem,
  ModeOption,
  PluginPickerItem,
  ProjectPickerItem,
  PromptPickEntry,
  ProviderOption,
  ResourceMenuAction,
  ResourceMenuSnapshot,
  ShadowState,
  ToolPickerItem,
  WorktreeRow,
} from './ui-contracts.js';
export type Action =
  | { type: 'addEntry'; entry: DraftEntry }
  | { type: 'archiveLoaded'; entries: HistoryEntry[] }
  | { type: 'startArchiveLoad' }
  | { type: 'compactHistory' }
  | { type: 'setBuffer'; buffer: string; cursor: number }
  | { type: 'clearInput' }
  | { type: 'clearHistory'; model?: string | undefined; provider?: string | undefined }
  | { type: 'streamDelta'; delta: string }
  | { type: 'streamReset' }
  | { type: 'status'; status: State['status'] }
  | { type: 'interrupt' }
  | { type: 'resetInterrupts' }
  /**
   * User pressed Esc mid-iteration — flag the next message for steering
   * AND stash a context snapshot so the preamble can tell the model
   * exactly what it was doing.
   */
  | { type: 'steerStart'; snapshot: State['steerSnapshot'] }
  /** Submit handler consumed the steering flag; reset. */
  | { type: 'steerConsume' }
  | { type: 'hint'; text: string }
  | { type: 'copiedNotice'; text: string; entryId: number | null }
  | {
      type: 'brainStatus';
      state: State['brain']['state'];
      source?: string | undefined;
      risk?: State['brain']['risk'] | undefined;
      summary?: string | undefined;
    }
  | { type: 'brainPromptSet'; prompt: NonNullable<State['brainPrompt']> }
  | { type: 'brainPromptClear' }
  | { type: 'pickerOpen'; query: string }
  | { type: 'pickerClose' }
  | { type: 'pickerSetMatches'; query: string; matches: string[] }
  | { type: 'pickerMove'; delta: number }
  | { type: 'toolStarted'; id: string; name: string }
  | { type: 'toolEnded'; id?: string | undefined; name?: string | undefined }
  | { type: 'toolStreamAppend'; toolUseId: string; name: string; text: string; startedAt: number }
  | { type: 'toolStreamClear'; toolUseId?: string | undefined; name?: string | undefined }
  | { type: 'enqueue'; item: Omit<QueueItem, 'id'> }
  | { type: 'dequeueFirst' }
  | { type: 'queueClear' }
  | { type: 'queueDelete'; positions: number[] }
  | { type: 'queueToggleRefine'; position: number }
  | { type: 'slashPickerOpen'; query: string; matches: SlashCommandMatch[] }
  | { type: 'slashPickerClose' }
  | { type: 'slashPickerMove'; delta: number }
  | {
      type: 'modelPickerOpen';
      providers: ProviderOption[];
      purpose?: 'switch' | 'pick' | undefined;
      title?: string | undefined;
    }
  | { type: 'modelPickerClose' }
  | { type: 'modelPickerMove'; delta: number }
  | { type: 'modelPickerPickProvider'; providerId: string; models: string[] }
  | { type: 'modelPickerBack' }
  | { type: 'modelPickerHint'; text?: string | undefined }
  /** Update the search filter in step 2. */
  | { type: 'modelPickerSearch'; query: string }
  | { type: 'autonomyPickerOpen'; options: AutonomyOption[] }
  | { type: 'autonomyPickerClose' }
  | { type: 'autonomyPickerMove'; delta: number }
  | { type: 'autonomyPickerHint'; text?: string | undefined }
  /** Theme picker — opened by `/theme`. Selecting a row swaps the palette and
   *  persists the choice via the ConfigStore bridge from the host. */
  | { type: 'themePickerOpen'; selected?: number }
  | { type: 'themePickerClose' }
  | { type: 'themePickerMove'; delta: number }
  | { type: 'themePickerHint'; text?: string | undefined }
  | { type: 'skillPickerOpen'; entries: SkillEntry[] }
  | { type: 'skillPickerClose' }
  | { type: 'skillPickerMove'; delta: number }
  | { type: 'skillPickerHint'; text?: string | undefined }
  | { type: 'resourceMenuOpen'; snapshot: ResourceMenuSnapshot }
  | { type: 'resourceMenuClose' }
  | { type: 'resourceMenuMove'; delta: number }
  | { type: 'resourceMenuHint'; text?: string | undefined }
  | { type: 'resourceMenuFilter'; filter: string; active: boolean }
  | { type: 'resourceMenuConfirm'; action?: ResourceMenuAction | undefined }
  | {
      type: 'modePickerOpen';
      modes: ModeOption[];
    }
  | { type: 'modePickerClose' }
  | { type: 'modePickerMove'; delta: number }
  | { type: 'modePickerHint'; text?: string | undefined }
  | { type: 'designPickerOpen'; kits: DesignKitEntry[] }
  | { type: 'designPickerClose' }
  | { type: 'designPickerMove'; delta: number }
  | { type: 'designPickerStack'; stack: string }
  | {
      type: 'promptPickerOpen';
      all: PromptPickEntry[];
      categories: string[];
      recentSlugs: string[];
    }
  | { type: 'promptPickerClose' }
  | { type: 'promptPickerMove'; delta: number }
  | { type: 'promptPickerCategory'; delta: number }
  | { type: 'resumePickerOpen'; sessions: ResumeSessionEntry[] }
  | { type: 'resumePickerClose' }
  | { type: 'resumePickerMove'; delta: number }
  | { type: 'resumePickerBusy'; on: boolean }
  | { type: 'resumePickerHint'; text?: string | undefined }
  | { type: 'resumePickerError'; text: string }
  /** Replace all history entries with the given hydrated entries from a resumed session. */
  | {
      type: 'replaceHistory';
      entries: HistoryEntry[];
      nextId: number;
      /**
       * Optional context-window snapshot forwarded from the host's
       * `onResumeSession` return. When present, the reducer writes
       * `tokens` to `state.leader.ctxTokens` and bumps
       * `state.contextChipVersion` so the statusline chip and `/context`
       * panel reflect the rebuilt context immediately, instead of staying
       * at zero until the next ctx.pct event.
       */
      contextSnapshot?: ContextSnapshot | undefined;
    }
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
      reasoningPreserve: boolean;
      thinkingWord: string;
      cacheTtl: CacheTtl;
      configScope: 'global' | 'project';
      breakerEnabled: boolean;
      breakerAutoKillResetMs: number;
      showModelReasoning: boolean;
      showAgentSwarmPanel: import('./app-settings-type.js').AgentSwarmPanelMode;
      panelPositions: import('./ui-contracts.js').PanelPositionMap;
      readSymbols: boolean;
      showSageMemoryInject: boolean;
      sageMemoryInjectThreshold: number;
      nextStepsTool: boolean;
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
  /**
   * Set a settings value directly from a typed patch (used by the
   * `/settings <chord> <value>` slash command). The patch is produced
   * by `resolveSettingsFieldValue` in settings-picker.tsx and validated
   * before dispatch, so the reducer just spreads it.
   */
  | { type: 'settingsValueSet'; patch: SettingsPickerPatch }
  /**
   * Update the live row-search filter. Empty string clears the filter.
   * Setting any non-empty value while the filter is empty also implicitly
   * activates filter mode (the picker renders only matching rows).
   */
  | { type: 'settingsFilterSet'; filter: string }
  | { type: 'settingsHint'; text?: string | undefined }
  /** Begin free-text editing of the thinking word (Enter on its row). */
  | { type: 'settingsThinkingEditStart' }
  /** Replace the in-progress thinking-word draft with the given buffer. */
  | { type: 'settingsThinkingEditChange'; draft: string }
  /** Commit the draft as the new thinking word (validated in the reducer). */
  | { type: 'settingsThinkingEditCommit' }
  /** Discard the draft and leave edit mode without changing the word. */
  | { type: 'settingsThinkingEditCancel' }
  /** Begin free-text editing of the WrongProxy URL (Enter on its row). */
  | { type: 'settingsWrongProxyUrlEditStart' }
  /** Replace the in-progress WrongProxy URL draft with the given buffer. */
  | { type: 'settingsWrongProxyUrlEditChange'; draft: string }
  /** Commit the draft as the new WrongProxy URL (validated in the reducer). */
  | { type: 'settingsWrongProxyUrlEditCommit' }
  /** Discard the draft and leave edit mode without changing the URL. */
  | { type: 'settingsWrongProxyUrlEditCancel' }
  | { type: 'statuslineOpen'; hiddenItems: StatuslineItem[] }
  | { type: 'statuslineClose' }
  | { type: 'statuslineFieldMove'; delta: number }
  | { type: 'statuslineFieldSet'; field: number }
  | { type: 'statuslineToggle'; item: StatuslineItem }
  | { type: 'statuslineHint'; text?: string | undefined }
  /**
   * A chip became visible due to data arriving (e.g., brain decision made,
   * mailbox messages arrived). Adds it to visibleChips with optional expiration.
   * If the chip is already in visibleChips, resets its shownAt timestamp.
   */
  | { type: 'statuslineChipShow'; key: StatuslineItem; expiresIn?: number }
  /**
   * Immediately remove a chip from visibleChips. Used when a stream ends
   * (brain, mailbox, enhance, debug_stream) so it disappears right away
   * even if it hasn't expired yet.
   */
  | { type: 'statuslineChipExpire'; key: StatuslineItem }
  /**
   * Sync visibleChips from the parent (e.g., after /statusline reset).
   * Replaces the entire visibleChips array.
   */
  | { type: 'statuslineVisibleChipsSync'; visibleChips: ChipMeta[] }
  | { type: 'pluginPickerOpen'; items?: PluginPickerItem[] | undefined }
  | { type: 'pluginPickerClose' }
  | { type: 'pluginPickerMove'; delta: number }
  | { type: 'pluginPickerSetItems'; items: PluginPickerItem[] }
  | { type: 'pluginPickerBusy'; busy: boolean }
  | { type: 'pluginPickerHint'; text?: string | undefined }
  | { type: 'mcpPickerOpen'; items?: McpPickerItem[] | undefined }
  | { type: 'mcpPickerClose' }
  | { type: 'mcpPickerMove'; delta: number }
  | { type: 'mcpPickerSetItems'; items: McpPickerItem[] }
  | { type: 'mcpPickerBusy'; busy: boolean }
  | { type: 'mcpPickerHint'; text?: string | undefined }
  | { type: 'toolsPickerOpen'; items?: ToolPickerItem[] | undefined }
  | { type: 'toolsPickerClose' }
  | { type: 'toolsPickerMove'; delta: number }
  | { type: 'toolsPickerSetItems'; items: ToolPickerItem[] }
  | { type: 'toolsPickerToggle' }
  | { type: 'toolsPickerBusy'; busy: boolean }
  | { type: 'toolsPickerHint'; text?: string | undefined }
  | { type: 'toolsPickerFilter'; filter: string }
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
  | { type: 'helpOpen'; entries: HelpEntry[] }
  | { type: 'helpClose' }
  | { type: 'helpMove'; delta: number }
  | { type: 'helpFilter'; filter: string }
  | { type: 'helpHint'; text?: string | undefined }
  | { type: 'shadowOpen'; shadow: ShadowState }
  | { type: 'shadowClose' }
  | { type: 'shadowUpdate'; shadow: ShadowState }
  | { type: 'shadowHint'; text?: string | undefined }
  | {
      type: 'authOpen';
      view?: Extract<AuthPanelView, 'list' | 'oauth'> | undefined;
      providers?: AuthProviderRow[] | undefined;
      presets?: AuthLocalPresetRow[] | undefined;
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
  | { type: 'projectPickerOpen'; items: ProjectPickerItem[] }
  | { type: 'projectPickerClose' }
  | { type: 'projectPickerMove'; delta: number }
  | { type: 'projectPickerFilter'; filter: string }
  | { type: 'projectPickerHint'; text?: string | undefined }
  | { type: 'fKeyPickerOpen' }
  | { type: 'fKeyPickerClose' }
  | { type: 'fKeyPickerMove'; delta: number }
  | { type: 'historyPush'; text: string }
  | { type: 'historyUp' }
  | { type: 'historyDown' }
  | { type: 'setInputHistory'; entries: string[] }
  | { type: 'clearInputHistory' }
  | { type: 'confirmOpen'; info: State['confirmQueue'][0] }
  | { type: 'confirmClose' }
  | { type: 'confirmClearAll' }
  | { type: 'shellCommandWarningOpen'; info: NonNullable<State['shellCommandWarning']> }
  | { type: 'shellCommandWarningClose' }
  | { type: 'enhanceOpen'; info: NonNullable<State['enhance']> }
  | { type: 'enhanceClose' }
  | { type: 'enhanceSet'; enabled: boolean }
  | { type: 'enhanceBusy'; on: boolean }
  | { type: 'topicCheckBusy'; on: boolean }
  | { type: 'refineCountdownOpen'; info: NonNullable<State['refineCountdown']> }
  /**
   * `info` scopes the close to the countdown the caller opened. A refine flow
   * that was superseded by a newer countdown must not tear the newer one down
   * when it finally unwinds; omitting `info` closes unconditionally.
   */
  | { type: 'refineCountdownClose'; info?: NonNullable<State['refineCountdown']> }
  | { type: 'refineFailureOpen'; info: NonNullable<State['refineFailure']> }
  | { type: 'refineFailureClose' }
  | { type: 'continueConfirmOpen'; info: NonNullable<State['continueConfirm']> }
  | { type: 'continueConfirmClose' }
  | { type: 'clearConfirmOpen'; info: NonNullable<State['clearConfirm']> }
  | { type: 'clearConfirmSetValue'; value: string }
  | { type: 'clearConfirmClose' }
  | { type: 'exitConfirmOpen'; info: NonNullable<State['exitConfirm']> }
  | { type: 'exitConfirmClose' }
  | { type: 'slashConfirmOpen'; info: NonNullable<State['slashConfirm']> }
  | { type: 'slashConfirmClose' }
  /**
   * Open the ESC-interrupt confirmation dialog with a context snapshot.
   * Fired when Esc is pressed mid-iteration and `confirmExit` is enabled.
   * The snapshot is replayed into `steerStart` on confirmation so the
   * STEERING preamble can describe the interrupted state to the LLM.
   */
  | { type: 'escConfirmOpen'; snapshot: NonNullable<State['steerSnapshot']> }
  /** Dismiss the ESC-interrupt confirmation (user cancelled). */
  | { type: 'escConfirmClose' }
  /** Open the fallback model overlay (provider.fallback_pending received). */
  | { type: 'fallbackOverlayOpen'; info: NonNullable<State['fallbackOverlay']> }
  /** Move the fallback overlay selection (wraps). */
  | { type: 'fallbackOverlayMove'; delta: number }
  /** Close the fallback overlay (choice made or auto-switched). */
  | { type: 'fallbackOverlayClose' }
  /** Open the mid-run send-mode picker with the resolved message + resolver. */
  | { type: 'sendModePickerOpen'; info: NonNullable<State['sendModePicker']> }
  /** Move the send-mode highlight (wraps). */
  | { type: 'sendModePickerMove'; delta: number }
  /** Close the send-mode picker. */
  | { type: 'sendModePickerClose' }
  | { type: 'resetContextChip' }
  // Fleet actions
  | { type: 'fleetSeed'; entries: FleetEntry[]; cost: number }
  | {
      type: 'fleetSpawn';
      id: string;
      name?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      transcriptPath?: string | undefined;
    }
  | { type: 'fleetStart'; id: string; taskId?: string | undefined }
  | { type: 'fleetDelta'; id: string; text: string }
  | { type: 'fleetMessage'; id: string; text: string }
  | {
      type: 'fleetTool';
      id: string;
      name?: string | undefined;
      ok?: boolean | undefined;
      durationMs?: number | undefined;
      outputBytes?: number | undefined;
      outputLines?: number | undefined;
    }
  /** tool.started: pin the current tool name for status display. */
  | { type: 'fleetToolStart'; id: string; name: string }
  /** tool.executed: clear the current tool (paired with fleetTool). */
  | { type: 'fleetToolEnd'; id: string }
  | {
      type: 'fleetUsage';
      id: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | {
      type: 'fleetDone';
      id: string;
      status: FleetEntry['status'];
      iterations: number;
      toolCalls: number;
      /** Human-readable failure reason, e.g. "provider_auth", "rate_limit", "timeout". */
      failureReason?: string | undefined;
    }
  | { type: 'fleetRemove'; id: string }
  | {
      type: 'fleetBudgetWarning';
      id: string;
      kind: string;
      used: number;
      limit: number;
    }
  | {
      type: 'fleetBudgetExtended';
      id: string;
      totalExtensions: number;
    }
  | {
      type: 'fleetCtxPct';
      id: string;
      load: number;
      tokens: number;
      maxContext: number;
      /** Estimated USD cost of the context tokens (optional — computed when pricing known). */
      ctxCost?: number | undefined;
    }
  | {
      type: 'fleetCost';
      cost: number;
      input?: number | undefined;
      output?: number | undefined;
      /** Per-subagent usage keyed by subagent id (from the director snapshot). */
      perAgent?: Record<string, { cost: number }>;
    }
  /** Runtime concurrency ceiling change from CLI /fleet concurrency <n>. */
  | { type: 'fleetConcurrency'; n: number }
  | { type: 'leaderIterStart' }
  | { type: 'leaderIterEnd' }
  | { type: 'leaderToolStart'; name: string }
  | {
      type: 'leaderToolEnd';
      name: string;
      ok?: boolean | undefined;
      durationMs?: number | undefined;
    }
  | { type: 'leaderCtxPct'; load: number; tokens: number; maxContext: number }
  | { type: 'setFleetChat'; mode: FleetChatVerbosity }
  | { type: 'toggleMonitor' }
  | { type: 'toggleAgentsMonitor' }
  | { type: 'toggleHelp' }
  | { type: 'toggleTodosMonitor' }
  | { type: 'toggleQueuePanel' }
  | { type: 'checkpointReceived'; cp: State['checkpoints'][0] }
  | { type: 'rewindOverlayOpen' }
  | { type: 'rewindOverlayClose' }
  | { type: 'rewindOverlayMove'; delta: number }
  | { type: 'sessionRewound'; toPromptIndex: number }
  | {
      type: 'eternalStage';
      stage: AutonomyStage;
    }
  | { type: 'goalSummary'; summary: GoalSummary }
  | { type: 'goalRunInit'; title: string }
  | {
      type: 'goalRunPhaseUpdate';
      phaseId: string;
      name: string;
      status: string;
      completedTasks: number;
      totalTasks: number;
      startedAt?: number | undefined;
    }
  | { type: 'goalRunRunningPhases'; phaseIds: string[] }
  | { type: 'goalRunElapsed'; ms: number }
  | {
      type: 'goalRunTaskActive';
      phaseId: string;
      taskId: string;
      title: string;
      agent?: string | undefined;
      /** True when the task starts, false when it completes/fails. */
      active: boolean;
    }
  | { type: 'goalRunMonitorToggle' }
  | { type: 'goalRunReset' }
  | { type: 'sddBoardSnapshot'; snapshot: SddBoardSnapshot }
  | { type: 'toggleSddBoardMonitor' }
  | { type: 'sddBoardFocusNext' }
  | { type: 'sddBoardFocusPrev' }
  | {
      type: 'worktreeUpsert';
      handleId: string;
      row: Partial<WorktreeRow & { baseBranch?: string | undefined }>;
      baseBranch?: string | undefined;
    }
  | { type: 'worktreeRemove'; handleId: string }
  | { type: 'toggleWorktreeMonitor' }
  // --- In-app chat scroll ---
  /** ScrollableHistory reports whether the viewport is scrolled up. */
  | { type: 'setHistoryScrolled'; scrolled: boolean }
  /** Report the computed viewport height. */
  | { type: 'setViewportRows'; rows: number }
  /**
   * Fold a batch of fleet/display actions through the reducer in ONE pass so
   * a 150ms burst of subagent events produces a single React render instead
   * of one per event. Order-preserving; only high-frequency display events
   * are batched (correctness-sensitive events stay immediate).
   */
  | { type: 'fleetBatch'; actions: Action[] }
  /** BugHunter emitted a bug.found event on the FleetBus. */
  | {
      type: 'collabBugFound';
      sessionId: string;
      bugId: string;
      severity: string;
      description: string;
    }
  /** RefactorPlanner emitted a refactor.plan event on the FleetBus. */
  | {
      type: 'collabPlanEmitted';
      sessionId: string;
      planId: string;
      riskScore: string;
      phaseCount: number;
    }
  /** Critic emitted a critic.evaluation event on the FleetBus. */
  | {
      type: 'collabEvalComplete';
      sessionId: string;
      evalId: string;
      verdict: string;
      score: number;
    }
  /** Collab session completed — overall verdict is available. */
  | {
      type: 'collabSessionDone';
      sessionId: string;
      verdict: 'approve' | 'needs_revision' | 'reject';
    }
  /** A collab subagent (bug-hunter / refactor-planner / critic) was spawned. */
  | { type: 'collabSubagentSpawned'; subagentId: string; role: string }
  /** Toggle the process list overlay (F8). */
  | { type: 'toggleProcessList' }
  /** Toggle the cron jobs monitor. */
  | { type: 'toggleCronMonitor' }
  /** Toggle the audit (side effects) panel. */
  | { type: 'toggleAuditPanel' }
  /** Toggle the plan panel (F5). */
  | { type: 'togglePlanPanel' }
  /** Close every open panel/monitor/overlay at once. */
  | { type: 'closeAllPanels' }
  /** Toggle keyboard focus between input and the right sidebar. */
  | { type: 'toggleSidebarFocus' }
  /** Scroll the sidebar content by delta rows (clamped to >=0). */
  | {
      type: 'sidebarScroll';
      delta: number;
      viewportHeight?: number | undefined;
      /**
       * Rows occupied by routed twin panels (Todos / Plan / Kanban / …)
       * mounted above `SidebarContent` inside `RightSidebar`. Subtracted
       * from `viewportHeight` so the scroll clamp matches the actual
       * viewport the user can scroll through. Defaults to 0 (no twins
       * mounted) when omitted so existing call sites stay correct.
       */
      sidebarTwinRowCount?: number | undefined;
      /**
       * Whether the swarm panel is on the sidebar using the effective
       * source (picker draft when the picker is open, persisted
       * `liveSettings` otherwise — see `app-view.tsx`). Drives the
       * mission-queue reservation in `computeMaxSidebarScroll`; without
       * this field the reducer only sees the picker draft and under-
       * reserves the mission card when a config-only 'sidebar' swarm
       * mode is persisted but the picker has never been opened.
       */
      effectiveSwarmOnSidebar?: boolean | undefined;
    }
  /** Reset sidebar scroll offset to 0. */
  | { type: 'sidebarScrollReset' }
  | { type: 'toggleKanbanPanel' }
  | { type: 'toggleGoalPanel' }
  | { type: 'toggleGoalKanbanPanel' }
  | { type: 'toggleContextPanel' }
  | { type: 'toggleConnectionsPanel' }
  | { type: 'toggleSessionsPanel' }
  | {
      type: 'sessionsPanelSet';
      sessions: LiveSessionEntry[];
    }
  | { type: 'sessionsPanelMove'; delta: number }
  | { type: 'sessionsPanelBusy'; on: boolean }
  | { type: 'sessionResumeConfirmSet'; sessionId: string; sessionName: string }
  | { type: 'sessionResumeConfirmClear' }
  /** Push throttled debug-stream telemetry from the provider's chunk callback. */
  | {
      type: 'debugStreamStats';
      chunkCount: number;
      lastChunkSize: number;
      lastDeltaMs: number;
      totalBytes: number;
      lastChunkAt: string;
    }
  /** Clear debug-stream stats (fired on stream reset / idle). */
  | { type: 'debugStreamStatsClear' }
  /** Auto-proceed countdown tick. Upserts the countdown; 0 clears it. */
  | { type: 'countdownTick'; remainingSeconds: number }
  /** Auto-proceed countdown ended (completed or aborted). */
  | { type: 'countdownEnded' }
  // --- AutonomousCoordinator ---
  /** Coordinator emitted a live event. */
  | {
      type: 'coordinatorEvent';
      event: {
        type: string;
        goalId?: string | undefined;
        taskId?: string | undefined;
        knowledgeId?: string | undefined;
        title?: string | undefined;
        text?: string | undefined;
        participants?: string[] | undefined;
      };
    }
  /** Toggle the coordinator monitor overlay. */
  | { type: 'toggleCoordinatorMonitor' };
