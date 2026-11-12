import { getProcessRegistry } from '@wrongstack/tools';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { effectiveAgentSwarmPanelMode, effectivePanelPositions } from './app-ui-state.js';
import type { AppViewProps } from './app-view-contract.js';
import { AgentsMonitor } from './components/agents-monitor.js';
import { ContextPanel } from './components/context-panel.js';
import { CronJobsMonitor } from './components/cron-jobs.js';
import { FleetMonitor } from './components/fleet-monitor.js';
import { FleetPanel } from './components/fleet-panel.js';
import { GoalKanbanPanel } from './components/goal-kanban-panel.js';
import { GoalPanel } from './components/goal-panel.js';
import { HelpOverlay } from './components/help-overlay.js';
import { KanbanPanel } from './components/kanban-panel.js';
import { MailboxPanel } from './components/mailbox-panel.js';
import { PhaseMonitor } from './components/phase-monitor.js';
import { PhasePanel } from './components/phase-panel.js';
import { PlanPanel } from './components/plan-panel.js';
import { ProcessListMonitor } from './components/process-list.js';
import { QueuePanel } from './components/queue-panel.js';
import { SddBoardOverlay } from './components/sdd-board-overlay.js';
import { SessionsPanel } from './components/sessions-panel.js';
import { StatusBar } from './components/status-bar.js';
import { COMPOSER_OWNED_CHIPS, type StatuslineItem } from './components/statusline-picker.js';
import { TodosMonitor } from './components/todos-monitor.js';
import { WorktreeMonitor } from './components/worktree-monitor.js';
import { WorktreePanel } from './components/worktree-panel.js';
import { Box } from './ink.js';
import { effectiveAnimationStyle } from './motion.js';
import { renderRunningTools } from './running-tools.js';
import { getActiveThemeName } from './theme.js';
import type { PanelId, PanelPositionMap } from './ui-contracts.js';

// The dual-source swarm-mode read (`resolveAgentSwarmPanelVisibility`) and
// its state-bound form (`effectiveAgentSwarmPanelMode`) live in
// app-ui-state.ts next to the panel-routing authority. Re-exported here for
// backward compatibility with existing test imports.
export { resolveAgentSwarmPanelVisibility } from './app-ui-state.js';

interface AppStatusRegionProps extends AppViewProps {
  panelsSuppressed?: boolean | undefined;
  /** Optional column width cap for the status bar (when beside a sidebar). */
  mainColumnWidth?: number | undefined;
}

/**
 * Suppress the chips the composer's top rail already owns. Their entries stay
 * in `STATUSLINE_ITEMS` (the mouse hit-test indexes by position) and stay
 * user-togglable — they are only render-suppressed here, so the bar never
 * shows the same indicator twice.
 */
function mergeComposerOwnedChips(hiddenItems: readonly StatuslineItem[]): StatuslineItem[] {
  const merged = new Set<StatuslineItem>(hiddenItems);
  for (const chip of COMPOSER_OWNED_CHIPS) merged.add(chip);
  return [...merged];
}

/** The chip suffix for a leader-chosen effort, so it never reads as the user's. */
function leaderEffortLabel(effort: string | undefined): string | undefined {
  return effort ? `${effort} (leader)` : undefined;
}

