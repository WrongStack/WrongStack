import type {
  FleetChatVerbosity,
  Message,
  SessionEvent,
  TokenSavingTier,
} from '@wrongstack/core/types';
import type { State } from './app-state.js';
import { AUTH_PANEL_INITIAL } from './auth-panel-model.js';
import { retainCheckpoints } from './checkpoint-retention.js';
import { replaySessionMessages } from './components/history/replay.js';
import type { AutonomyAgentStatus } from './components/history/types.js';
import { type ContextMode, DEFAULT_STATUSLINE_MODE } from './components/settings-picker.js';
import { retainTuiHistory } from './history-retention.js';
import { rehydrateHistory } from './rehydrate-history.js';
import { DEFAULT_PANEL_POSITIONS } from './ui-contracts.js';

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
  restoredEvents?: SessionEvent[] | undefined,
): State['entries'] {
  if (!messages || messages.length === 0) return [];
  // Canonical renderer when the raw event stream is available: restores tool
  // input/output and interleaves audit markers (mode/compaction/checkpoint/
  // skill/agent/error/…), matching the in-session resume picker. It renders
  // system messages itself (→ info), so pass the full list including the
  // resume file-validation / interrupted-tool notices injected by the store.
  if (restoredEvents && restoredEvents.length > 0) {
    // Runs once per resume. The transient `dummyPending` / `dummyCompleted` /
    // `toolEntries` Maps inside `replaySessionMessages` are GC'd after init;
    // `retainTuiHistory` then collapses the output to the per-entry + aggregate
    // byte budget (TUI_HISTORY_MAX_{ENTRIES,BYTES,ENTRY_BYTES}). Do not move
    // this into render — that would rebuild the transient Maps on every render
    // and defeat the once-per-resume GC. If large-resume init GC pressure ever
    // surfaces in heap-watchdog logs, the right fix is truncate-then-replay
    // (slice `messages` / `restoredEvents` to the retained window first) —
    // which requires preserving tool_use/tool_result pairing across the window.
    return retainTuiHistory(replaySessionMessages(messages, restoredEvents, 1));
  }
  // Legacy fallback (no events — older callers / unit tests): meta-only tool
  // chips with system messages filtered out.
  const visible = messages.filter((m) => m.role !== 'system');
  if (visible.length === 0) return [];
  return retainTuiHistory(rehydrateHistory(visible, 1, restoredToolCalls));
}

/**
 * Rebuild the checkpoint list from a resumed session's events.
 *
 * The live list is fed by the `checkpoint.written` EventBus bridge, which only
 * fires for checkpoints written by THIS process — so without this a resumed
 * session starts with an empty list and `/rewind` reports "no checkpoints"
 * despite a JSONL full of them.
 *
 * `fileCount` is not stored on the checkpoint event itself, but it is derivable:
 * the `file_snapshot` events carry the same `promptIndex`, so summing their
 * `files.length` per index reproduces the live stat. `DefaultSessionRewinder.
 * listCheckpoints` builds its counts the same way.
 */
export function buildRestoredCheckpoints(
  restoredEvents?: SessionEvent[] | undefined,
): State['checkpoints'] {
  if (!restoredEvents || restoredEvents.length === 0) return [];
  const fileCountByIndex = new Map<number, number>();
  const byIndex = new Map<number, State['checkpoints'][number]>();
  for (const ev of restoredEvents) {
    if (ev.type === 'file_snapshot') {
      fileCountByIndex.set(
        ev.promptIndex,
        (fileCountByIndex.get(ev.promptIndex) ?? 0) + ev.files.length,
      );
      continue;
    }
    if (ev.type !== 'checkpoint') continue;
    byIndex.set(ev.promptIndex, {
      promptIndex: ev.promptIndex,
      promptPreview: ev.promptPreview,
      ts: ev.ts,
      fileCount: 0,
    });
  }
  // Applied after the walk: a prompt's file_snapshot events are written as its
  // tools run, i.e. AFTER its checkpoint event.
  for (const [promptIndex, checkpoint] of byIndex) {
    checkpoint.fileCount = fileCountByIndex.get(promptIndex) ?? 0;
  }
  return retainCheckpoints([...byIndex.values()].sort((a, b) => a.promptIndex - b.promptIndex));
}

