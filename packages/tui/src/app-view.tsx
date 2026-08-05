import { expectDefined } from '@wrongstack/core/utils';
import type React from 'react';
import { AppStatusRegion } from './app-status-region.js';
import type { AppViewProps } from './app-view-contract.js';
import { AuditPanel } from './components/audit-panel.js';
import { AuthPanel } from './components/auth-panel.js';
import { AutonomyPicker } from './components/autonomy-picker.js';
import { BrainDecisionPrompt } from './components/brain-decision-prompt.js';
import { BrainPanel } from './components/brain-panel.js';
import { CheckpointTimeline } from './components/checkpoint-timeline.js';
import { ClearConfirmPanel } from './components/clear-confirm-panel.js';
import { type ConfirmDecision, ConfirmPrompt } from './components/confirm-prompt.js';
import { ConnectionsPanel } from './components/connections-panel.js';
import { ContinueConfirmPanel } from './components/continue-confirm-panel.js';
import { CoordinatorPanel } from './components/coordinator-panel.js';
import { DesignPicker } from './components/design-picker.js';
import { EnhancePanel, RefiningPanel } from './components/enhance-panel.js';
import { EscConfirmPrompt } from './components/esc-confirm-prompt.js';
import { ExitConfirmPanel } from './components/exit-confirm-panel.js';
import { FallbackOverlay } from './components/fallback-overlay.js';
import { FKeyPicker } from './components/f-key-picker.js';
import { FilePicker } from './components/file-picker.js';
import { HelpPanel } from './components/help-panel.js';
import { DEFAULT_INPUT_PROMPT, Input } from './components/input.js';
import { McpPicker } from './components/mcp-picker.js';
import { ModePicker } from './components/mode-picker.js';
import { ModelPicker } from './components/model-picker.js';
import { PluginPicker } from './components/plugin-picker.js';
import { usePlanPanelData } from './components/plan-panel.js';
import { ProjectPicker } from './components/project-picker.js';
import { filterPromptPicker, PromptPicker } from './components/prompt-picker.js';
import { RefineCountdownPanel } from './components/refine-countdown-panel.js';
import { RefineFailurePanel } from './components/refine-failure-panel.js';
import { ResumePicker } from './components/resume-picker.js';
import { ScrollableHistory } from './components/scrollable-history.js';
import { resolveSidebarLayout } from './app-ui-state.js';
import { RightSidebar } from './components/sidebar.js';
import { SidebarContent } from './components/sidebar-content.js';
import {
  AgentsPanelSidebar,
  ConnectionsPanelSidebar,
  CoordinatorPanelSidebar,
  FleetPanelSidebar,
  GoalPanelSidebar,
  KanbanPanelSidebar,
  PlanPanelSidebar,
  ProcessListPanelSidebar,
  ProjectPickerSidebar,
  QueuePanelSidebar,
  SessionsPanelSidebar,
  TodosPanelSidebar,
  WorktreePanelSidebar,
} from './components/sidebar-panels.js';
import {
  useSidebarConnections,
  useSidebarKanban,
  useSidebarProcessList,
} from './hooks/use-sidebar-panel-data.js';
import { SendModePicker } from './components/send-mode-picker.js';
import { SettingsPicker } from './components/settings-picker.js';
import { ShadowPanel } from './components/shadow-panel.js';
import {
  ShellCommandWarning,
  type ShellCommandWarningDecision,
} from './components/shell-command-warning.js';
import { SlashConfirmPanel } from './components/slash-confirm-panel.js';
import { SlashMenu } from './components/slash-menu.js';
import { StatuslinePicker } from './components/statusline-picker.js';
import { ToolsPicker } from './components/tools-picker.js';
import { Box, Text, useStdout } from './ink.js';
import { PANEL_IDS, SIDEBAR_PANEL_LIMIT, type PanelId, type SendMode } from './ui-contracts.js';
import { theme } from './theme.js';

const CONTINUE_CONFIRM_DELAY_MS = 4000;
const INPUT_PROMPT = DEFAULT_INPUT_PROMPT;

