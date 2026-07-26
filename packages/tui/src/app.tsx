import * as path from 'node:path';
import type { Director } from '@wrongstack/core/coordination';
import type { ContentBlock } from '@wrongstack/core/types';
import {
  applyRewindToConversation,
  DefaultSessionRewinder,
  type PromptUsageStore,
} from '@wrongstack/core/storage';
import { InputBuilder } from '@wrongstack/core/agent';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import {
  buildRestoredCheckpoints,
  buildRestoredEntries,
  createInitialState,
} from './app-initial-state.js';
// Types imported from app-reducer.ts (single source of truth for reducer + State types)
import { reducer, type State } from './app-reducer.js';
import { leaderTimelineFromEntries } from './components/agents-monitor.js';
import type { HistoryScrollController } from './components/scrollable-history.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import { useAuthPanel } from './hooks/use-auth-panel.js';
import { useAppPickerKeys } from './hooks/use-app-picker-keys.js';
import { useAutonomyDrivers } from './hooks/use-autonomy-drivers.js';
import { useAutonomousCoordinator } from './hooks/use-autonomous-coordinator.js';
import { useBrainPanel } from './hooks/use-brain-panel.js';
import { useBrainRiskSync } from './hooks/use-brain-risk-sync.js';
import { useClientTelemetry } from './hooks/use-client-telemetry.js';
import { useCoreTuiCommands } from './hooks/use-core-tui-commands.js';
import { useDirectorFleetBridge } from './hooks/use-director-fleet-bridge.js';
import { useFileSearch } from './hooks/use-file-search.js';
import { useHelpPanel } from './hooks/use-help-panel.js';
import { useInputHistoryPersistence } from './hooks/use-input-history-persistence.js';
import { useInitialPrompt } from './hooks/use-initial-prompt.js';
import { useInterruptLadder } from './hooks/use-interrupt-ladder.js';
import { useGitSessionStatus } from './hooks/use-git-session-status.js';
import { useHistoryCopyNotice } from './hooks/use-history-copy-notice.js';
import { useHistoryViewportSync } from './hooks/use-history-viewport-sync.js';
import { useKanbanBoardFocus } from './hooks/use-kanban-board-focus.js';
import { useLiveTodos } from './hooks/use-live-todos.js';
import { useLiveSettingsState } from './hooks/use-live-settings-state.js';
import { useMailboxViewModel } from './hooks/use-mailbox-view-model.js';
import { useMouseTracking } from './hooks/use-mouse-tracking.js';
import { useNextStepsAutoSubmit } from './hooks/use-next-steps-auto-submit.js';
import { usePanelControllers } from './hooks/use-panel-controllers.js';
import { useModePicker } from './hooks/use-mode-picker.js';
import { useModelPickRequest } from './hooks/use-model-pick.js';
import { usePasteHandling } from './hooks/use-paste-handling.js';
import { usePromptPicker } from './hooks/use-prompt-picker.js';
import { useProviderEventBridge } from './hooks/use-provider-event-bridge.js';
import { useQueueManager } from './hooks/use-queue-manager.js';
import { useSessionInterruptController } from './hooks/use-session-interrupt-controller.js';
import { useSettingsAutoSave } from './hooks/use-settings-auto-save.js';
import { useSlashPicker } from './hooks/use-slash-picker.js';
import { useShadowPanel } from './hooks/use-shadow-panel.js';
import { useStatuslineHiddenSync } from './hooks/use-statusline-hidden-sync.js';
import { useStableKeyHandler } from './hooks/use-stable-key-handler.js';
import { useStatusbarViewModel } from './hooks/use-statusbar-view-model.js';
import { useTuiEnvironmentState } from './hooks/use-tui-environment-state.js';
import { useStreamChipExpiration } from './hooks/use-stream-chip-expiration.js';
import { useTerminalRenderLifecycle } from './hooks/use-terminal-render-lifecycle.js';
import { useTuiActivity } from './hooks/use-tui-activity.js';
import { useTuiControllers } from './hooks/use-tui-controllers.js';
import { useTuiEventBridge } from './hooks/use-tui-event-bridge.js';
import { useTuiSlashCommands } from './hooks/use-tui-slash-commands.js';
import { useWorkingDirChip } from './hooks/use-working-dir-chip.js';
import { useExitCommand } from './hooks/use-exit-command.js';
import { useEnhanceRuntimeState } from './hooks/use-enhance-runtime-state.js';
import { useApp, useStdout } from './ink.js';
import { deriveAppViewState } from './app-view-state.js';
import { isPickerOverlayOpen, mergeStatuslineHiddenItems } from './app-ui-state.js';
import { AppView } from './app-view.js';
import { LayoutStore } from './layout-store.js';
import { createRunBlocksController } from './run-blocks-controller.js';
import { createSubmitController } from './submit-controller.js';
import { TokenPreviewStore } from './token-previews.js';

export {
  type Action,
  type FleetEntry,
  type QueueItem,
  type ResumeSessionEntry,
  reducer,
  type Settings,
  type SlashCommandMatch,
  type State,
} from './app-reducer.js';
export { renderRunningTools } from './running-tools.js';

export { selectedSlashCommandLine } from './slash-command-search.js';

// Re-exported so existing imports from '../src/app.js' keep working. The
// composer key controller consumes the implementation directly from
// input-key-router.ts.
export { nextInputWordStart, previousInputWordStart } from './input-editing.js';

