import type { Message, TokenSavingTier } from '@wrongstack/core';
import { AUTH_PANEL_INITIAL } from './components/auth-panel-model.js';
import type { ContextMode, StatuslineMode } from './components/settings-picker.js';
import { rehydrateHistory } from './app.js';
import type { State } from './app-state.js';

export type RestoredToolCall = {
  name: string;
  id: string;
  durationMs: number;
  ok: boolean;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
  outputLines?: number | undefined;
};

export function buildRestoredEntries(
  messages: Message[] | undefined,
  restoredToolCalls?: RestoredToolCall[] | undefined,
): State['entries'] {
  if (!messages || messages.length === 0) return [];
  const visible = messages.filter((m) => m.role !== 'system');
  if (visible.length === 0) return [];
  return rehydrateHistory(visible, 1, restoredToolCalls);
}

export interface CreateInitialStateOptions {
  banner: boolean;
  appVersion?: string | undefined;
  provider?: string | undefined;
  model: string;
  cwd: string;
  family?: string | undefined;
  keyTail?: string | undefined;
  restoredEntries: State['entries'];
  enhanceEnabled: boolean;
  initialAgentsMonitorOpen?: boolean | undefined;
}

export function createInitialState(options: CreateInitialStateOptions): State {
  const {
    banner,
    appVersion,
    provider,
    model,
    cwd,
    family,
    keyTail,
    restoredEntries,
    enhanceEnabled,
    initialAgentsMonitorOpen,
  } = options;
  const initialNextId = 1 + restoredEntries.length;

  return {
    entries: [
      ...(banner
        ? [
            {
              id: 0,
              kind: 'banner' as const,
              version: appVersion ?? 'dev',
              provider: provider ?? 'agent',
              model,
              cwd,
              family,
              keyTail,
            },
          ]
        : []),
      ...restoredEntries,
    ],
    historyGen: 0,
    buffer: '',
    cursor: 0,
    streamingText: '',
    toolStream: null,
    status: 'idle',
    interrupts: 0,
    steeringPending: false,
    steerSnapshot: null,
    hint: '',
    brain: { state: 'idle' },
    brainPrompt: null,
    nextId: initialNextId,
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
    },
    autonomyPicker: { open: false, options: [], selected: 0 },
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
      streamFleet: true,
      chime: false,
      confirmExit: true,
      nextPrediction: false,
      featureMcp: true,
      featurePlugins: true,
      featureMemory: true,
      featureSkills: true,
      featureModelsRegistry: true,
      tokenSavingTier: 'off' as TokenSavingTier,
      allowOutsideProjectRoot: true,
      contextAutoCompact: true,
      contextStrategy: 'hybrid',
      contextMode: 'balanced' as ContextMode,
      maxConcurrent: 10,
      logLevel: 'info',
      auditLevel: 'standard',
      indexOnStart: true,
      multiDiffSummaryThreshold: 5,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60_000,
      enhanceEnabled: true,
      enhanceLanguage: 'original',
      debugStream: false,
      statuslineMode: 'detailed' as StatuslineMode,
      reasoningMode: 'auto',
      reasoningEffort: 'high',
      reasoningPreserve: false,
      thinkingWord: 'thinking',
      thinkingWordEditing: false,
      thinkingWordDraft: '',
      cacheTtl: 'default',
      configScope: 'global',
      animationStyle: 'rainbow',
    },
    statuslinePicker: {
      open: false,
      field: 0,
      hiddenItems: [],
      visibleChips: [],
      hint: undefined,
    },
    pluginPicker: { open: false, items: [], selected: 0, busy: false, hint: undefined },
    mcpPicker: { open: false, items: [], selected: 0, busy: false, hint: undefined },
    toolsPicker: { open: false, items: [], selected: 0, busy: false, hint: undefined, filter: undefined },
    brainPanel: { open: false, riskLevel: 'medium', log: [], selected: 0, hint: undefined },
    helpPanel: { open: false, entries: [], selected: 0, filter: '', hint: undefined },
    shadowPanel: { open: false, shadow: { activeId: null, running: false, model: '', intervalMs: 30000 }, hint: undefined },
    authPanel: AUTH_PANEL_INITIAL,
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
    enhance: null,
    enhanceEnabled,
    enhanceBusy: false,
    escConfirm: null,
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
    streamFleet: true,
    monitorOpen: false,
    agentsMonitorOpen: initialAgentsMonitorOpen ?? false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    auditPanelOpen: false,
    planPanelOpen: false,
    kanbanPanelOpen: false,
    goalPanelOpen: false,
    sessionsPanelOpen: false,
    sessionsPanel: { sessions: [], busy: false, selected: -1 },
    sessionResumeConfirm: null,
    collabSession: null,
    checkpoints: [],
    rewindOverlay: null,
    eternalStage: null,
    goalSummary: null,
    autoPhase: null,
    sddBoard: null,
    worktrees: {},
    worktreeMonitorOpen: false,
    coordinator: {
      goals: [],
      timeline: [],
      knowledgeCount: 0,
      monitorOpen: false,
      healthy: false,
    },
    scrollOffset: 0,
    totalLines: 0,
    viewportRows: 0,
    pendingNewLines: 0,
    debugStreamStats: null,
    countdown: null,
  } as State;
}