export function AppView({ host, runtime }: AppViewProps): React.ReactElement {
  const {
    agent,
    appVersion,
    events,
    getSettings,
    onYolo,
    profileConfigPath,
    saveSettings,
    setSuggestions,
  } = host;
  const {
    state,
    dispatch,
    activity,
    environment,
    statusbar,
    viewState,
    historyScrollRef,
    onScrollInfo,
    bottomRegionRef,
    stableOnKey,
    liveTodos,
    liveSettings,
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
    enhanceDelayMs,
    layoutStore,
    mailbox,
  } = runtime;
  const { nowTick, workingTimeMs, enhanceDots } = activity;
  const { setYoloLive, autonomyLive, liveModel, liveProvider } = environment;
  const { inputHint, composerStatus, composerAnimationStyle, inputHeight, hideInput } = viewState;

  // ── Sidebar layout ──────────────────────────────────────────────────
  // The chat history area shares its row with a right-hand sidebar. The
  // sidebar gets a fixed fraction of the terminal width (clamped), and the
  // main column narrows to the remainder so entry text wraps before the
  // sidebar boundary.
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  // Per-panel position routing: a panel renders in the right sidebar when
  // its F-key is open AND its position is 'sidebar'. Mirrors
  // app-status-region.tsx's bottom-region suppression so the two surfaces
  // never double-render.
  const { panelPositions, sidebarWidth, sidebarContentWidth, mainColumnWidth } = resolveSidebarLayout(
    state,
    termCols,
    // While the settings picker is open, use the reducer state for immediate
    // visual feedback (the reducer updates on every ←/→ press). When the
    // picker is closed, use the persisted configStore snapshot via
    // liveSettings — the reducer's panelPositions is initialized to
    // DEFAULT_PANEL_POSITIONS on boot and is never hydrated from disk, so
    // only liveSettings carries the user's saved routing outside the
    // picker session. The auto-save hook writes to configStore on every
    // picker change, so by the time the picker closes, liveSettings
    // already reflects the user's choices.
    state.settingsPicker.open
      ? state.settingsPicker.panelPositions
      : liveSettings?.panelPositions,
    mailbox.mailboxPanelOpen,
  );
  const routedToSidebar = (id: PanelId): boolean => panelPositions[id] === 'sidebar';

  // Sidebar slot allocation (SIDEBAR_PANEL_LIMIT, ui-contracts.ts): when
  // more panels than the limit are open AND routed to 'sidebar', render the
  // first N in PANEL_IDS order and surface a "+N more" hint rather than
  // overflowing the viewport. Panel toggles are mutually exclusive today
  // (reducers call closePanels before opening), so at most one slot is
  // occupied — the cap keeps the documented contract honest if that ever
  // changes. The agents slot additionally honors the legacy
  // `showAgentSwarmPanel: 'off'` tri-state — users who explicitly hide the
  // swarm panel should not see it in the sidebar, and a hidden panel must
  // not occupy a slot. Computed before the sidebar data hooks below so each
  // hook can gate its polling on actual slot visibility.
  const sidebarPanelOpenFlags: Partial<Record<PanelId, boolean>> = {
    projectPicker: state.projectPicker.open,
    fleet: state.monitorOpen,
    agents:
      state.agentsMonitorOpen && (liveSettings?.showAgentSwarmPanel ?? 'bottom') !== 'off',
    worktree: state.worktreeMonitorOpen,
    plan: state.planPanelOpen,
    todos: state.todosMonitorOpen,
    queue: state.queuePanelOpen,
    processList: state.processListOpen,
    goal: state.goalPanelOpen,
    sessions: state.sessionsPanelOpen,
    // Ctrl+P (goalRunMonitorToggle) opens the phase monitor WITHOUT setting
    // coordinator.monitorOpen — closePanels resets the latter. The sidebar
    // surface must stay reachable from both entry points.
    coordinator: state.coordinator.monitorOpen || (state.goalRun?.monitorOpen ?? false),
    kanban: state.kanbanPanelOpen,
    connections: state.connectionsPanelOpen,
  };
  const openSidebarPanelIds = PANEL_IDS.filter(
    (id) => routedToSidebar(id) && (sidebarPanelOpenFlags[id] ?? false),
  );
  const visibleSidebarPanelIds = openSidebarPanelIds.slice(0, SIDEBAR_PANEL_LIMIT);
  const hiddenSidebarPanelCount = openSidebarPanelIds.length - visibleSidebarPanelIds.length;
  const sidebarSlotVisible = (id: PanelId): boolean => visibleSidebarPanelIds.includes(id);

  // Sidebar panel data hooks — each hook manages its own polling interval
  // and cleanup, gated on the twin actually occupying a visible sidebar
  // slot. While a panel is closed or routed to the bottom region the
  // sidebar copy stays idle (the bottom panels run their own polling when
  // open), so no IPC probes, registry reads, or disk reads run for a panel
  // nobody is looking at. Each hook performs an immediate first read when
  // enabled, so the twin has data the moment it mounts.
  const sidebarProcessData = useSidebarProcessList(sidebarSlotVisible('processList'));
  const sidebarConnectionsData = useSidebarConnections(
    agent.ctx.projectRoot,
    sidebarSlotVisible('connections'),
  );
  const sidebarKanbanData = useSidebarKanban(agent.ctx.projectRoot, sidebarSlotVisible('kanban'));
  const sidebarPlanData = usePlanPanelData(
    agent.ctx.projectRoot,
    agent.ctx.session?.id ?? null,
    sidebarSlotVisible('plan'),
  );

  return (
    /* Hard viewport cap. The managed layout aims for exactly termRows
       (history vp + measured bottom region), but the bottom region grows a
       commit BEFORE the history viewport shrinks to match (vp is measured in
       a layout effect, and Ink writes the frame at resetAfterCommit — before
       layout effects run). Without this cap that one-frame overflow scrolls
       the terminal: top rows are stranded in native scrollback, Ink's erase
       math desyncs, and the garbage accumulates over a session. With the cap,
       yoga clips the overflow instead and no frame can ever scroll the
       terminal. justifyContent flex-end makes the clip happen at the TOP of
       the history box (Ink-7: flex-end clips top), so a freshly-opened picker
       or grown input is fully visible immediately while history briefly loses
       its top rows until the viewport re-measures. */
    <Box
      flexDirection="column"
      height={runtime.termRows}
      overflowY="hidden"
      justifyContent="flex-end"
    >
    <Box flexDirection="row" width={termCols} flexShrink={0} overflowX="hidden">
      <Box flexDirection="column" flexShrink={0} width={mainColumnWidth} overflowX="hidden">
        <ScrollableHistory
          // Remount on every history-generation bump (e.g. /clear). The managed
          // viewport keeps its scroll position, height-cache buffer, and
          // measured-group set in component-local refs/state that the reducer
          // cannot reach. `clearHistory` only reports historyScrolled:false —
          // without a remount the component stays in "scrolled-away" mode
          // (justifyContent:flex-start, scroll-up hint) after a clear and new
          // output no longer auto-follows. Keying by historyGen resets that
          // internal virtual-scroll state to its initial pinned/follow state,
          // mirroring the <Static> remount driven by the same generation.
          key={`history-gen-${state.historyGen}`}
          entries={state.entries}
          toolStream={state.toolStream}
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
        <Box flexDirection="column" flexShrink={0} ref={bottomRegionRef} width={mainColumnWidth}>
          {/* NOTE: the LiveActivityStrip is deliberately NOT rendered here yet.
              It sits
              at the bottom edge of a full terminal, so every fleet tool.progress
              re-render scrolls the screen by a line and strands the strip's top
              row permanently in native scrollback — a busy subagent (100+ rapid
              tool calls) re-stamps the "● <name> … last: …" line dozens of times,
              differing only by the elapsed timer. The strip's constant-height
              guard only defends against height-change leaks, not bottom-edge
              scroll; Ink can't avoid this without owning the screen. Fleet
              activity stays visible via the status bar and the F3 agents monitor.
              The component + its tests are kept until it can be integrated into
              the managed history viewport with stable layout accounting. */}
          {/* While enhance is active or a monitor overlay is open, the Input is
              rendered HIDDEN: its visible rows collapse to a constant-height
              placeholder (so Ink's log-update never bleeds the live region into
              static scrollback, and no characters pollute the history area), but
              its keyboard listeners stay mounted. Keeping them mounted is what
              keeps the central `handleKey` router — and the F-key/Esc toggles
              that close the monitor overlays — alive. Unmounting the Input here
              previously left the F3 agents monitor (and the other panels)
              un-closable: F-key parsing and Esc handling both live in Input. */}
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
          {state.picker.open ? (
            <FilePicker
              query={state.picker.query}
              matches={state.picker.matches}
              selected={state.picker.selected}
            />
          ) : null}
          {state.slashPicker.open ? (
            <SlashMenu
              query={state.slashPicker.query}
              matches={state.slashPicker.matches}
              selected={state.slashPicker.selected}
            />
          ) : null}
          {state.modelPicker.open ? (
            <ModelPicker
              step={state.modelPicker.step}
              providerOptions={state.modelPicker.providerOptions}
              modelOptions={state.modelPicker.modelOptions}
              filteredOptions={state.modelPicker.filteredOptions}
              selected={state.modelPicker.selected}
              pickedProviderId={state.modelPicker.pickedProviderId}
              searchQuery={state.modelPicker.searchQuery}
              hint={state.modelPicker.hint}
              titleLabel={state.modelPicker.title}
            />
          ) : null}
          {state.autonomyPicker.open ? (
            <AutonomyPicker
              options={state.autonomyPicker.options}
              selected={state.autonomyPicker.selected}
              hint={state.autonomyPicker.hint}
            />
          ) : null}
          {state.modePicker.open ? (
            <ModePicker
              modes={state.modePicker.modes}
              selected={state.modePicker.selected}
              hint={state.modePicker.hint}
            />
          ) : null}
          {state.designPicker.open ? (
            <DesignPicker
              kits={state.designPicker.kits}
              selected={state.designPicker.selected}
              stack={state.designPicker.stack}
            />
          ) : null}
          {state.promptPicker.open ? (
            <PromptPicker
              entries={filterPromptPicker(
                state.promptPicker.all,
                state.promptPicker.categories,
                state.promptPicker.catIndex,
                state.promptPicker.recentSlugs,
              )}
              selected={state.promptPicker.selected}
              category={state.promptPicker.categories[state.promptPicker.catIndex] ?? 'all'}
              total={state.promptPicker.all.length}
            />
          ) : null}
          {state.resumePicker.open ? (
            <ResumePicker
              sessions={state.resumePicker.sessions}
              selected={state.resumePicker.selected}
              busy={state.resumePicker.busy}
              error={state.resumePicker.error}
              hint={state.resumePicker.hint}
            />
          ) : null}
          {state.settingsPicker.open ? (
            <SettingsPicker
              field={state.settingsPicker.field}
              mode={state.settingsPicker.mode}
              delayMs={state.settingsPicker.delayMs}
              titleAnimation={state.settingsPicker.titleAnimation}
              yolo={state.settingsPicker.yolo}
              fleetChat={state.settingsPicker.fleetChat}
              chime={state.settingsPicker.chime}
              confirmExit={state.settingsPicker.confirmExit}
              nextPrediction={state.settingsPicker.nextPrediction}
              featureMcp={state.settingsPicker.featureMcp}
              featurePlugins={state.settingsPicker.featurePlugins}
              featureMemory={state.settingsPicker.featureMemory}
              featureSkills={state.settingsPicker.featureSkills}
              featureModelsRegistry={state.settingsPicker.featureModelsRegistry}
              tokenSavingTier={state.settingsPicker.tokenSavingTier}
              allowOutsideProjectRoot={state.settingsPicker.allowOutsideProjectRoot}
              contextAutoCompact={state.settingsPicker.contextAutoCompact}
              contextStrategy={state.settingsPicker.contextStrategy}
              contextMode={state.settingsPicker.contextMode}
              maxConcurrent={state.settingsPicker.maxConcurrent}
              logLevel={state.settingsPicker.logLevel}
              auditLevel={state.settingsPicker.auditLevel}
              indexOnStart={state.settingsPicker.indexOnStart}
              multiDiffSummaryThreshold={state.settingsPicker.multiDiffSummaryThreshold}
              thinkingWord={state.settingsPicker.thinkingWord}
              thinkingWordEditing={state.settingsPicker.thinkingWordEditing}
              thinkingWordDraft={state.settingsPicker.thinkingWordDraft}
              maxIterations={state.settingsPicker.maxIterations}
              autoProceedMaxIterations={state.settingsPicker.autoProceedMaxIterations}
              enhanceDelayMs={state.settingsPicker.enhanceDelayMs}
              preRefineSeconds={state.settingsPicker.preRefineSeconds}
              enhanceEnabled={state.settingsPicker.enhanceEnabled}
              enhanceLanguage={state.settingsPicker.enhanceLanguage}
              debugStream={state.settingsPicker.debugStream}
              statuslineMode={state.settingsPicker.statuslineMode}
              reasoningMode={state.settingsPicker.reasoningMode}
              reasoningEffort={state.settingsPicker.reasoningEffort}
              reasoningPreserve={state.settingsPicker.reasoningPreserve}
              cacheTtl={state.settingsPicker.cacheTtl}
              configScope={state.settingsPicker.configScope}
              profileConfigPath={profileConfigPath}
              animationStyle={state.settingsPicker.animationStyle}
              breakerEnabled={state.settingsPicker.breakerEnabled}
              breakerAutoKillResetMs={state.settingsPicker.breakerAutoKillResetMs}
              showModelReasoning={state.settingsPicker.showModelReasoning}
              showAgentSwarmPanel={state.settingsPicker.showAgentSwarmPanel}
              showSageMemoryInject={state.settingsPicker.showSageMemoryInject}
              sageMemoryInjectThreshold={state.settingsPicker.sageMemoryInjectThreshold}
              readSymbols={state.settingsPicker.readSymbols}
              panelPositions={state.settingsPicker.panelPositions}
              filter={state.settingsPicker.filter}
              hint={state.settingsPicker.hint}
            />
          ) : null}
          {state.statuslinePicker.open ? (
            <StatuslinePicker
              field={state.statuslinePicker.field}
              hiddenItems={state.statuslinePicker.hiddenItems}
              visibleChips={state.statuslinePicker.visibleChips}
              hint={state.statuslinePicker.hint}
            />
          ) : null}
          {state.pluginPicker.open ? (
            <PluginPicker
              items={state.pluginPicker.items}
              selected={state.pluginPicker.selected}
              busy={state.pluginPicker.busy}
              hint={state.pluginPicker.hint}
            />
          ) : null}
          {state.mcpPicker.open ? (
            <McpPicker
              items={state.mcpPicker.items}
              selected={state.mcpPicker.selected}
              busy={state.mcpPicker.busy}
              hint={state.mcpPicker.hint}
            />
          ) : null}
          {state.toolsPicker.open ? (
            <ToolsPicker
              items={state.toolsPicker.items}
              selected={state.toolsPicker.selected}
              busy={state.toolsPicker.busy}
              hint={state.toolsPicker.hint}
              filter={state.toolsPicker.filter}
            />
          ) : null}
          {state.brainPanel.open && !state.modelPicker.open ? (
            <BrainPanel {...state.brainPanel} />
          ) : null}
          {state.helpPanel.open ? (
            <HelpPanel
              entries={state.helpPanel.entries}
              filter={state.helpPanel.filter}
              selected={state.helpPanel.selected}
              hint={state.helpPanel.hint}
            />
          ) : null}
          {state.shadowPanel.open ? (
            <ShadowPanel shadow={state.shadowPanel.shadow} hint={state.shadowPanel.hint} />
          ) : null}
          {state.authPanel.open ? <AuthPanel panel={state.authPanel} /> : null}
          {state.projectPicker.open && !routedToSidebar('projectPicker') ? (
            <ProjectPicker
              items={state.projectPicker.items}
              selected={state.projectPicker.selected}
              filter={state.projectPicker.filter}
              hint={state.projectPicker.hint}
            />
          ) : null}
          {state.fKeyPicker.open ? <FKeyPicker selected={state.fKeyPicker.selected} /> : null}
          {state.coordinator.monitorOpen && !routedToSidebar('coordinator') ? (
            <CoordinatorPanel
              coordinator={state.coordinator}
              nowTick={nowTick}
              onClose={() => dispatch({ type: 'toggleCoordinatorMonitor' })}
            />
          ) : null}
          {state.auditPanelOpen ? (
            <AuditPanel
              sideEffects={agent.ctx.sideEffects ?? []}
              onClose={() => dispatch({ type: 'toggleAuditPanel' })}
            />
          ) : null}
          {state.connectionsPanelOpen && panelPositions.connections === 'bottom' ? (
            <ConnectionsPanel
              projectRoot={agent.ctx.projectRoot}
              onClose={() => dispatch({ type: 'toggleConnectionsPanel' })}
            />
          ) : null}
          {state.rewindOverlay
            ? (() => {
                const overlay = state.rewindOverlay;
                return (
                  <CheckpointTimeline
                    checkpoints={overlay.checkpoints}
                    selected={overlay.selected}
                    onSelect={(i) =>
                      dispatch({ type: 'rewindOverlayMove', delta: i - overlay.selected })
                    }
                    onConfirm={(i) => {
                      const checkpoint = overlay.checkpoints[i];
                      if (checkpoint) handleRewindTo(checkpoint.promptIndex);
                    }}
                    onClose={() => dispatch({ type: 'rewindOverlayClose' })}
                  />
                );
              })()
            : null}
          {state.brainPrompt ? (
            <Box flexDirection="column" marginY={1} flexShrink={0}>
              <BrainDecisionPrompt
                {...state.brainPrompt}
                onAnswer={(answer) => {
                  events.emit('brain.human_answered', { ...answer, at: Date.now() });
                  dispatch({ type: 'brainPromptClear' });
                }}
              />
            </Box>
          ) : null}
          {state.shellCommandWarning
            ? (() => {
                const info = state.shellCommandWarning;
                let resolved = false;
                const onDecision = (decision: ShellCommandWarningDecision) => {
                  if (resolved) return;
                  resolved = true;
                  info.resolve(decision);
                  dispatch({ type: 'shellCommandWarningClose' });
                };
                return <ShellCommandWarning command={info.command} onDecision={onDecision} />;
              })()
            : null}
          {state.confirmQueue.length > 0 &&
            (() => {
              const head = expectDefined(state.confirmQueue[0]);
              let resolved = false;
              const onDecision = (decision: ConfirmDecision) => {
                if (resolved) return;
                resolved = true;
                head.resolve(decision);
                dispatch({ type: 'confirmClose' });
              };
              // Capital-Y: enable YOLO mode straight from the prompt. Persists
              // via saveSettings (→ applyLiveSettings → permissionPolicy.setYolo)
              // and flips the statusline chip live. YOLO also approves this
              // pending call.
              const onEnableYolo = () => {
                if (resolved) return;
                onYolo?.(true);
                setYoloLive(true);
                const cur = getSettings?.();
                if (cur && saveSettings) {
                  Promise.resolve(saveSettings({ ...cur, yolo: true })).catch(() => {});
                }
                resolved = true;
                head.resolve('yes');
                dispatch({ type: 'confirmClose' });
              };
              return (
                <ConfirmPrompt
                  toolName={head.toolName}
                  input={head.input}
                  suggestedPattern={head.suggestedPattern}
                  onDecision={onDecision}
                  onEnableYolo={onEnableYolo}
                  destructive={head.destructive}
                  boundaryReason={head.boundaryReason}
                />
              );
            })()}
          {state.clearConfirm ? (
            <ClearConfirmPanel
              leaderActive={state.clearConfirm.leaderActive}
              subagentCount={state.clearConfirm.subagentCount}
              value={state.clearConfirm.value}
            />
          ) : null}
          {state.exitConfirm ? (
            <ExitConfirmPanel
              leaderActive={state.exitConfirm.leaderActive}
              subagentCount={state.exitConfirm.subagentCount}
              backgroundCount={state.exitConfirm.backgroundCount}
            />
          ) : null}
          {state.slashConfirm ? (
            <SlashConfirmPanel
              question={state.slashConfirm.question}
              defaultYes={state.slashConfirm.defaultYes}
            />
          ) : null}
          {state.escConfirm ? (
            <Box flexDirection="column" marginY={1} flexShrink={0}>
              <EscConfirmPrompt
                runningTools={state.escConfirm.snapshot.runningTools}
                subagentCount={state.escConfirm.snapshot.subagentsTerminated}
                onConfirm={() => {
                  const escConfirm = state.escConfirm;
                  if (!escConfirm) return;
                  const { snapshot } = escConfirm;
                  activeCtrlRef.current?.abort('user interrupt (Esc)');
                  clearPendingConfirms();
                  dispatch({ type: 'status', status: 'aborting' });
                  dispatch({ type: 'steerStart', snapshot });
                  const escConfirmDir = liveDirector();
                  if (escConfirmDir && snapshot.subagentsTerminated > 0) {
                    const cap = new Promise<void>((resolve) => {
                      const t = setTimeout(resolve, 1500);
                      t.unref?.();
                    });
                    void Promise.race([escConfirmDir.terminateAll().catch(() => undefined), cap]);
                  }
                  const droppedCount = state.queue.length;
                  if (droppedCount > 0) dispatch({ type: 'queueClear' });
                  const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
                  const fleetTag =
                    snapshot.subagentsTerminated > 0
                      ? ` · stopped ${snapshot.subagentsTerminated} subagent${snapshot.subagentsTerminated === 1 ? '' : 's'}`
                      : '';
                  dispatch({
                    type: 'addEntry',
                    entry: {
                      kind: 'warn',
                      text: `↯ Interrupted${droppedTag}${fleetTag}. Type your new direction.`,
                    },
                  });
                  dispatch({ type: 'escConfirmClose' });
                }}
                onCancel={() => {
                  dismissedEscAtRef.current = Date.now();
                  dispatch({ type: 'escConfirmClose' });
                }}
              />
            </Box>
          ) : null}
          {state.fallbackOverlay ? (
            <Box flexDirection="column" marginY={1} flexShrink={0}>
              {(() => {
                const ov = state.fallbackOverlay;
                let resolved = false;
                const finish = (choice: { providerId: string; model: string } | null) => {
                  if (resolved) return;
                  resolved = true;
                  if (choice) {
                    events.emit('provider.fallback_choice', {
                      requestId: ov.requestId,
                      providerId: choice.providerId,
                      model: choice.model,
                    });
                  } else {
                    // Esc or countdown expiry with null → auto-switch.
                    events.emit('provider.fallback_choice', {
                      requestId: ov.requestId,
                      autoSwitch: true,
                    });
                  }
                  dispatch({ type: 'fallbackOverlayClose' });
                };
                return (
                  <FallbackOverlay
                    requestId={ov.requestId}
                    from={ov.from}
                    status={ov.status}
                    candidates={ov.candidates}
                    autoSwitchSeconds={ov.autoSwitchSeconds}
                    selected={ov.selected}
                    onChoose={finish}
                    onMove={(delta) => dispatch({ type: 'fallbackOverlayMove', delta })}
                  />
                );
              })()}
            </Box>
          ) : null}
          {state.sendModePicker
            ? (() => {
                const info = state.sendModePicker;
                let resolved = false;
                const finish = (decision: SendMode | 'cancel') => {
                  if (resolved) return;
                  resolved = true;
                  info.resolve(decision);
                };
                return (
                  <SendModePicker
                    selected={info.selected}
                    messagePreview={info.displayText}
                    onMove={(delta) => dispatch({ type: 'sendModePickerMove', delta })}
                    onSelect={finish}
                  />
                );
              })()
            : null}
          {state.refineCountdown
            ? (() => {
                const info = state.refineCountdown;
                let resolved = false;
                const onDecision = (decision: Parameters<typeof info.resolve>[0]) => {
                  if (resolved) return;
                  resolved = true;
                  info.resolve(decision);
                };
                return (
                  <RefineCountdownPanel
                    original={info.original}
                    seconds={info.seconds}
                    onDecision={onDecision}
                    providerId={
                      refineProviderId ?? (agent.ctx.provider as { id?: string } | undefined)?.id
                    }
                    model={refineModel ?? agent.ctx.model}
                  />
                );
              })()
            : null}
          {state.enhanceBusy && !state.enhance ? (
            <RefiningPanel
              original={enhanceOriginalRef.current}
              elapsedMs={enhanceStartedAt === null ? 0 : Math.max(0, Date.now() - enhanceStartedAt)}
              pulseFrame={enhanceDots}
              providerId={
                refineProviderId ?? (agent.ctx.provider as { id?: string } | undefined)?.id
              }
              model={refineModel ?? agent.ctx.model}
            />
          ) : null}
          {state.enhance
            ? (() => {
                const info = state.enhance;
                let resolved = false;
                const onDecision = (decision: Parameters<typeof info.resolve>[0]) => {
                  if (resolved) return;
                  resolved = true;
                  setEnhanceCountdown(null);
                  info.resolve(decision);
                };
                return (
                  <EnhancePanel
                    original={info.original}
                    refined={info.refined}
                    english={info.english}
                    durationMs={enhanceDurationMs ?? 0}
                    delayMs={enhanceDelayMs}
                    enhanceLanguage={state.settingsPicker.enhanceLanguage}
                    onDecision={onDecision}
                    onTick={(r) => setEnhanceCountdown(r > 0 ? r : null)}
                    providerId={
                      refineProviderId ?? (agent.ctx.provider as { id?: string } | undefined)?.id
                    }
                    model={refineModel ?? agent.ctx.model}
                  />
                );
              })()
            : null}
          {state.refineFailure
            ? (() => {
                const info = state.refineFailure;
                let resolved = false;
                const onDecision = (decision: Parameters<typeof info.resolve>[0]) => {
                  if (resolved) return;
                  resolved = true;
                  info.resolve(decision);
                };
                return (
                  <RefineFailurePanel
                    original={info.original}
                    error={info.error}
                    elapsedMs={info.elapsedMs}
                    fallbackRef={info.fallbackRef}
                    models={info.models}
                    onDecision={onDecision}
                  />
                );
              })()
            : null}
          {state.continueConfirm
            ? (() => {
                const info = state.continueConfirm;
                let resolved = false;
                const onDecision = (decision: 'proceed' | 'edit' | 'cancel') => {
                  if (resolved) return;
                  resolved = true;
                  info.resolve(decision);
                };
                return (
                  <ContinueConfirmPanel
                    label={info.label}
                    instruction={info.instruction}
                    source={info.source}
                    grounded={info.grounded}
                    delayMs={CONTINUE_CONFIRM_DELAY_MS}
                    onDecision={onDecision}
                  />
                );
              })()
            : null}
          <AppStatusRegion host={host} runtime={runtime} mainColumnWidth={mainColumnWidth} />
        </Box>
      </Box>
      {sidebarWidth > 0 ? (
        <RightSidebar width={sidebarWidth} maxHeight={runtime.termRows} focused={state.sidebarFocused}>
          {/* Per-panel sidebar variants: render only when the panel is
              open AND routed to 'sidebar' AND wins a slot under
              SIDEBAR_PANEL_LIMIT (allocated above). Render order mirrors
              PANEL_IDS exactly so the sidebar reads top-to-bottom in the
              same sequence the settings picker lists the panels. */}
          {sidebarSlotVisible('projectPicker') ? (
            <ProjectPickerSidebar
              items={state.projectPicker.items}
              selected={state.projectPicker.selected}
              filter={state.projectPicker.filter}
              hint={state.projectPicker.hint}
              currentProject={agent.ctx.projectRoot}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('fleet') ? (
            <FleetPanelSidebar
              entries={statusbar.entriesWithLeader}
              runningCount={Object.values(statusbar.entriesWithLeader).filter((e) => e.status === 'running').length}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('agents') ? (
            <AgentsPanelSidebar
              entries={statusbar.entriesWithLeader}
              totalCost={state.fleetCost}
              nowTick={activity.nowTick}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('worktree') ? (
            <WorktreePanelSidebar
              worktrees={state.worktrees}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('plan') ? (
            <PlanPanelSidebar
              openCount={sidebarPlanData.items.filter((item) => item.status === 'open').length}
              inProgressCount={sidebarPlanData.items.filter((item) => item.status === 'in_progress').length}
              doneCount={sidebarPlanData.items.filter((item) => item.status === 'done').length}
              items={sidebarPlanData.items}
              title={sidebarPlanData.title}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('todos') ? (
            <TodosPanelSidebar
              todos={liveTodos ?? []}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('queue') ? (
            <QueuePanelSidebar
              items={state.queue}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('processList') ? (
            <ProcessListPanelSidebar
              activeCount={sidebarProcessData.activeCount}
              totalCount={sidebarProcessData.totalCount}
              processes={sidebarProcessData.processes}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('goal') ? (
            <GoalPanelSidebar
              goal={state.goalSummary}
              coordinatorRunning={state.goalRun?.monitorOpen ?? false}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('sessions') ? (
            <SessionsPanelSidebar
              liveSessions={state.sessionsPanel.sessions}
              resumeSessions={state.resumePicker.sessions}
              currentSessionId={agent.ctx.session?.id}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('coordinator') ? (
            <CoordinatorPanelSidebar
              running={state.coordinator.monitorOpen || (state.goalRun?.monitorOpen ?? false)}
              activePhases={state.goalRun?.runningPhaseIds.length ?? 0}
              completedPhases={state.goalRun
                ? Object.values(state.goalRun.phases).filter((p) => p.status === 'completed').length
                : 0}
              phaseNames={state.goalRun
                ? Object.values(state.goalRun.phases).map((p) => p.name)
                : []}
              elapsedMs={state.goalRun?.elapsedMs ?? 0}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('kanban') ? (
            <KanbanPanelSidebar
              columns={sidebarKanbanData.columns}
              totalActive={sidebarKanbanData.totalActive}
              activeCardTitles={sidebarKanbanData.activeCardTitles}
              width={sidebarContentWidth}
            />
          ) : null}
          {sidebarSlotVisible('connections') ? (
            <ConnectionsPanelSidebar
              connections={sidebarConnectionsData}
              width={sidebarContentWidth}
            />
          ) : null}
          {hiddenSidebarPanelCount > 0 ? (
            <Text color={theme.textMuted}>+{hiddenSidebarPanelCount} more</Text>
          ) : null}
          <SidebarContent
            contextWindow={statusbar.contextWindow}
            entries={statusbar.entriesWithLeader}
            fleetCounts={statusbar.fleetCounts}
            provider={liveProvider}
            model={liveModel}
            width={sidebarWidth}
            scrollOffset={state.sidebarScrollOffset}
            focused={state.sidebarFocused}
            todos={liveTodos}
            showSwarmSection={state.settingsPicker.open
              ? state.settingsPicker.showAgentSwarmPanel === 'sidebar'
              : (liveSettings?.showAgentSwarmPanel ?? 'bottom') === 'sidebar'}
            liveSessions={state.sessionsPanel.sessions}
            resumeSessions={state.resumePicker.sessions}
            currentSessionId={agent.ctx.session?.id}
          />
        </RightSidebar>
      ) : null}
    </Box>
    </Box>
  );
}
