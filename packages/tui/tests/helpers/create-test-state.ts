/**
 * Canonical test-fixture factory for TUI {@link State}.
 *
 * Every test that needs a `State` object should use `createTestState()` instead
 * of hand-building partial fixtures with `as unknown as State`. The factory
 * mirrors the defaults from `src/app-initial-state.ts` but requires no runtime
 * options — making it ideal for unit tests that only exercise a small slice of
 * the state shape.
 *
 * Usage:
 * ```ts
 * import { createTestState } from './helpers/create-test-state.js';
 *
 * const state = createTestState({ status: 'streaming' });
 * const state2 = createTestState({ modelPicker: { open: true, step: 'model' } });
 * ```
 *
 * The `overrides` parameter is deeply partial — you can override any field at
 * any depth without providing the full sub-object. Unknown keys are allowed via
 * the `Record<string, unknown>` widening, matching the test fixture convention
 * already used across the codebase.
 */

import type { State } from '../../src/app-state.js';
import { DEFAULT_PANEL_POSITIONS } from '../../src/ui-contracts.js';

/**
 * Recursively partial — every field (including nested objects) becomes
 * optional. Arrays and primitives are left as-is (not made partial).
 */
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? U[] // arrays stay arrays of the same element type
    : T[P] extends object
      ? DeepPartial<T[P]> // nested objects become DeepPartial
      : T[P]; // primitives stay the same type but optional
};

/**
 * Create a fully-typed test `State` with sensible defaults.
 *
 * @param overrides — deep-partial overrides applied via shallow spread.
 *   Top-level keys replace the corresponding default; for deeper overrides,
 *   spread the sub-object manually (e.g.
 *   `createTestState({ modelPicker: { ...createTestState().modelPicker, open: true } })`).
 *
 * The factory is structurally equivalent to `createInitialState` in
 * `src/app-initial-state.ts`, minus the runtime `options` parameter.
 */