export interface CreateInitialStateOptions {
  banner: boolean;
  appVersion?: string | undefined;
  provider?: string | undefined;
  model: string;
  cwd: string;
  family?: string | undefined;
  keyTail?: string | undefined;
  /** Current session id (e.g. "sess_01KXV6…"). Static for the session lifetime. */
  sessionId?: string | undefined;
  /** Active fallback profile name to display in the banner (e.g. "default"). */
  profile?: string | undefined;
  /** Absolute path to the active profile's config.json, shown in the banner
   *  with the profile name highlighted. Optional — falls back to the bare
   *  {@link profile} string when not provided. */
  profileConfigPath?: string | undefined;
  /** Background autonomy agents to display in the banner. */
  autonomyAgents?: ReadonlyArray<AutonomyAgentStatus> | undefined;
  /** Latest version published to the npm registry (drives the
   *  "update available" indicator next to the version chip). */
  latestVersion?: string | undefined;
  /** True when a newer published version exists than {@link appVersion}.
   *  Both fields are sourced from the CLI's preflight update-check and
   *  are independent — `latestVersion` may be set even when the current
   *  version already matches the registry (in which case the indicator
   *  is suppressed because {@link updateAvailable} is false). */
  updateAvailable?: boolean | undefined;
  restoredEntries: State['entries'];
  /** Checkpoints rebuilt from a resumed session's events. Empty for a fresh session. */
  restoredCheckpoints?: State['checkpoints'] | undefined;
  enhanceEnabled: boolean;
  initialAgentsMonitorOpen?: boolean | undefined;
  /** Boot-time fleet-chat verbosity (from persisted config). Default 'off'. */
  initialFleetChat?: FleetChatVerbosity | undefined;
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
    sessionId,
    profile,
    profileConfigPath,
    autonomyAgents,
    latestVersion,
    updateAvailable,
    restoredEntries,
    restoredCheckpoints,
    enhanceEnabled,
    initialAgentsMonitorOpen,
    initialFleetChat,
  } = options;
  // Retention preserves the original ids of the recent tail, so array length
  // is no longer a safe id source after older entries have been omitted.
  const initialNextId = restoredEntries.reduce((next, entry) => Math.max(next, entry.id + 1), 1);
  const fleetChat: FleetChatVerbosity = initialFleetChat ?? 'off';

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
              sessionId,
              profile,
              profileConfigPath,
              autonomyAgents,
              latestVersion,
              updateAvailable,
            },
          ]
        : []),
      ...restoredEntries,
    ],
    archiveLoading: false,
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
    copiedNotice: '',
    copiedEntryId: null,
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
      purpose: 'switch',
    },
    autonomyPicker: { open: false, options: [], selected: 0 },
    themePicker: { open: false, selected: 0 },
    modePicker: { open: false, modes: [], selected: 0 },
    skillPicker: { open: false, entries: [], selected: 0, hint: undefined },
    resourceMenu: {
      open: false,
      snapshot: null,
      selected: 0,
      filter: '',
      filtering: false,
      hint: undefined,
    },
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
      fleetChat,
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
      preRefineSeconds: 3,
      enhanceEnabled: true,
      enhanceLanguage: 'original',
      debugStream: false,
      statuslineMode: DEFAULT_STATUSLINE_MODE,
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
      panelPositions: DEFAULT_PANEL_POSITIONS,
      // Default on: compact one-line chip (see SageMemoryBlock). Full bordered
      // panel remains available when operators expand inject visibility later.
      showSageMemoryInject: true,
      sageMemoryInjectThreshold: 0.85,
      nextStepsTool: false,
      readSymbols: false,
      // WrongProxy / WrongTrace. Defaults match the WebUI LocalPrefs
      // (master switch off; URL 'http://localhost:8000'). The runtime
      // probe in `packages/cli/src/wiring/proxy-probe.ts` reacts via
      // the WS `prefs.update` pipeline — these initial values only
      // cover the slice before the first `settingsOpen` action lands.
      wrongProxyEnabled: false,
      wrongProxyUrl: 'http://localhost:8000',
      // WrongProxy URL text-edit state (field 60). The reducer quartet
      // at `reducers/settings-values.ts:733-801` seeds the draft from
      // `wrongProxyUrl` on Start and clears it on Commit/Cancel.
      wrongProxyUrlEditing: false,
      wrongProxyUrlDraft: '',
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
    shellCommandWarning: null,
    enhance: null,
    enhanceEnabled,
    enhanceBusy: false,
    topicCheckBusy: false,
    refineCountdown: null,
    refineCountdownGen: 0,
    refineFailure: null,
    continueConfirm: null,
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
    fleetChat,
    monitorOpen: false,
    agentsMonitorOpen: initialAgentsMonitorOpen ?? false,
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
    checkpoints: restoredCheckpoints ?? [],
    rewindOverlay: null,
    eternalStage: null,
    goalSummary: null,
    goalRun: null,
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
    viewportRows: 0,
    historyScrolled: false,
    debugStreamStats: null,
    countdown: null,
  };
}
