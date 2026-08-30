import type React from 'react';
import { AppStatusRegion } from './app-status-region.js';
import { buildSidebarOpenFlags, resolveAppSidebarLayout } from './app-ui-state.js';
import type { AppViewProps } from './app-view-contract.js';
import { AppViewPickers } from './app-view-pickers.js';
import { AppViewSidebar } from './app-view-sidebar.js';
import { DEFAULT_INPUT_PROMPT, Input } from './components/input.js';
import { PanelShortcutsProvider } from './components/monitor-shell.js';
import { usePlanPanelData } from './components/plan-panel.js';
import { ScrollableHistory } from './components/scrollable-history.js';
import {
  useSidebarConnections,
  useSidebarKanban,
  useSidebarProcessList,
  useSidebarWrongProxy,
} from './hooks/use-sidebar-panel-data.js';
import { useTerminalSize } from './hooks/use-terminal-size.js';
import { Box } from './ink.js';
import { PANEL_IDS, type PanelId, SIDEBAR_PANEL_LIMIT } from './ui-contracts.js';

const INPUT_PROMPT = DEFAULT_INPUT_PROMPT;

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
  const { workingTimeMs } = activity;
  const { autonomyLive } = environment;
  const { inputHint, composerStatus, composerAnimationStyle, inputHeight, hideInput } = viewState;

  // ── Sidebar layout ──────────────────────────────────────────────────
  const { columns: termCols } = useTerminalSize({ fallbackColumns: 80 });
  const { panelPositions, sidebarWidth, sidebarContentWidth, mainColumnWidth } =
    resolveAppSidebarLayout(state, termCols, liveSettings, mailbox.mailboxPanelOpen);
  const routedToSidebar = (id: PanelId): boolean => panelPositions[id] === 'sidebar';

  const pickerMaxRows = Math.max(8, runtime.termRows - runtime.statusBarRows - inputHeight - 1);

  const sidebarPanelOpenFlags = buildSidebarOpenFlags(state, liveSettings);
  const openSidebarPanelIds = PANEL_IDS.filter(
    (id) => routedToSidebar(id) && (sidebarPanelOpenFlags[id] ?? false),
  );
  const visibleSidebarPanelIds = openSidebarPanelIds.slice(0, SIDEBAR_PANEL_LIMIT);
  const hiddenSidebarPanelCount = openSidebarPanelIds.length - visibleSidebarPanelIds.length;
  const sidebarSlotVisible = (id: PanelId): boolean =>
    sidebarWidth > 0 && visibleSidebarPanelIds.includes(id);

  const sidebarProcessData = useSidebarProcessList(sidebarSlotVisible('processList'));
  const sidebarConnectionsData = useSidebarConnections(
    agent.ctx.projectRoot,
    sidebarSlotVisible('connections'),
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

  return (
    <PanelShortcutsProvider value={state.buffer.length === 0}>
      <Box
        flexDirection="column"
        height={runtime.termRows}
        overflowY="hidden"
        justifyContent="flex-end"
      >
        <Box flexDirection="row" width={termCols} flexShrink={0} overflowX="hidden">
          <Box flexDirection="column" flexShrink={0} width={mainColumnWidth} overflowX="hidden">
            <ScrollableHistory
              key={`history-gen-${state.historyGen}`}
              entries={state.entries}
              toolStream={state.toolStream}
              streamingText={state.streamingText}
              viewportRows={state.viewportRows}
              maxWidth={mainColumnWidth}
              controllerRef={historyScrollRef}
              onScrollInfo={onScrollInfo}
              setSuggestions={setSuggestions}
              autonomyMode={autonomyLive}
              multiDiffSummaryThreshold={state.settingsPicker.multiDiffSummaryThreshold}
              todos={liveTodos}
              showModelReasoning={
                state.settingsPicker.open
                  ? state.settingsPicker.showModelReasoning
                  : (liveSettings?.showModelReasoning ?? true)
              }
              showSageMemoryInject={
                state.settingsPicker.open
                  ? state.settingsPicker.showSageMemoryInject
                  : (liveSettings?.showSageMemoryInject ?? false)
              }
              layoutStore={layoutStore}
              copiedEntryId={state.copiedEntryId}
              onRequestOlderEntries={runtime.onRequestOlderEntries}
            />
            <Box
              flexDirection="column"
              flexShrink={0}
              ref={bottomRegionRef}
              width={mainColumnWidth}
            >
              <Input
                prompt={INPUT_PROMPT}
                value={state.buffer}
                cursor={state.cursor}
                title={`WRONGSTACK${appVersion ? ` v${appVersion}` : ''}`}
                status={composerStatus}
                animationStyle={composerAnimationStyle}
                hidden={hideInput}
                placeholderHeight={inputHeight}
                maxWidth={mainColumnWidth}
                disabled={
                  (state.status === 'aborting' && !state.steeringPending) ||
                  state.confirmQueue.length > 0
                }
                hint={inputHint}
                onKey={stableOnKey}
                workingTime={workingTimeMs}
              />
              <AppViewPickers
                host={host}
                runtime={runtime}
                mainColumnWidth={mainColumnWidth}
                pickerMaxRows={pickerMaxRows}
                routedToSidebar={routedToSidebar}
                panelPositions={panelPositions}
              />
              <AppStatusRegion host={host} runtime={runtime} mainColumnWidth={mainColumnWidth} />
            </Box>
          </Box>
          <AppViewSidebar
            host={host}
            runtime={runtime}
            sidebarWidth={sidebarWidth}
            sidebarContentWidth={sidebarContentWidth}
            sidebarSlotVisible={sidebarSlotVisible}
            hiddenSidebarPanelCount={hiddenSidebarPanelCount}
            sidebarProcessData={sidebarProcessData}
            sidebarConnectionsData={sidebarConnectionsData}
            sidebarKanbanData={sidebarKanbanData}
            sidebarPlanData={sidebarPlanData}
            sidebarWrongProxyEnabled={wrongProxyEnabled}
            sidebarWrongProxyData={sidebarWrongProxyData}
          />
        </Box>
      </Box>
    </PanelShortcutsProvider>
  );
}