export function createTestState(
  overrides: DeepPartial<State> & Record<string, unknown> = {},
): State {
  const base: State = {
    entries: [],
    archiveLoading: false,
    historyGen: 0,
    historyBudget: undefined,
    autoProceedHold: false,
    resumeLoad: null,
    buffer: '',
    cursor: 0,
    streamingText: '',
    toolStream: null,
    status: 'idle',
    interrupts: 0,
    steeringPending: false,
    steerSnapshot: null,
    hint: '',
    copiedNotice: '',
    copiedEntryId: null,
    brain: { state: 'idle' },
    brainPrompt: null,
    nextId: 1,
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map<string, { name: string; startedAt: number }>(),
    queue: [],
    nextQueueId: 1,
    inputHistory: [],
    historyIndex: 0,
    historyDraft: '',
    modelPicker: {
      open: false,
      step: 'provider',
      providerOptions: [],
      modelOptions: [],
      filteredOptions: [],
      selected: 0,
      searchQuery: '',
      purpose: 'switch',
    },
    autonomyPicker: { open: false, options: [], selected: 0 },
    themePicker: { open: false, selected: 0 },
    skillPicker: { open: false, entries: [], selected: 0 },
    resourceMenu: { open: false, snapshot: null, selected: 0, filter: '', filtering: false },
    modePicker: { open: false, modes: [], selected: 0 },
    designPicker: { open: false, kits: [], selected: 0, stack: 'web' },
    promptPicker: {
      open: false,
      all: [],
      categories: [],
      recentSlugs: [],
      catIndex: 0,
      selected: 0,
    },
    resumePicker: {
      open: false,
      sessions: [],
      selected: 0,
      busy: false,
      hint: undefined,
      error: undefined,
    },
    settingsPicker: {
      open: false,
      field: 0,
      lastSettingsField: 0,
      filter: '',
      mode: 'off',
      delayMs: 0,
      titleAnimation: true,
      yolo: false,
      fleetChat: 'off',
      chime: false,
      confirmExit: true,
      nextPrediction: false,
      featureMcp: true,
      featurePlugins: true,
      featureMemory: true,
      featureSkills: true,
      featureModelsRegistry: true,
      tokenSavingTier: 'off',
      allowOutsideProjectRoot: true,
      contextAutoCompact: true,
      contextStrategy: 'hybrid',
      contextMode: 'balanced',
      maxConcurrent: 10,
      logLevel: 'info',
      auditLevel: 'standard',
      indexOnStart: true,
      multiDiffSummaryThreshold: 5,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60_000,
      preRefineSeconds: 3,
      enhanceEnabled: true,
      enhanceLanguage: 'original',
      debugStream: false,
      statuslineMode: 'detailed',
      reasoningMode: 'auto',
      reasoningEffort: 'high',
      reasoningPreserve: false,
      thinkingWord: 'thinking',
      thinkingWordEditing: false,
      thinkingWordDraft: '',
      cacheTtl: 'default',
      configScope: 'global',
      animationStyle: 'rainbow',
      breakerEnabled: false,
      breakerAutoKillResetMs: 60_000,
      showModelReasoning: true,
      showAgentSwarmPanel: 'bottom',
      showSageMemoryInject: false,
      sageMemoryInjectThreshold: 0.85,
      readSymbols: false,
      nextStepsTool: false,
      // WrongProxy / WrongTrace: match app-initial-state defaults (switch
      // off, daemon default URL, no edit in progress).
      wrongProxyEnabled: false,
      wrongProxyUrl: 'http://localhost:3444',
      wrongProxyUrlEditing: false,
      wrongProxyUrlDraft: '',
      showSidebar: true,
      panelPositions: DEFAULT_PANEL_POSITIONS,
    },
    statuslinePicker: {
      open: false,
      field: 0,
      hiddenItems: [],
      visibleChips: [],
      lines: {},
      densities: {},
      filter: '',
      filtering: false,
      layoutSeeded: false,
      hint: undefined,
    },
    pluginPicker: { open: false, items: [], selected: 0, busy: false, hint: undefined },
    mcpPicker: { open: false, items: [], selected: 0, busy: false, hint: undefined },
    toolsPicker: {
      open: false,
      items: [],
      selected: 0,
      busy: false,
      hint: undefined,
      filter: undefined,
    },
    brainPanel: {
      open: false,
      riskLevel: 'medium',
      log: [],
      selected: 0,
      hint: undefined,
      view: 'settings',
      settings: undefined,
      row: 0,
      busy: false,
    },
    helpPanel: { open: false, entries: [], selected: 0, filter: '', hint: undefined },
    shadowPanel: {
      open: false,
      shadow: { activeId: null, running: false, model: '', intervalMs: 30000 },
      hint: undefined,
    },
    authPanel: {
      open: false,
      view: 'list',
      busy: false,
      providers: [],
      presets: [],
      catalog: [],
      selected: 0,
      input: undefined,
      confirm: undefined,
      providerId: undefined,
      filter: '',
      flowTitle: '',
      log: [],
      flowDone: false,
    },
    projectPicker: {
      open: false,
      allItems: [],
      items: [],
      selected: 0,
      filter: '',
      hint: undefined,
    },
    fKeyPicker: { open: false, selected: 0 },
    confirmQueue: [],
    shellCommandWarning: null,
    enhance: null,
    enhanceEnabled: true,
    enhanceBusy: false,
    topicCheckBusy: false,
    refineCountdown: null,
    refineCountdownGen: 0,
    refineFailure: null,
    continueConfirm: null,
    bugHuntContinue: null,
    bugHuntRunning: null,
    clearConfirm: null,
    exitConfirm: null,
    slashConfirm: null,
    escConfirm: null,
    fallbackOverlay: null,
    sendModePicker: null,
    contextChipVersion: 0,
    fleet: {},
    leader: {
      iterations: 0,
      toolCalls: 0,
      recentTools: [],
      currentTool: undefined,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      iterating: false,
    },
    fleetCost: 0,
    fleetTokens: { input: 0, output: 0 },
    fleetConcurrency: 4,
    fleetChat: 'off',
    monitorOpen: false,
    agentsMonitorOpen: false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    cronMonitorOpen: false,
    auditPanelOpen: false,
    planPanelOpen: false,
    kanbanPanelOpen: false,
    goalPanelOpen: false,
    goalKanbanPanelOpen: false,
    contextPanelOpen: false,
    connectionsPanelOpen: false,
    sessionsPanelOpen: false,
    sidebarFocused: false,
    sidebarScrollOffset: 0,
    sessionsPanel: { sessions: [], busy: false, selected: -1 },
    sessionResumeConfirm: null,
    collabSession: null,
    checkpoints: [],
    rewindOverlay: null,
    eternalStage: null,
    goalSummary: null,
    goalRun: null,
    sddBoard: null,
    worktrees: {},
    worktreeMonitorOpen: false,
    coordinator: { goals: [], timeline: [], knowledgeCount: 0, monitorOpen: false, healthy: false },
    viewportRows: 0,
    historyScrolled: false,
    debugStreamStats: null,
    countdown: null,
  };

  return { ...base, ...overrides } as State;
}

/**
 * Convenience: a "running" state preset for tests that need the agent
 * mid-stream.
 */
export function createRunningState(
  overrides: DeepPartial<State> & Record<string, unknown> = {},
): State {
  return createTestState({
    status: 'streaming',
    streamingText: 'partial response',
    ...overrides,
  });
}