export function AppStatusRegion({
  host,
  runtime,
  mainColumnWidth,
  panelsSuppressed = false,
}: AppStatusRegionProps): React.ReactElement {
  const {
    agent,
    agentTranscripts,
    appVersion,
    latestVersion,
    updateAvailable,
    subscribeUpdateReady,
    director,
    events,
    fleetRoster,
    getModeLabel,
    getSettings,
    getLeaderEffort,
    onCoordinatorStart,
    onCoordinatorStop,
    tokenCounter,
    tokenSavingMode,
    pluginUiRegistry,
    treeCoordinator,
  } = host;
  const [pluginChips, setPluginChips] = useState(() => pluginUiRegistry?.listStatusChips());
  useEffect(() => {
    if (!pluginUiRegistry) {
      setPluginChips(undefined);
      return undefined;
    }
    setPluginChips(pluginUiRegistry.listStatusChips());
    return pluginUiRegistry.subscribe(() => {
      setPluginChips(pluginUiRegistry.listStatusChips());
    });
  }, [pluginUiRegistry]);

  const [activeSessionBranch, setActiveSessionBranch] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const coordinator = typeof treeCoordinator === 'function' ? treeCoordinator() : treeCoordinator;
    if (coordinator) {
      void coordinator
        .getTree()
        .then((tree) => {
          if (cancelled) return;
          const active = tree.branches[tree.activeBranchId];
          if (active && (Object.keys(tree.branches).length > 1 || active.name !== 'main')) {
            setActiveSessionBranch(active.name);
          } else {
            setActiveSessionBranch(null);
          }
        })
        .catch(() => {});
    } else {
      setActiveSessionBranch(null);
    }
    const off = events.on('session.branch_switched', (payload) => {
      if (payload.sessionId !== agent.ctx.session.id) return;
      setActiveSessionBranch(payload.branchName);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [treeCoordinator, events, agent.ctx.session.id]);

  const mergedStatusChips = useMemo(() => {
    if (!activeSessionBranch) return pluginChips;
    const branchChip = {
      qualifiedId: 'session:branch',
      owner: 'session',
      id: 'branch',
      icon: '⎇',
      text: activeSessionBranch,
      tone: 'accent' as const,
      priority: 100,
      command: '/tree',
      updatedAt: 0,
    };
    return [branchChip, ...(pluginChips ?? [])];
  }, [activeSessionBranch, pluginChips]);
  const {
    state,
    dispatch,
    activity,
    environment,
    statusbar,
    mailbox,
    gitInfo,
    viewState,
    statusBarWrapRef,
    belowStatusBarRef,
    statusBarClickMapRef,
    liveTodos,
    liveSettings,
    liveAnimationStyle,
    liveStatuslineMode,
    projectName,
    workingDirChip,
    enhanceCountdown,
    nextStepsAutoSubmitCountdown,
    nextStepsAutoSubmitLabel,
    setDraft,
    focusedBoardId,
    getCronJobs,
    getLeaderTranscript,
    coordinatorRunning,
  } = runtime;
  const { displayThinkingWord, startedAt, nowTick, fleetWorkingTimeMs } = activity;
  const {
    liveModel,
    liveProvider,
    yoloLive,
    autonomyLive,
    liveModeLabel,
    hiddenItems,
    lines,
    densities,
    order,
    sessionCount,
    memoryContextMonitor,
    memoryRecordTotal,
    activeMemoryInContext,
    liveToolCount,
    indexState,
    breakerCountdown,
  } = environment;
  const {
    contextBreakdown,
    contextResidency,
    historyRetention,
    currentContextTokens,
    contextWindow,
    cacheStats,
    cacheCoverageTokens,
    todos,
    fleetCounts,
    visibleSubagentCount,
    hasVisibleFleetPanel,
    entriesWithLeader,
    planCounts,
    taskCounts,
    droppedTools,
  } = statusbar;
  const { mailboxStatus, mailboxPanelOpen, mailboxMessages, mailboxAgents } = mailbox;
  const { lowerFunctionPanelOpen } = viewState;
  const projectRoot = agent.ctx.projectRoot;

  // Per-panel position routing. When a panel is set to 'sidebar', its
  // bottom-region render is suppressed and the right sidebar renders the
  // sidebar twin instead. See app-view.tsx for the sidebar twin dispatch.
  // `effectivePanelPositions` is the same dual-source authority (picker
  // draft while the settings picker is open, persisted config otherwise)
  // the renderer and the dispatcher use — reading `liveSettings` directly
  // here made this surface lag the sidebar twin while the picker was open,
  // double-rendering the routed panel.
  const panelPositions: PanelPositionMap = effectivePanelPositions(state, liveSettings);
  const routedToBottom = (id: PanelId): boolean => panelPositions[id] === 'bottom';
  const effectiveHiddenItems = useMemo(() => mergeComposerOwnedChips(hiddenItems), [hiddenItems]);
  const [updateReadyVersion, setUpdateReadyVersion] = useState<string | undefined>();
  useEffect(() => subscribeUpdateReady?.(setUpdateReadyVersion), [subscribeUpdateReady]);

  return (
    <>
      <Box ref={statusBarWrapRef} flexDirection="column" flexShrink={0}>
        <StatusBar
          provider={liveProvider}
          model={liveModel}
          // Reasoning effort rides INSIDE the model chip. Sourced the same
          // read-only way as promptVariant below (config → getSettings), and
          // the /model picker's effort strip writes through the same
          // saveSettings, so both surfaces land on one value. While the
          // settings picker is open we preview its live ←/→ selection:
          // saveSettings → configStore is async, so the persisted read would
          // lag the keystroke the way the animation style does.
          // A `leader_effort_set` change outranks the persisted value only
          // while the user has not changed effort since — `getLeaderEffort`
          // already applies that rule, so a defined answer is the live one.
          effort={
            getSettings
              ? state.settingsPicker.open
                ? state.settingsPicker.reasoningEffort
                : (leaderEffortLabel(getLeaderEffort?.()) ?? getSettings().reasoningEffort)
              : undefined
          }
          version={appVersion}
          latestVersion={latestVersion}
          updateAvailable={updateAvailable}
          updateReadyVersion={updateReadyVersion}
          state={state.status}
          thinkingWord={displayThinkingWord}
          thinkingAnimationStyle={
            // While the settings picker is open, preview the picker's live
            // ←/→ selection synchronously (saveSettings → configStore is
            // async, so liveAnimationStyle lags a keystroke). When closed,
            // use the persisted value from getSettings().
            effectiveAnimationStyle(
              state.settingsPicker.open ? state.settingsPicker.animationStyle : liveAnimationStyle,
            )
          }
          tokenCounter={tokenCounter}
          hint={state.copiedNotice || renderRunningTools(state.runningTools) || state.hint}
          queueCount={state.queue.length}
          yolo={yoloLive}
          // `/yolo plus` writes the conversation meta; read it per render.
          yoloPlus={yoloLive && agent.ctx.meta['yoloPlus'] === true}
          autonomy={autonomyLive}
          droppedTools={droppedTools}
          startedAt={startedAt}
          fleetWorkingTime={fleetWorkingTimeMs}
          todos={todos}
          plan={planCounts ?? undefined}
          tasks={taskCounts ?? undefined}
          fleet={fleetCounts}
          git={gitInfo}
          context={contextWindow}
          estimatedContextTokens={currentContextTokens}
          Sage={
            memoryRecordTotal === undefined
              ? undefined
              : { total: memoryRecordTotal, activeInContext: activeMemoryInContext }
          }
          memoryContextMonitor={memoryContextMonitor}
          contextStrategy={getSettings ? getSettings().contextStrategy : undefined}
          promptVariant={getSettings ? getSettings().systemPromptVariant : undefined}
          brain={state.brain}
          projectName={projectName}
          workingDir={workingDirChip}
          subagentCount={visibleSubagentCount}
          processCount={getProcessRegistry().activeCount}
          // The composer top rail owns the working/idle indicator, so only
          // suppress the duplicate `state` chip. Keep `model` governed by
          // the user's statusline settings so the live provider/model route
          // remains visible beside the project/workdir information.
          hiddenItems={effectiveHiddenItems}
          statuslineLines={lines}
          statuslineDensities={densities}
          statuslineOrder={order}
          mode={liveStatuslineMode}
          visibleChips={state.statuslinePicker.visibleChips}
          events={events}
          sessionId={agent.ctx.session.id}
          eternalStage={state.eternalStage}
          goalSummary={state.goalSummary}
          indexState={indexState}
          breakerCountdown={breakerCountdown}
          modeLabel={liveModeLabel || undefined}
          themeName={getActiveThemeName()}
          debugStreamStats={state.debugStreamStats}
          enhanceCountdown={enhanceCountdown}
          nextStepsAutoSubmitCountdown={nextStepsAutoSubmitCountdown}
          nextStepsAutoSubmitLabel={nextStepsAutoSubmitLabel}
          autoProceedCountdown={state.countdown?.remainingSeconds ?? null}
          sessionCount={sessionCount}
          mailbox={mailboxStatus}
          tokenSavingMode={liveSettings?.featureTokenSaving ?? tokenSavingMode}
          toolCount={liveToolCount}
          sideEffectCount={agent.ctx.sideEffects?.length ?? 0}
          pluginChips={mergedStatusChips}
          maxWidth={mainColumnWidth}
          clickMapRef={statusBarClickMapRef}
        />
      </Box>
      {/* Everything below the status bar is wrapped so its height can be
              measured (via belowStatusBarRef) — the status-bar mouse hit-test
              subtracts it from termRows to find the bar's absolute rows. The
              mailbox panel must live INSIDE this measured box: rendered
              between the two boxes its rows were counted by neither
              measurement and every status-bar hit-test row was off by the
              panel's height whenever /mailbox was open. */}
      <Box ref={belowStatusBarRef} flexDirection="column" flexShrink={0}>
        {state.helpOpen ? <HelpOverlay /> : null}
        <Box flexDirection="column" display={panelsSuppressed ? 'none' : 'flex'}>
          {/* Mailbox panel — toggled via /mailbox slash command */}
          <MailboxPanel
            messages={mailboxMessages}
            agents={mailboxAgents}
            unreadCount={mailboxStatus.unread}
            open={mailboxPanelOpen}
          />
          {/* Keys-&-commands help overlay (`?` on an empty prompt). Modal: while
          open, handleKey swallows everything but Esc/?/q, so it never coexists
          with a monitor; the overlay scrolls its own height-limited window
          with ↑/↓/PgUp/PgDn via its own useInput. */}
          {/* Agents monitor overlay (Ctrl+G) and fleet monitor overlay (Ctrl+F)
          take up the lower region — hide FleetPanel while any overlay is open. */}
          {state.agentsMonitorOpen && routedToBottom('agents') ? (
            <AgentsMonitor
              entries={entriesWithLeader}
              totalCost={state.fleetCost}
              leaderCost={tokenCounter?.estimateCost().total ?? 0}
              totalTokens={state.fleetTokens}
              nowTick={nowTick}
              onClose={() => dispatch({ type: 'toggleAgentsMonitor' })}
              transcripts={agentTranscripts}
              leaderTranscript={getLeaderTranscript}
            />
          ) : state.goalRun?.monitorOpen && routedToBottom('coordinator') ? (
            <PhaseMonitor
              title={state.goalRun.title}
              phases={state.goalRun.phases}
              runningPhaseIds={state.goalRun.runningPhaseIds}
              elapsedMs={state.goalRun.elapsedMs}
              nowTick={nowTick}
            />
          ) : state.sddBoard?.monitorOpen ? (
            <SddBoardOverlay
              snapshot={state.sddBoard.snapshot}
              focusColumn={state.sddBoard.focusColumn ?? null}
            />
          ) : state.worktreeMonitorOpen && routedToBottom('worktree') ? (
            <WorktreeMonitor
              events={state.worktreeTimeline}
              nowTick={nowTick}
              onClose={() => dispatch({ type: 'toggleWorktreeMonitor' })}
            />
          ) : state.todosMonitorOpen && routedToBottom('todos') ? (
            <TodosMonitor todos={liveTodos} />
          ) : state.monitorOpen && routedToBottom('fleet') ? (
            <FleetMonitor
              entries={state.fleet}
              totalCost={state.fleetCost}
              totalTokens={state.fleetTokens}
              maxConcurrent={state.fleetConcurrency}
              nowTick={nowTick}
              collabSession={state.collabSession}
            />
          ) : state.planPanelOpen && routedToBottom('plan') ? (
            <PlanPanel
              projectRoot={agent.ctx.projectRoot}
              sessionId={agent.ctx.session?.id ?? null}
              onClose={() => dispatch({ type: 'togglePlanPanel' })}
            />
          ) : state.kanbanPanelOpen && routedToBottom('kanban') ? (
            <KanbanPanel
              projectRoot={agent.ctx.projectRoot}
              sessionId={agent.ctx.eventSessionId()}
              sessionContext={agent.ctx}
              onClose={() => dispatch({ type: 'toggleKanbanPanel' })}
              initialBoardId={focusedBoardId ?? undefined}
            />
          ) : state.queuePanelOpen && routedToBottom('queue') ? (
            <QueuePanel
              items={state.queue}
              onDelete={(pos) => dispatch({ type: 'queueDelete', positions: [pos + 1] })}
              onClear={() => dispatch({ type: 'queueClear' })}
              onEdit={(pos) => {
                const item = state.queue[pos];
                if (item) {
                  setDraft(item.displayText, item.displayText.length);
                  dispatch({ type: 'toggleQueuePanel' });
                }
              }}
              onToggleRefine={(pos) => dispatch({ type: 'queueToggleRefine', position: pos })}
            />
          ) : state.processListOpen && routedToBottom('processList') ? (
            <ProcessListMonitor />
          ) : state.cronMonitorOpen ? (
            <CronJobsMonitor
              getCronJobs={getCronJobs}
              onCancel={async (name) => {
                const tool = agent.tools.get('session_wakeup');
                if (!tool) return 'session_wakeup tool is not registered.';
                try {
                  const result = (await tool.execute({ action: 'cancel', id: name }, agent.ctx, {
                    signal: AbortSignal.timeout(5000),
                  })) as { ok?: boolean | undefined; error?: string | undefined };
                  return result.ok === false ? (result.error ?? `Could not cancel ${name}.`) : null;
                } catch (error) {
                  return error instanceof Error ? error.message : String(error);
                }
              }}
            />
          ) : state.goalPanelOpen && routedToBottom('goal') ? (
            <GoalPanel
              goal={state.goalSummary}
              onCoordinatorStart={onCoordinatorStart ?? undefined}
              onCoordinatorStop={onCoordinatorStop ?? undefined}
              coordinatorRunning={coordinatorRunning}
            />
          ) : state.goalKanbanPanelOpen ? (
            <GoalKanbanPanel
              projectRoot={projectRoot}
              goal={state.goalSummary}
              onClose={() => dispatch({ type: 'toggleGoalKanbanPanel' })}
            />
          ) : state.contextPanelOpen ? (
            <ContextPanel
              data={{
                ctxPct: state.leader.ctxPct,
                ctxTokens: state.leader.ctxTokens,
                ctxMaxTokens: state.leader.ctxMaxTokens,
                provider: (agent.ctx.provider as { id?: string } | undefined)?.id ?? 'unknown',
                model: agent.ctx.model,
                mode: getModeLabel?.() ?? 'default',
                uptime: (() => {
                  const elapsed = Date.now() - state.leader.startedAt;
                  const hrs = Math.floor(elapsed / 3600000);
                  const mins = Math.floor((elapsed % 3600000) / 60000);
                  const secs = Math.floor((elapsed % 60000) / 1000);
                  if (hrs > 0) return `${hrs}h ${mins}m`;
                  if (mins > 0) return `${mins}m ${secs}s`;
                  return `${secs}s`;
                })(),
                cacheStats: cacheStats ?? {
                  readTokens: 0,
                  writeTokens: 0,
                  hitRatio: 0,
                  savedUsd: 0,
                },
                cacheCoverageTokens: cacheCoverageTokens ?? 0,
                providerCacheStats: cacheStats?.providers ?? [],
                fleetEntries: Object.values(state.fleet).map((e) => ({
                  name: e.name,
                  status: e.status,
                  currentTool: e.currentTool?.name,
                  ctxPct: e.ctxPct,
                })),
                leaderIterations: state.leader.iterations,
                leaderToolCalls: state.leader.toolCalls,
                leaderStatus: state.status,
                breakdown: contextBreakdown,
                residency: contextResidency,
                retention: historyRetention,
                memoryContext: memoryContextMonitor,
              }}
              onClose={() => dispatch({ type: 'toggleContextPanel' })}
            />
          ) : state.sessionsPanelOpen && routedToBottom('sessions') ? (
            <SessionsPanel
              sessions={state.sessionsPanel.sessions}
              busy={state.sessionsPanel.busy}
              selected={state.sessionsPanel.selected}
              resumeConfirm={
                state.sessionResumeConfirm
                  ? { sessionName: state.sessionResumeConfirm.sessionName }
                  : undefined
              }
              currentSessionId={agent.ctx.session?.id}
            />
          ) : !lowerFunctionPanelOpen &&
            (director || hasVisibleFleetPanel || state.collabSession) &&
            effectiveAgentSwarmPanelMode(state, liveSettings) !== 'off' &&
            routedToBottom('fleet') ? (
            <FleetPanel
              entries={entriesWithLeader}
              totalCost={state.fleetCost}
              roster={fleetRoster}
              todos={liveTodos}
              nowTick={nowTick}
              collabSession={state.collabSession}
              maxWidth={mainColumnWidth}
            />
          ) : null}
          {state.goalRun && !lowerFunctionPanelOpen && routedToBottom('coordinator') ? (
            <PhasePanel
              phases={state.goalRun.phases}
              runningPhaseIds={state.goalRun.runningPhaseIds}
              nowTick={nowTick}
            />
          ) : null}
          {Object.keys(state.worktrees).length > 0 &&
          !lowerFunctionPanelOpen &&
          routedToBottom('worktree') ? (
            <WorktreePanel worktrees={state.worktrees} nowTick={nowTick} />
          ) : null}
        </Box>
      </Box>
    </>
  );
}