// The host<->TUI props contract lives in app-props.ts (app.tsx is line-capped
// by the hotspot guardrail). Re-exported here so consumers importing AppProps
// from '@wrongstack/tui' / '../src/app.js' keep working.
import type { AppProps } from './app-props.js';
import { createAppKeyHandler } from './app-key-handler.js';

export type { AppProps } from './app-props.js';

// `buildGoalPreamble` was relocated to @wrongstack/core so headless and
// WebUI callers (which depend on @wrongstack/cli but not @wrongstack/tui)
// can issue `/goal set` without dragging the TUI package in. Re-exported
// from this module for backward compatibility with consumers still
// importing from @wrongstack/tui; also used locally within this file
// where `/goal …` is wired into the chat-input handler.
export { buildGoalPreamble } from '@wrongstack/core/execution';
// Re-exported for backward compatibility with tests importing from '../src/app.js'.
// Actual implementation lives in ./steering-preamble.ts.
export { buildSteeringPreamble } from './steering-preamble.js';

export function App(props: AppProps): React.ReactElement {
  const {
  agent,
  slashRegistry,
  secretInputController,
  attachments,
  events,
  tokenCounter,
  visionAdapters = [],
  supportsVision,
  model,
  banner = true,
  queueStore,
  onQueueChange,
  yolo = false,
  chime = false,
  confirmExit = true,
  titleController,
  mouse = false,
  capability,
  enhanceEnabled = true,
  enhanceController,
  midRunSendPicker = true,
  enhanceDelayMs = 15_000,
  getEnhancerReasoning,
  buildEnhancerProvider,
  getEnhanceFallbackRef,
  getConfiguredRefinerRef,
  getYolo,
  getAutonomy,
  getEternalEngine,
  getParallelEngine,
  getSddRun,
  onSddLifecycle,
  subscribeEternalIteration,
  subscribeEternalStage,
  subscribeGoal,
  getSDDContext,
  onSDDOutput,
  appVersion,
  provider,
  family,
  keyTail,
  profile,
  profileConfigPath,
  autonomyAgents,
  toolCount,
  getPickableProviders,
  switchProviderAndModel,
  getSettings,
  saveSettings,
  getPluginItems,
  onPluginToggle,
  getMcpServers,
  onMcpToggle,
  onMcpRestart,
  getToolsItems,
  onToolToggle,
  getBrainData,
  onBrainRiskLevel,
  brainPanelHost,
  getShadowData,
  onShadowStart,
  onShadowStop,
  authHost,
  predictNext,
  onSuggestionsParsed,
  getSuggestions,
  getAutoSuggestions,
  autonomyNextPrompt,
  setSuggestions,
  switchAutonomy,
  effectiveMaxContext,
  onExit,
  director,
  getDirector,
  onClearHistory,
  clearTerminal,
  listSessions,
  fleetStreamController,
  interruptController,
  statuslineHiddenItems,
  setStatuslineHiddenItems,
  saveStatuslineHiddenItems,
  agentsMonitorController,
  initialGoal,
  initialAsk,
  sessionsDir,
  modeLabel,
  getModeLabel,
  getModes,
  registerDebugStreamCallback,
  restoreDebugStreamCallback,
  restoredMessages,
  restoredToolCalls,
  restoredEvents,
  getProjectPickerItems,
  getLiveSessions,
  initialAgentsMonitorOpen,
  onPanelOpen,
  subscribeCoordinatorEvents,
  // Reserved for the coordinator monitor panel: terminal-driven task discovery/claim.
  onCoordinatorTasks: _onCoordinatorTasks,
  onCoordinatorClaim: _onCoordinatorClaim,
  coordinatorRunning = false,
  clientId,
  memoryStore,
  } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const environment = useTuiEnvironmentState({
    events,
    memoryStore,
    model,
    provider,
    effectiveMaxContext,
    yolo,
    getAutonomy,
    modeLabel,
    statuslineHiddenItems,
    toolCount,
    getSettings,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
  });
  const {
    liveModel,
    setLiveModel,
    liveProvider,
    setLiveProvider,
    activeMaxContext,
    setActiveMaxContext,
    yoloLive,
    setYoloLive,
    autonomyLive,
    setAutonomyLive,
    liveModeLabel,
    setLiveModeLabel,
    hiddenItems,
    setHiddenItems,
    setSessionCount,
    hiddenItemsRef,
    setMemoryContextMonitor,
    memoryContextMonitorRef,
    memoryRecordTotalRef,
    setLiveToolCount,
  } = environment;

  // Statusline picker → status bar sync lives after useReducer (see below) —
  // it reads `state.statuslinePicker`, which doesn't exist until the reducer
  // is declared. Keeping it here would reference `state` in the temporal dead
  // zone ("Cannot access 'state' before initialization").

  // Stream chip auto-expiration code lives after useReducer (see below).

  const projectRoot = agent.ctx.projectRoot;
  const liveTodos = useLiveTodos(agent.ctx);
  const promptUsageRef = useRef<PromptUsageStore | null>(null);

  // Rehydrate prior-session data once for each stable resume payload. App
  // re-renders continuously while timers, provider deltas, and tool events are
  // active; replaying the complete JSONL-backed transcript on every such render
  // creates session-sized temporary maps/arrays that useReducer never consumes
  // after its initial mount.
  const restoredMessageSource = restoredMessages ?? agent.ctx.messages;
  const restoredEntries = useMemo(
    () => buildRestoredEntries(restoredMessageSource, restoredToolCalls, restoredEvents),
    [restoredMessageSource, restoredToolCalls, restoredEvents],
  );
  // Checkpoints likewise only reach state via the live checkpoint.written
  // bridge, so a resumed session would have none and /rewind would refuse.
  const restoredCheckpoints = useMemo(
    () => buildRestoredCheckpoints(restoredEvents),
    [restoredEvents],
  );

  const [state, rawDispatch] = useReducer(
    reducer,
    createInitialState({
      banner,
      appVersion,
      provider,
      model,
      cwd: agent.ctx.cwd,
      family,
      keyTail,
      sessionId: agent.ctx.session.id,
      profile,
      profileConfigPath,
      autonomyAgents,
      restoredEntries,
      restoredCheckpoints,
      enhanceEnabled,
      initialAgentsMonitorOpen,
      initialFleetChat: fleetStreamController?.mode,
    }),
  );
  // Reducer actions created inside the React tree are already constrained by
  // the Action discriminated union. Do not route them through the validator
  // for untrusted external payloads: a stale runtime allow-list used to drop
  // valid UI actions silently (status changes, slash panels, queueing, picker
  // navigation) and made the entire composer appear frozen.
  const dispatch = rawDispatch;

  // ── Layout store (virtual-scroll position cache) ────────────────────
  // Created per session; persists entry height data to disk so resumed
  // sessions reconstruct the virtual viewport without remounting every entry.
  // Ephemeral mode is used when no sessionsDir is available (test/adhoc).
  const layoutStore = useMemo(
    () =>
      new LayoutStore({
        sessionDataDir: sessionsDir,
        ephemeral: !sessionsDir,
      }),
    [sessionsDir],
  );
  // On mount: load previously-persisted layout data and start the debounced
  // flush cycle. Cleanup: flush on unmount so no data is lost.
  useEffect(() => {
    void layoutStore.load();
    return () => {
      void layoutStore.flushNow();
    };
  }, [layoutStore]);
  // Imperative scroll surface assigned by ScrollableHistory: all scroll math
  // (wheel, PgUp/PgDn, scrollbar clicks, submit-time re-pin) runs inside the
  // component, where the live height cache lives. The app only learns about
  // scroll-state transitions through the stable onScrollInfo callback, which
  // drives the "managed" key hint.
  const historyScrollRef = useRef<HistoryScrollController | null>(null);
  const onScrollInfo = useCallback(
    (info: { scrolled: boolean }) =>
      dispatch({ type: 'setHistoryScrolled', scrolled: info.scrolled }),
    [dispatch],
  );
  const onHistoryCopy = useHistoryCopyNotice(dispatch);
  const { focusedBoardId, setFocusedBoardId, boardFocusRef } = useKanbanBoardFocus();

  useInputHistoryPersistence({
    projectRoot,
    inputHistory: state.inputHistory,
    dispatch,
  });

  const { openPromptPicker } = usePromptPicker({ projectRoot, dispatch });

  const { openModePicker } = useModePicker({ dispatch, getModes });

  // ── Brain panel + shared /model overlay in generic 'pick' mode ─
  const { requestModelPick, handleModelPicked } = useModelPickRequest({
    dispatch,
    getPickableProviders,
    pickerOpen: state.modelPicker.open,
  });
  const brainCtl = useBrainPanel({ dispatch, getBrainData, brainPanelHost, requestModelPick });
  const openBrainPanel = brainCtl.openBrainPanel;
  const { changeBrainRisk } = useBrainRiskSync({
    dispatch,
    riskLevel: state.brainPanel.riskLevel,
    brainPanelOpen: state.brainPanel.open,
    onBrainRiskLevel,
  });

  // ── Shadow Agent panel ─────────────────────────────────────────
  const { openShadowPanel, handleShadowStart, handleShadowStop } = useShadowPanel(dispatch, {
    getShadowData,
    onShadowStart,
    onShadowStop,
  });

  // ── Help panel ──────────────────────────────────────────────────
  const { openHelpPanel } = useHelpPanel(dispatch, slashRegistry);

  useStatuslineHiddenSync({
    pickerOpen: state.statuslinePicker.open,
    pickerHidden: state.statuslinePicker.hiddenItems,
    hiddenItems,
    setHiddenItems: (items) => setHiddenItems(items as typeof hiddenItems),
  });

  useStreamChipExpiration({
    brainPrompt: state.brainPrompt,
    enhance: state.enhance,
    visibleChips: state.statuslinePicker.visibleChips,
    dispatch,
  });

  // ── AutonomousCoordinator bridge ─────────────────────────────────────
  // Wire project-level coordinator events into the TUI reducer so the
  // CoordinatorPanel can render live goals, tasks, and knowledge.
  useAutonomousCoordinator(subscribeCoordinatorEvents, dispatch);

  const builderRef = useRef<InputBuilder | null>(null);
  if (builderRef.current === null) {
    builderRef.current = new InputBuilder({ store: attachments });
  }

  const activeCtrlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeCtrlRef.current?.abort('TUI unmounted');
      activeCtrlRef.current = null;
    },
    [],
  );
  const eternalLoopRunningRef = useRef(false);
  const parallelLoopRunningRef = useRef(false);
  // `/clear` waits for the complete runBlocks lifecycle before resetting Context.
  const activeRunSettledRef = useRef<Promise<void>>(Promise.resolve());
  // Set once we've asked Ink to unmount on a Ctrl+C exit. A synchronous ref
  // (not React state) because consecutive SIGINTs can fire faster than a
  // re-render — without it, `stateRef.current.interrupts` reads stale and a
  // wedged unmount could never escalate to a hard exit.
  const exitRequestedRef = useRef(false);
  // Prevent re-entrant handleKey: some terminals emit \r\n as two separate
  // stdin events for Enter. While the first event is being processed (submit
  // or picker accept), the second arrives with stale state and would trigger
  // a duplicate action. The gate blocks the stale-second event entirely.
  const inputGateRef = useRef(false);
  // Separate guard JUST for the submit path. The full `inputGateRef`
  // is held across `await foo()` blocks (picker accept, model picker
  // commit) — that's fine because those resolve in milliseconds. But
  // `await submit()` resolves only when `agent.run()` finishes, which
  // can be minutes for a delegated subagent task. Using the same gate
  // would lock ALL keystrokes (typing, backspace, slash menu) for the
  // entire agent run. This timestamp-based guard fires for the few
  // milliseconds needed to debounce a terminal-side `\r\n` double-event
  // and then auto-releases — leaving the input live for the user.
  const lastEnterAtRef = useRef(0);
  // Maps an inline attachment token (e.g. `[pasted #1, 123 lines]`) to a short
  // preview of its content, so the chat-history entry can show the collapsed
  // text below the message. Bounded (count + chars, LRU-evicted) — values hold
  // full paste/file contents, so an unbounded map would leak MBs per session.
  const tokenPreviewsRef = useRef(new TokenPreviewStore());
  // The status-bar chip surfaces the basename so multiple WrongStack
  // windows running against different repos are immediately distinguishable.
  // Empty / root fallback to undefined so the chip just hides itself.
  const projectName = React.useMemo(() => {
    const base = path.basename(projectRoot);
    return base && base !== path.sep ? base : undefined;
  }, [projectRoot]);

  const workingDirChip = useWorkingDirChip(agent.ctx, projectRoot);

  const {
    liveSettings,
    liveStatuslineMode,
    liveAnimationStyle,
    liveThinkingWord,
    chimeRef,
    confirmExitRef,
  } = useLiveSettingsState({ getSettings, titleController, chime, confirmExit });

  // Source of truth for the streamed assistant text — kept here, not in
  // React state, because we need to read it synchronously when `agent.run`
  // returns. The React `streamingText` shown in the live tail is throttled
  // (~10fps) for redraw cost, so it can lag the actual stream by up to
  // FLUSH_MS. Reading from this ref instead removes the race where the
  // final chunk lands in pending after run() returns and ends up flashing
  // into the next frame's tail (leaking into scrollback).
  const streamingTextRef = useRef('');
  const streamSegmentsRef = useRef<Array<{ kind: 'assistant' | 'thinking'; text: string }>>([]);
  const pendingDeltaRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generations prevent a cooperatively aborted run from writing after `/clear`.
  const sessionGenerationRef = useRef(0);
  const activeRunGenerationRef = useRef(0);
  // Set synchronously by the `provider.response` listener whenever it commits
  // an assistant text entry during the current run. `runBlocks` reads it after
  // `agent.run()` returns to decide whether the `finalText` recovery path is
  // still needed. A ref (not `stateRef`) is mandatory here: the per-iteration
  // `addEntry` dispatch has NOT been flushed into `stateRef` by the time
  // runBlocks resumes on the awaited continuation, so a state-based check reads
  // a stale entry count and re-commits the final message (the "final reply
  // shown twice" bug).
  const assistantCommittedThisRunRef = useRef(false);

  // Latest state snapshot — async callbacks (the queue drainer, slash command
  // closures) read this instead of capturing `state` to avoid stale closures.
  const stateRef = useRef<State>(state);
  stateRef.current = state;
  const draftRef = useRef({ buffer: state.buffer, cursor: state.cursor });
  draftRef.current = { buffer: state.buffer, cursor: state.cursor };
  const activity = useTuiActivity({
    status: state.status,
    fleet: state.fleet,
    enhanceBusy: state.enhanceBusy,
    thinkingWord: liveThinkingWord,
    projectRoot,
    stateRef,
    agentContext: agent.ctx,
    dispatch,
  });
  const {
    displayThinkingWord,
    refreshGoalSummary,
  } = activity;

  // Live director accessor. The static `director` prop is captured at boot
  // and stays null when the fleet host builds its director LAZILY (first
  // delegate/spawn in a non---director session). Every fleet-teardown path
  // (Ctrl+C, Esc, /steer) must resolve through this or it silently no-ops
  // on lazily spawned subagents.
  const liveDirector = useCallback(
    (): Director | null => getDirector?.() ?? director,
    [getDirector, director],
  );

  // Tear down pending tool-confirm panels when a run is aborted. The agent
  // side resolves the underlying promises as 'abort' via its signal listener
  // (which fires synchronously inside `activeCtrlRef.abort()`), so the
  // resolve('no') here is an idempotent belt-and-braces — a settled promise
  // ignores it — guaranteeing the executor can never stay parked on a dead
  // prompt. The dispatch returns input routing to the composer.
  const clearPendingConfirms = useCallback(() => {
    const queue = stateRef.current.confirmQueue;
    if (queue.length === 0) return;
    for (const c of queue) {
      try {
        c.resolve('no');
      } catch {
        /* already settled */
      }
    }
    dispatch({ type: 'confirmClearAll' });
  }, [dispatch]);

  // Interactive /auth panel controller — owns provider/key mutations, the
  // flow runner (catalog/custom/local adds, OAuth sign-in) and its modal
  // prompt plumbing. All side effects go through the CLI-provided authHost.
  const authPanelController = useAuthPanel({
    authHost,
    stateRef,
    dispatch,
    open: state.authPanel.open,
  });

  useEffect(() => {
    if (!secretInputController) return;
    const previousSecret = secretInputController.readSecret;
    const previousText = secretInputController.readText;
    secretInputController.readSecret = authPanelController.readSecret;
    secretInputController.readText = authPanelController.readText;
    return () => {
      secretInputController.readSecret = previousSecret;
      if (previousText) secretInputController.readText = previousText;
      else delete secretInputController.readText;
    };
  }, [secretInputController, authPanelController.readSecret, authPanelController.readText]);

  const statuslineHiddenForPicker = useCallback((): StatuslineItem[] => {
    return mergeStatuslineHiddenItems(
      hiddenItemsRef.current,
      stateRef.current.statuslinePicker.hiddenItems,
    );
  }, []);

  const openStatuslinePicker = useCallback(
    (field?: number) => {
      if (field !== undefined) {
        dispatch({ type: 'statuslineFieldSet', field });
      }
      dispatch({ type: 'statuslineOpen', hiddenItems: statuslineHiddenForPicker() });
    },
    [statuslineHiddenForPicker],
  );

  // Live mirror of the full-session pointer opt-in. The managed history always
  // owns wheel input because virtualized rows do not exist in native terminal
  // scrollback. Track clicks work in managed mode; full mode additionally
  // enables pointer drag and clickable app chrome.
  const pickerOverlayOpen = isPickerOverlayOpen(state);
  const { mouseMode, setMouseMode } = useMouseTracking({
    initialMouseMode: mouse,
    overlayOpen: pickerOverlayOpen,
    protocol: capability?.mouseProtocol,
    stdout,
  });

  const { bottomRegionRef, statusBarWrapRef, belowStatusBarRef, termRows } =
    useHistoryViewportSync({
      stdoutRows: stdout?.rows,
      viewportRows: state.viewportRows,
      setViewportRows: (rows) => dispatch({ type: 'setViewportRows', rows }),
  });
  // handleRewindTo must be declared before the /rewind useEffect (line 1803)
  // so the closure can capture it. It is intentionally NOT in useCallback
  // — each call needs a fresh rewinder referencing the current sessionsDir.
  const handleRewindTo = React.useCallback(
    async (checkpointIndex: number) => {
      const sessionId = agent.ctx.session.id;
      if (!sessionId) return;
      const rewinder = new DefaultSessionRewinder(
        sessionsDir ?? '',
        agent.ctx.projectRoot ?? agent.ctx.cwd,
      );
      // Revert file system changes first (read-only, safe to do eagerly).
      const reverted = await rewinder.rewindToCheckpoint(sessionId, checkpointIndex);
      // Then cut BOTH the JSONL and the live conversation back to the
      // checkpoint. Truncating the log alone would leave the model answering
      // the next prompt against the rewound turns it still holds in memory.
      // This fires session.rewound on the EventBus, which the useEffect at
      // line 2212 listens to and dispatches sessionRewound + clearHistory.
      await applyRewindToConversation({
        session: agent.ctx.session,
        state: agent.ctx.state,
        sessionsDir: sessionsDir ?? '',
        promptIndex: checkpointIndex,
        revertedFiles: reverted.revertedFiles,
      });
    },
    [agent.ctx.session, sessionsDir, agent.ctx.projectRoot, agent.ctx.cwd],
  );

  const setDraft = (buffer: string, cursor: number): void => {
    draftRef.current = { buffer, cursor };
    dispatch({ type: 'setBuffer', buffer, cursor });
  };

  const clearDraft = (): void => {
    draftRef.current = { buffer: '', cursor: 0 };
    dispatch({ type: 'clearInput' });
  };

  // ── Consolidated 2s tick: autonomy/yolo/mode/model/provider sync ──
  const staleGuardRef = useRef(JSON.stringify({ a: '', y: false, m: '', model: '', provider: '' }));
  useEffect(() => {
    const poll = () => {
      // ── Status-bar live sync (autonomy, yolo, mode, model, provider) ──
      const a = getAutonomy?.() ?? 'off';
      const y = getYolo?.() ?? false;
      const m = getModeLabel?.() ?? '';
      const curModel = agent.ctx.model;
      const curProvider = (agent.ctx.provider as { id?: string | undefined } | undefined)?.id ?? '';
      const snap = JSON.stringify({ a, y, m, model: curModel, provider: curProvider });
      if (snap !== staleGuardRef.current) {
        staleGuardRef.current = snap;
        if (a !== autonomyLive) setAutonomyLive(a);
        if (y !== yoloLive) setYoloLive(y);
        if (m !== liveModeLabel) setLiveModeLabel(m);
        if (curModel !== liveModel) setLiveModel(curModel);
        if (curProvider !== liveProvider) setLiveProvider(curProvider);
        if (a === 'eternal' && getEternalEngine) void runEternalLoopRef.current();
        if (a === 'eternal-parallel' && getParallelEngine) void runParallelLoopRef.current();
      }
    };
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [
    getAutonomy,
    getYolo,
    getModeLabel,
    getEternalEngine,
    getParallelEngine,
    autonomyLive,
    yoloLive,
    liveModeLabel,
    liveModel,
    liveProvider,
    agent.ctx.model,
    agent.ctx.provider,
  ]);

  const gitInfo = useGitSessionStatus({ agent, getLiveSessions, setSessionCount });

  const mailbox = useMailboxViewModel(events);
  const {
    setMailboxPanelOpen,
  } = mailbox;

  const statusbar = useStatusbarViewModel({
    agent,
    tokenCounter,
    activeMaxContext,
    effectiveMaxContext,
    liveProvider,
    liveModel,
    liveTodos,
    state,
  });
  const {
    todos,
    fleetCounts,
  } = statusbar;

  useTerminalRenderLifecycle(state);

  const acceptSlashPickerSelection = useSlashPicker({
    state,
    slashRegistry,
    dispatch,
    setDraft,
  });

  const { getCronJobs, runSteerSequence } = useCoreTuiCommands({
    agent,
    slashRegistry,
    memoryStore,
    onPanelOpen,
    memoryContextMonitorRef,
    memoryRecordTotalRef,
    stateRef,
    boardFocusRef,
    setFocusedBoardId,
    terminalWidth: stdout.columns ?? 80,
    getModeLabel,
    activeCtrlRef,
    clearPendingConfirms,
    dispatch,
    liveDirector,
    streamingTextRef,
    director,
    handleRewindTo,
  });

  // `/goal` is registered as a CLI builtin (packages/cli/src/slash-commands/
  // goal.ts) which handles both the preamble lock-in (the former TUI
  // behavior) and goal.json persistence for /autonomy eternal. The TUI
  // does NOT register its own /goal here — that would collide with the
  // builtin and throw "already registered" on mount.

  const panelControllers = usePanelControllers({
    state,
    stateRef,
    dispatch,
    getPickableProviders,
    getProjectPickerItems,
    getLiveSessions,
    onPanelOpen,
    openStatuslinePicker,
    openAuthPanel: authPanelController.openAuthPanel,
    openModePicker,
    openBrainPanel,
    openShadowPanel,
    openHelpPanel,
    getSettings,
    getPluginItems,
    onPluginToggle,
    getMcpServers,
    onMcpToggle,
    onMcpRestart,
    getToolsItems,
    onToolToggle,
    setLiveToolCount,
  });
  const {
    openModelPicker,
    openProjectPicker,
    openFKeyPicker,
    loadLiveSessions,
    openSettings,
  } = panelControllers;

  // NOTE: there is deliberately NO local "auto-proceed countdown" timer here.
  // The StatusBar's "⏳ auto in Ns" chip is driven exclusively by real
  // `countdown.tick` events (state.countdown) emitted while an actual
  // auto-proceed cooldown runs. A previous display-only local timer started
  // the moment autonomy flipped to 'auto' — with no suggestions and nothing
  // pending it showed a phantom 45s countdown on an idle, empty session,
  // then silently vanished. The real TUI-side countdown (with execution) is
  // the next-steps auto-submit below.

  const runBlocksRef = useRef<(blocks: ContentBlock[]) => Promise<void>>(async () => undefined);
  const {
    nextStepsAutoSubmitCountdown,
    nextStepsAutoSubmitLabel,
    setNextStepsAutoSubmitCountdown,
    setNextStepsAutoSubmitLabel,
    nextStepsAutoSubmitSuggestionRef,
    nextStepsAutoSubmitTimerRef,
    autoSubmitStreakRef,
    autoSubmitCapWarnedRef,
    autoSubmitLoopGuardRef,
    cancelNextStepsCountdown,
  } = useNextStepsAutoSubmit({
    state,
    autonomyLive,
    agent,
    getAutonomy,
    getSettings,
    getSuggestions,
    getAutoSuggestions,
    getYolo,
    setSuggestions,
    autonomyNextPrompt,
    dispatch,
    clearDraft,
    runBlocksRef,
  });

  useSettingsAutoSave(state, saveSettings, dispatch);

  useTuiSlashCommands({
    slashRegistry,
    getPickableProviders,
    switchProviderAndModel,
    openModelPicker,
    openFKeyPicker,
    projectRoot,
    agent,
    dispatch,
    getSettings,
    saveSettings,
    openSettings,
    state,
    openStatuslinePicker,
    setHiddenItems,
    hiddenItemsRef,
    setMailboxPanelOpen,
    switchAutonomy,
    listSessions,
  });

  useProviderEventBridge({
    events,
    agent,
    dispatch,
    streamingTextRef,
    streamSegmentsRef,
    pendingDeltaRef,
    flushTimerRef,
    sessionGenerationRef,
    activeRunGenerationRef,
    assistantCommittedThisRunRef,
    setMemoryContextMonitor,
  });

  useClientTelemetry({
    events,
    clientId,
    tokenCounter,
    getAutonomy,
    agent,
    registerDebugStreamCallback,
    restoreDebugStreamCallback,
    dispatch,
  });

  const {
    enhanceEnabledRef,
    midRunSendPickerRef,
    enhanceAbortRef,
    enhanceCancelledRef,
    enhanceOriginalRef,
    enhanceCountdown,
    setEnhanceCountdown,
    enhanceStartedAt,
    setEnhanceStartedAt,
    enhanceDurationMs,
    setEnhanceDurationMs,
    refineProviderId,
    setRefineProviderId,
    refineModel,
    setRefineModel,
  } = useEnhanceRuntimeState({
    enhanceEnabled: state.enhanceEnabled,
    midRunSendPicker,
  });

  // ── Paste handling ──────────────────────────────────────────────────
  const {
    pasteAccumRef,
    pasteFlushTimerRef,
    commitPaste,
    pasteClipboardImage,
    pasteClipboardText,
  } = usePasteHandling({
    builderRef,
    dispatch,
    draftRef,
    setDraft,
    tokenPreviewsRef,
  });

  // ── Queue lifecycle ─────────────────────────────────────────────────
  useQueueManager({
    queueStore,
    onQueueChange,
    slashRegistry,
    stateRef,
    dispatch,
    getSettings,
    saveSettings,
    midRunSendPickerRef,
  });

  const getActiveSessionId = useCallback(() => agent.ctx.session.id, [agent]);

  // LEADER's own history for the F3 per-agent transcript view: the main
  // chat entries WITHOUT subagent lines. Read through stateRef at call
  // time (the monitor polls on its 1s tick) so this callback stays stable.
  const getLeaderTranscript = useCallback(
    () => leaderTimelineFromEntries(stateRef.current.entries),
    [stateRef],
  );

  useTuiEventBridge({
    events,
    dispatch,
    stateRef,
    setActiveMaxContext,
    getSessionId: getActiveSessionId,
    subscribeGoal,
    onClearHistory,
    sessionGenerationRef,
  });

  useTuiControllers({
    dispatch,
    fleetChat: state.fleetChat,
    enhanceEnabled: state.enhanceEnabled,
    agentsMonitorOpen: state.agentsMonitorOpen,
    fleetStreamController,
    enhanceController,
    agentsMonitorController,
  });

  useSessionInterruptController({
    interruptController,
    dispatch,
    stateRef,
    activeCtrlRef,
    activeRunSettledRef,
    sessionGenerationRef,
    streamingTextRef,
    streamSegmentsRef,
    pendingDeltaRef,
    assistantCommittedThisRunRef,
    flushTimerRef,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
    clearPendingConfirms,
    getEternalEngine,
    getParallelEngine,
    getSddRun,
    switchAutonomy,
  });

  // `/exit` confirmation bridge. Mirrors the `/clear` invariant: while a
  // leader run or any subagent is still active, `/exit` must not
  // terminate the TUI silently. The hook registers the slash command,
  // opens an `exitConfirm` panel when needed, then uses the shared interrupt
  // lifecycle to abort the leader/background drivers and await leader-idle plus
  // fleet teardown (capped at 1500 ms) before Ink is allowed to unmount.
  useExitCommand({
    slashRegistry,
    dispatch,
    exitConfirm: state.exitConfirm,
    stateRef,
    sessionGenerationRef,
    interruptController,
    getDirector: liveDirector,
  });

  // Track double-Esc for input buffer clearing.
  const lastEscAtRef = useRef(0);
  // Tracks when EscConfirmPrompt was last dismissed so the main handler
  // doesn't immediately re-open it on the same keystroke.
  const dismissedEscAtRef = useRef(0);

  useDirectorFleetBridge({
    director,
    dispatch,
    stateRef,
    chatMode: state.fleetChat,
    sessionGenerationRef,
  });

  // ── File search (@-token detection + picker selection) ───────────
  const { onPickerEnter } = useFileSearch({
    state,
    dispatch,
    projectRoot,
    builderRef,
    draftRef,
    setDraft,
    tokenPreviewsRef,
  });

  // submit is defined later in the component body (after handleKey);
  // this ref lets usePickerKeys call it without reordering code.
  const submitRef = useRef<(text?: string) => void>(() => {});

  const tryPickerKey = useAppPickerKeys({
    host: props,
    state,
    dispatch,
    environment,
    statusbar,
    panelControllers,
    authPanelController,
    brainController: brainCtl,
    lastEnterAtRef,
    inputGateRef,
    submitRef,
    promptUsageRef,
    setDraft,
    acceptSlashPickerSelection,
    changeBrainRisk,
    handleModelPicked,
    handleShadowStart,
    handleShadowStop,
    statuslineHiddenForPicker,
    onPickerEnter,
  });
  const { interruptsSyncRef, runInterruptLadder } = useInterruptLadder({
    stateRef,
    exitRequestedRef,
    agent,
    liveDirector,
    onExit,
    exit,
    dispatch,
    activeCtrlRef,
    clearPendingConfirms,
    getEternalEngine,
    getParallelEngine,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
    switchAutonomy,
    getSddRun,
    confirmExitRef,
  });

  const handleKey = createAppKeyHandler({
    state,
    dispatch,
    historyScrollRef,
    runInterruptLadder,
    enhanceCancelledRef,
    enhanceAbortRef,
    inputGateRef,
    lastEscAtRef,
    pasteAccumRef,
    pasteFlushTimerRef,
    commitPaste,
    tryPickerKey,
    dismissedEscAtRef,
    streamingTextRef,
    confirmExitRef,
    activeCtrlRef,
    clearPendingConfirms,
    liveDirector,
    openProjectPicker,
    loadLiveSessions,
    openStatuslinePicker,
    statuslineHiddenItems,
    getSddRun,
    onSddLifecycle,
    getSettings,
    saveSettings,
    lastEnterAtRef,
    draftRef,
    setDraft,
    submit: () => submitRef.current(),
    mouseMode,
    termRows,
    terminalColumns: stdout?.columns ?? 80,
    terminalRows: stdout?.rows ?? 24,
    statusBarWrapRef,
    belowStatusBarRef,
    liveStatuslineMode,
    statuslineHiddenForPicker,
    liveModel,
    liveProvider,
    yoloLive,
    autonomyLive,
    projectName,
    workingDirChip,
    todos,
    openModelPicker,
    nextStepsAutoSubmitTimerRef,
    nextStepsAutoSubmitSuggestionRef,
    nextStepsAutoSubmitLabel,
    setNextStepsAutoSubmitCountdown,
    setNextStepsAutoSubmitLabel,
    cancelNextStepsCountdown,
    pasteClipboardText,
    pasteClipboardImage,
    slashRegistry,
    agent,
    onHistoryCopy,
  });

  /**
   * Drive a single iteration: run the agent against `blocks`, render the
   * result into history, then if any messages were typed while we were
   * busy, pull the head of the queue and recurse. Recursion terminates
   * when the queue is empty (status stays idle).
   */
  const runBlocks = createRunBlocksController({
    capabilities: {
      agent,
      tokenCounter,
      supportsVision,
      visionAdapters,
      onSDDOutput,
      onSuggestionsParsed,
      predictNext,
    },
    refs: {
      sessionGeneration: sessionGenerationRef,
      activeRunGeneration: activeRunGenerationRef,
      activeRunSettled: activeRunSettledRef,
      activeController: activeCtrlRef,
      interrupts: interruptsSyncRef,
      assistantCommitted: assistantCommittedThisRunRef,
      streamingText: streamingTextRef,
      streamSegments: streamSegmentsRef,
      pendingDelta: pendingDeltaRef,
      flushTimer: flushTimerRef,
      chime: chimeRef,
      state: stateRef,
    },
    dispatch,
  });
  runBlocksRef.current = runBlocks;

  const { runEternalLoopRef, runParallelLoopRef } = useAutonomyDrivers({
    getEternalEngine,
    getParallelEngine,
    getAutonomy,
    switchAutonomy,
    subscribeEternalIteration,
    subscribeEternalStage,
    refreshGoalSummary,
    autonomyLive,
    setAutonomyLive,
    dispatch,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
  });

  const submit = createSubmitController({
    capabilities: {
      agent,
      slashRegistry,
      tokenCounter,
      getSettings,
      saveSettings,
      getYolo,
      getAutonomy,
      getEternalEngine,
      getParallelEngine,
      getModeLabel,
      getToolsItems,
      onExit,
      clearTerminal,
      onClearHistory,
      getSuggestions,
      getSDDContext,
      switchAutonomy,
      memoryStore,
      getEnhancerReasoning,
      buildEnhancerProvider,
      getEnhanceFallbackRef,
      getConfiguredRefinerRef,
      getPickableProviders,
    },
    state,
    live: {
      mouseMode,
      model: liveModel,
      provider: liveProvider,
      maxContext: activeMaxContext,
      yolo: yoloLive,
      autonomy: autonomyLive,
      modeLabel: liveModeLabel,
      setMouseMode,
      setModel: setLiveModel,
      setProvider: setLiveProvider,
      setMaxContext: setActiveMaxContext,
      setYolo: setYoloLive,
      setAutonomy: setAutonomyLive,
      setModeLabel: setLiveModeLabel,
      setToolCount: setLiveToolCount,
    },
    refs: {
      state: stateRef,
      interrupts: interruptsSyncRef,
      autoSubmitStreak: autoSubmitStreakRef,
      autoSubmitCapWarned: autoSubmitCapWarnedRef,
      autoSubmitLoopGuard: autoSubmitLoopGuardRef,
      tokenPreviews: tokenPreviewsRef,
      attachments,
      builder: builderRef,
      sessionGeneration: sessionGenerationRef,
      eternalLoop: runEternalLoopRef,
      parallelLoop: runParallelLoopRef,
      enhanceEnabled: enhanceEnabledRef,
      enhanceOriginal: enhanceOriginalRef,
      enhanceAbort: enhanceAbortRef,
      enhanceCancelled: enhanceCancelledRef,
      nextStepsTimer: nextStepsAutoSubmitTimerRef,
      midRunSendPicker: midRunSendPickerRef,
      historyScroll: historyScrollRef,
    },
    actions: {
      dispatch,
      clearDraft,
      setDraft,
      pasteClipboardImage,
      openPromptPicker,
      refreshGoalSummary,
      exit,
      runBlocks,
      liveDirector,
      setMemoryContextMonitor,
      runSteerSequence,
      setEnhanceStartedAt,
      setEnhanceDuration: setEnhanceDurationMs,
      setRefineProvider: setRefineProviderId,
      setRefineModel,
    },
  });
  submitRef.current = submit;

  useInitialPrompt({ initialGoal, initialAsk, builderRef, runBlocksRef, dispatch });

  const stableOnKey = useStableKeyHandler(handleKey);

  const viewState = deriveAppViewState({
    state,
    terminalColumns: stdout?.columns ?? 80,
    displayThinkingWord,
    fleetRunning: fleetCounts?.running ?? 0,
    liveAnimationStyle,
  });
  return (
    <AppView
      host={props}
      runtime={{
        state,
        dispatch,
        historyScrollRef,
        onScrollInfo,
        activity,
        environment,
        statusbar,
        mailbox,
        gitInfo,
        viewState,
        mouseMode,
        termRows,
        bottomRegionRef,
        statusBarWrapRef,
        belowStatusBarRef,
        stableOnKey,
        liveTodos,
        liveSettings,
        liveAnimationStyle,
        liveStatuslineMode,
        projectName,
        workingDirChip,
        handleRewindTo,
        activeCtrlRef,
        clearPendingConfirms,
        liveDirector,
        dismissedEscAtRef,
        enhanceOriginalRef,
        enhanceStartedAt,
        enhanceDurationMs,
        refineProviderId,
        refineModel,
        setEnhanceCountdown,
        enhanceCountdown,
        nextStepsAutoSubmitCountdown,
        nextStepsAutoSubmitLabel,
        setDraft,
        focusedBoardId,
        getCronJobs,
        getLeaderTranscript,
        coordinatorRunning,
        enhanceDelayMs,
        layoutStore,
      }}
    />
  );
}
