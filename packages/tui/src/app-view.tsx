import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppMainColumn } from './app-main-column.js';
import { AppStatusRegion } from './app-status-region.js';
import {
  buildSidebarOpenFlags,
  isPickerOverlayOpen,
  resolveAppSidebarLayout,
} from './app-ui-state.js';
import type { AppViewProps } from './app-view-contract.js';
import { AppViewPickers } from './app-view-pickers.js';
import { AppViewSidebar } from './app-view-sidebar.js';
import { useBackgroundStrip } from './background-strip-model.js';
import { BackgroundStrip, backgroundStripRows } from './components/background-strip.js';
import { ChatSearchBar } from './components/chat-search-bar.js';
import { LIVE_TOOL_STREAM_COPY_ID } from './components/history/copy-geometry.js';
import { DEFAULT_INPUT_PROMPT, Input } from './components/input.js';
import { InspectOverlay, resolveInspectOverlayContent } from './components/inspect-overlay.js';
import { LiveScrollableHistory, LiveStreamActivityLine } from './components/live-stream-views.js';
import {
  MonitorViewportProvider,
  PanelInputProvider,
  PanelShortcutsProvider,
} from './components/monitor-shell.js';
import { usePlanPanelData } from './components/plan-panel.js';
import { useProviderQuotaCard } from './hooks/use-provider-quota.js';
import {
  useSidebarConnections,
  useSidebarKanban,
  useSidebarProcessList,
  useSidebarWrongProxy,
} from './hooks/use-sidebar-panel-data.js';
import { useTerminalSize } from './hooks/use-terminal-size.js';
import { Box } from './ink.js';
import { useLiveStream } from './live-stream-store.js';
import { setMotionStatic } from './motion.js';
import { estimateSidebarMaxScroll } from './reducers/workspace-panels.js';
import { theme } from './theme.js';
import type { ToolResultViewMode } from './tool-result-view-mode.js';
import { PANEL_IDS, type PanelId, SIDEBAR_PANEL_LIMIT } from './ui-contracts.js';
import { glyphs } from './ui-glyphs.js';

const INPUT_PROMPT = DEFAULT_INPUT_PROMPT;
/** Bash-mode composer: shell-prompt glyph, dedicated rail label, run/exit hint. */
const BASH_PROMPT = '$ ';
const BASH_TITLE = 'BASH MODE';
const BASH_HINT = 'shell command — Enter run · Esc exit';

export function AppView({ host, runtime }: AppViewProps): React.ReactElement {
  const { agent, appVersion, setSuggestions } = host;
  const {
    state,
    activity,
    environment,
    viewState,
    historyScrollRef,
    onScrollInfo,
    bottomRegionRef,
    stableOnKey,
    liveTodos,
    liveSettings,
    layoutStore,
    mailbox,
  } = runtime;
  const [bannerAnimation, setBannerAnimation] = useState(() => ({
    generation: state.historyGen,
    startedAt: Date.now(),
  }));
  // A fresh history (/clear) starts the intro before the new viewport commits.
  // Ordinary viewport remounts and scrolling retain the same timestamp.
  if (bannerAnimation.generation !== state.historyGen) {
    setBannerAnimation({ generation: state.historyGen, startedAt: Date.now() });
  }
  const replayBanner = useCallback(() => {
    setBannerAnimation({ generation: state.historyGen, startedAt: Date.now() });
  }, [state.historyGen]);
  const { workingTimeMs } = activity;
  const { autonomyLive } = environment;
  const { inputHint, composerStatus, composerAnimationStyle, inputHeight, hideInput } = viewState;
  // Leaves without a style prop (tool stream spinner, composer activity icon)
  // follow the effective style through the motion store.
  useEffect(() => {
    setMotionStatic(composerAnimationStyle === 'static');
  }, [composerAnimationStyle]);
  const showModelReasoning = state.settingsPicker.open
    ? state.settingsPicker.showModelReasoning
    : (liveSettings?.showModelReasoning ?? true);
  const chatSearch = state.chatSearch;
  const chatSearchJumpSeq = chatSearch?.jumpSeq ?? 0;
  const chatSearchEntryId = chatSearch?.selectedEntryId ?? null;
  // Each jumpSeq bump is one explicit "show me this match" request; the
  // selection alone must not re-scroll while the user pages around.
  useEffect(() => {
    if (chatSearchEntryId !== null) historyScrollRef.current?.scrollToEntry(chatSearchEntryId);
  }, [chatSearchJumpSeq]);
  const messageJumpEntryId = state.messageJump.entryId;
  useEffect(() => {
    if (messageJumpEntryId !== null) historyScrollRef.current?.scrollToEntry(messageJumpEntryId);
  }, [state.messageJump.seq]);
  const blockingPrompt =
    state.confirmQueue.length > 0 ||
    state.shellCommandWarning != null ||
    state.brainPrompt != null ||
    state.clearConfirm != null ||
    state.exitConfirm != null ||
    state.slashConfirm != null ||
    state.escConfirm != null ||
    state.enhance != null ||
    state.enhanceBusy ||
    state.topicCheckBusy ||
    state.refineFailure != null ||
    state.continueConfirm != null ||
    state.bugHuntContinue != null ||
    state.sendModePicker != null ||
    state.rewindOverlay != null ||
    state.fallbackOverlay != null ||
    state.inspectOverlay != null ||
    state.helpOpen ||
    (state.status === 'aborting' && !state.steeringPending);
  const foregroundPrompt = blockingPrompt || isPickerOverlayOpen(state);
  // Bash mode relabels the whole composer (`$` prompt, warn-colored rail,
  // BASH MODE title) so the shell-command state is unmistakable at a glance.
  const bashMode = state.bashMode;
  const [localSelectionMode, setLocalSelectionMode] = useState<'block' | 'text' | null>(null);
  const selectionMode = state.settingsPicker.open
    ? state.settingsPicker.selectionMode
    : (localSelectionMode ?? liveSettings?.selectionMode ?? 'block');
  const [selectionModeError, setSelectionModeError] = useState('');
  const selectionModeRef = useRef(selectionMode);
  selectionModeRef.current = selectionMode;
  useEffect(() => {
    if (state.settingsPicker.open || localSelectionMode === liveSettings?.selectionMode)
      setLocalSelectionMode(null);
  }, [liveSettings?.selectionMode, state.settingsPicker.open, localSelectionMode]);
  const selectionSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const selectionSaveVersion = useRef(0);
  const toggleSelectionMode = () => {
    const next = selectionModeRef.current === 'block' ? 'text' : 'block';
    selectionModeRef.current = next;
    const version = ++selectionSaveVersion.current;
    historyScrollRef.current?.clearSelection();
    setLocalSelectionMode(next);
    setSelectionModeError('');
    selectionSaveQueue.current = selectionSaveQueue.current.then(async () => {
      try {
        const current = host.getSettings?.();
        const error = current
          ? await host.saveSettings?.({ ...current, selectionMode: next })
          : 'Selection mode could not be saved';
        if (error) throw new Error(error);
      } catch {
        if (version === selectionSaveVersion.current) {
          setLocalSelectionMode(null);
          setSelectionModeError('Could not save selection mode');
        }
      }
    });
  };
  const toolResultViewMode = state.settingsPicker.open
    ? state.settingsPicker.toolResultViewMode
    : (liveSettings?.toolResultViewMode ?? 'normal');

  // ── Sidebar layout ──────────────────────────────────────────────────
  const { columns: termCols } = useTerminalSize({ fallbackColumns: 80 });
  const {
    panelPositions,
    sidebarWidth,
    sidebarContentWidth,
    mainColumnWidth,
    sidebarTwinRowCount,
    effectiveSwarmOnSidebar,
  } = resolveAppSidebarLayout(state, termCols, liveSettings, mailbox.mailboxPanelOpen);
  const routedToSidebar = (id: PanelId): boolean => panelPositions[id] === 'sidebar';

  const effectiveInputHeight = state.helpPanel.open || viewState.panelOwnsInput ? 0 : inputHeight;
  const backgroundStrip = useBackgroundStrip();
  // Selected so the App re-renders when the activity row appears or goes,
  // not on every stream flush that updates its counters.
  const streamActivityVisible = useLiveStream((live) => live.streamActivity !== null);
  const pickerMaxRows = Math.max(
    8,
    runtime.termRows -
      runtime.statusBarRows -
      effectiveInputHeight -
      (!hideInput && streamActivityVisible ? 1 : 0) -
      backgroundStripRows(backgroundStrip) -
      1,
  );

  const sidebarPanelOpenFlags = buildSidebarOpenFlags(state, liveSettings);
  const openSidebarPanelIds = PANEL_IDS.filter(
    (id) => routedToSidebar(id) && (sidebarPanelOpenFlags[id] ?? false),
  );
  const visibleSidebarPanelIds = openSidebarPanelIds.slice(0, SIDEBAR_PANEL_LIMIT);
  const hiddenSidebarPanelCount = openSidebarPanelIds.length - visibleSidebarPanelIds.length;
  const sidebarSlotVisible = (id: PanelId): boolean =>
    sidebarWidth > 0 && visibleSidebarPanelIds.includes(id);
  // The scrollbar's maxScroll — the SAME estimate the sidebarScroll /
  // sidebarScrollSet reducer clamps use, with the same inputs the
  // dispatchers thread (termRows − 2 viewport, twin-row reservation,
  // dual-source swarm flag) so thumb, wheel, and clamp can never drift.
  const sidebarMaxScroll = estimateSidebarMaxScroll(
    state,
    Math.max(1, runtime.termRows - 2 - sidebarTwinRowCount),
    effectiveSwarmOnSidebar,
  );

  const sidebarProcessData = useSidebarProcessList(sidebarSlotVisible('processList'));
  const sidebarConnectionsData = useSidebarConnections(agent.ctx.projectRoot, sidebarWidth > 0);
  // Plan quota of the provider/model in use — push-driven, dormant with no rail.
  const sidebarQuotaCard = useProviderQuotaCard(
    sidebarWidth > 0,
    environment.liveProvider,
    environment.liveModel,
  );
  const sidebarKanbanData = useSidebarKanban(agent.ctx.projectRoot, sidebarSlotVisible('kanban'));

  // WrongProxy status panel — gated on the master switch via the
  // picker's draft while the settings picker is open (so the panel
  // tracks ←/→ edits synchronously, matching the pattern in
  // `effectivePanelPositionsInput`/`effectiveAgentSwarmPanelMode` in
  // `app-ui-state.ts`) and the persisted `liveSettings` once the
  // picker is closed. Without the dual-source read, the user can
  // toggle WrongProxy on via the picker and watch the card NOT
  // appear until an unrelated render after async persistence lands.
  const wrongProxyEnabled = state.settingsPicker.open
    ? state.settingsPicker.wrongProxyEnabled === true
    : liveSettings?.wrongProxyEnabled === true;
  const wrongProxyUrl = state.settingsPicker.open
    ? state.settingsPicker.wrongProxyUrl
    : liveSettings?.wrongProxyUrl;
  const sidebarWrongProxyData = useSidebarWrongProxy(
    wrongProxyUrl,
    wrongProxyEnabled && sidebarWidth > 0,
  );
  const sidebarPlanData = usePlanPanelData(
    agent.ctx.projectRoot,
    agent.ctx.session?.id ?? null,
    sidebarSlotVisible('plan'),
  );

  // Only the live-tool inspect view follows the tool tail; any other overlay
  // (or none) must not re-render the App as tool output streams.
  const inspectingLiveTool = state.inspectOverlay?.entryId === LIVE_TOOL_STREAM_COPY_ID;
  const inspectToolStream = useLiveStream((live) => (inspectingLiveTool ? live.toolStream : null));
  const inspectContent = state.inspectOverlay
    ? resolveInspectOverlayContent(state.inspectOverlay, state.entries, inspectToolStream)
    : null;

  const onToolResultViewChange = useCallback(
    (entryIds: readonly number[], mode: ToolResultViewMode) => {
      runtime.dispatch({ type: 'toolResultViewSet', entryIds, mode });
    },
    [runtime.dispatch],
  );

  const onInspectScroll = useCallback(
    (delta: number) => {
      runtime.dispatch({ type: 'inspectOverlayScroll', delta });
    },
    [runtime.dispatch],
  );

  const onInspectClose = useCallback(() => {
    runtime.dispatch({ type: 'inspectOverlayClose' });
  }, [runtime.dispatch]);

  return (
    <PanelInputProvider value={!foregroundPrompt}>
      <PanelShortcutsProvider value={viewState.panelOwnsInput || state.buffer.length === 0}>
        <Box
          flexDirection="column"
          height={runtime.termRows}
          overflowY="hidden"
          justifyContent="flex-end"
        >
          <Box flexDirection="row" width={termCols} flexShrink={0} overflowX="hidden">
            <AppMainColumn width={mainColumnWidth} rows={runtime.termRows}>
              {inspectContent && state.inspectOverlay ? (
                <InspectOverlay
                  title={inspectContent.title}
                  body={inspectContent.body}
                  scroll={state.inspectOverlay.scroll}
                  termCols={mainColumnWidth}
                  viewportRows={state.viewportRows}
                  onScroll={onInspectScroll}
                  onClose={onInspectClose}
                  copied={state.copiedEntryId === state.inspectOverlay.entryId}
                  headerRef={runtime.inspectOverlayHeaderRef}
                />
              ) : (
                <LiveScrollableHistory
                  key={`history-gen-${state.historyGen}`}
                  entries={state.entries}
                  viewportRows={state.viewportRows}
                  bannerAnimationStartedAt={
                    composerAnimationStyle === 'static' ? undefined : bannerAnimation.startedAt
                  }
                  onBannerReplay={replayBanner}
                  maxWidth={mainColumnWidth}
                  controllerRef={historyScrollRef}
                  onScrollInfo={onScrollInfo}
                  setSuggestions={setSuggestions}
                  autonomyMode={autonomyLive}
                  nextStepsAutoSubmitLabel={runtime.nextStepsAutoSubmitLabel}
                  nextStepsAutoSubmitDeadlineMs={runtime.nextStepsAutoSubmitDeadlineMs}
                  multiDiffSummaryThreshold={state.settingsPicker.multiDiffSummaryThreshold}
                  todos={liveTodos}
                  showModelReasoning={showModelReasoning}
                  markedEntryId={chatSearchEntryId ?? messageJumpEntryId}
                  showSageMemoryInject={
                    state.settingsPicker.open
                      ? state.settingsPicker.showSageMemoryInject
                      : (liveSettings?.showSageMemoryInject ?? false)
                  }
                  toolResultViewMode={toolResultViewMode}
                  toolResultViewOverrides={state.toolResultViewOverrides}
                  selectionMode={selectionMode}
                  onToolResultViewChange={onToolResultViewChange}
                  layoutStore={layoutStore}
                  copiedEntryId={state.copiedEntryId}
                  onRequestOlderEntries={runtime.onRequestOlderEntries}
                />
              )}
              <Box
                flexDirection="column"
                flexShrink={0}
                ref={bottomRegionRef}
                width={mainColumnWidth}
              >
                {chatSearch && !hideInput ? (
                  <ChatSearchBar
                    search={chatSearch}
                    entries={state.entries}
                    includeReasoning={showModelReasoning}
                    width={mainColumnWidth}
                  />
                ) : null}
                {!hideInput ? (
                  <BackgroundStrip fleet={state.fleet} width={mainColumnWidth} />
                ) : null}
                {!hideInput ? (
                  <LiveStreamActivityLine
                    width={mainColumnWidth}
                    running={state.status !== 'idle'}
                  />
                ) : null}
                <Input
                  selectionMode={selectionMode}
                  onSelectionModeToggle={
                    host.getSettings && host.saveSettings ? toggleSelectionMode : undefined
                  }
                  onSelectionBegin={() => historyScrollRef.current?.clearSelection()}
                  prompt={bashMode ? BASH_PROMPT : INPUT_PROMPT}
                  value={state.buffer}
                  cursor={state.cursor}
                  title={bashMode ? BASH_TITLE : `WRONGSTACK${appVersion ? ` v${appVersion}` : ''}`}
                  railIcon={bashMode ? glyphs.terminal : undefined}
                  accent={bashMode ? theme.warn : undefined}
                  status={composerStatus}
                  animationStyle={composerAnimationStyle}
                  hidden={hideInput}
                  placeholderHeight={effectiveInputHeight}
                  maxWidth={mainColumnWidth}
                  disabled={
                    (state.status === 'aborting' && !state.steeringPending) ||
                    state.confirmQueue.length > 0
                  }
                  hint={selectionModeError || (bashMode ? BASH_HINT : inputHint)}
                  onKey={stableOnKey}
                  workingTime={workingTimeMs}
                />
                <MonitorViewportProvider value={{ columns: mainColumnWidth, rows: pickerMaxRows }}>
                  <AppViewPickers
                    host={host}
                    runtime={runtime}
                    mainColumnWidth={mainColumnWidth}
                    pickerMaxRows={pickerMaxRows}
                    pickerInputEnabled={!blockingPrompt}
                    routedToSidebar={routedToSidebar}
                    panelPositions={panelPositions}
                  />
                  <AppStatusRegion
                    panelsSuppressed={foregroundPrompt}
                    host={host}
                    runtime={runtime}
                    mainColumnWidth={mainColumnWidth}
                  />
                </MonitorViewportProvider>
              </Box>
            </AppMainColumn>
            <AppViewSidebar
              host={host}
              runtime={runtime}
              sidebarWidth={sidebarWidth}
              sidebarContentWidth={sidebarContentWidth}
              sidebarScrollOffset={state.sidebarScrollOffset}
              sidebarMaxScroll={sidebarMaxScroll}
              sidebarSlotVisible={sidebarSlotVisible}
              hiddenSidebarPanelCount={hiddenSidebarPanelCount}
              sidebarProcessData={sidebarProcessData}
              sidebarConnectionsData={sidebarConnectionsData}
              sidebarKanbanData={sidebarKanbanData}
              sidebarPlanData={sidebarPlanData}
              sidebarWrongProxyEnabled={wrongProxyEnabled}
              sidebarWrongProxyData={sidebarWrongProxyData}
              sidebarQuotaCard={sidebarQuotaCard}
            />
          </Box>
        </Box>
      </PanelShortcutsProvider>
    </PanelInputProvider>
  );
}
