import type React from 'react';
import { effectiveAgentSwarmPanelMode } from './app-ui-state.js';
import type { AppViewProps } from './app-view-contract.js';
import type { usePlanPanelData } from './components/plan-panel.js';
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
  WrongProxyPanelSidebar,
} from './components/sidebar-panels.js';
import type {
  useSidebarConnections,
  useSidebarKanban,
  useSidebarProcessList,
  useSidebarWrongProxy,
} from './hooks/use-sidebar-panel-data.js';
import { Text } from './ink.js';
import { getActiveThemeName, theme } from './theme.js';
import type { PanelId } from './ui-contracts.js';

export interface AppViewSidebarProps {
  host: AppViewProps['host'];
  runtime: AppViewProps['runtime'];
  sidebarWidth: number;
  sidebarContentWidth: number;
  sidebarSlotVisible: (id: PanelId) => boolean;
  hiddenSidebarPanelCount: number;
  sidebarProcessData: ReturnType<typeof useSidebarProcessList>;
  sidebarConnectionsData: ReturnType<typeof useSidebarConnections>;
  sidebarKanbanData: ReturnType<typeof useSidebarKanban>;
  sidebarPlanData: ReturnType<typeof usePlanPanelData>;
  /** Master switch from `liveSettings?.wrongProxyEnabled`. The WrongProxy
   *  sidebar panel renders only while this is true; when false the entire
   *  panel returns `null` so it doesn't take a slot in `SIDEBAR_PANEL_LIMIT`
   *  or burn IPC probes. */
  sidebarWrongProxyEnabled: boolean;
  /** Live probe data from `useSidebarWrongProxy`. `null` while the panel
   *  is bootstrapping or the daemon URL hasn't produced a response yet. */
  sidebarWrongProxyData: ReturnType<typeof useSidebarWrongProxy>;
}

export function AppViewSidebar({
  host,
  runtime,
  sidebarWidth,
  sidebarContentWidth,
  sidebarSlotVisible,
  hiddenSidebarPanelCount,
  sidebarProcessData,
  sidebarConnectionsData,
  sidebarKanbanData,
  sidebarPlanData,
  sidebarWrongProxyEnabled,
  sidebarWrongProxyData,
}: AppViewSidebarProps): React.ReactElement | null {
  const { agent } = host;
  const { state, activity, environment, statusbar, liveTodos, liveSettings } = runtime;
  const { processMemory, cpuPercent, cpuHistory, rssHistory, heapHistory, totalMem } = activity;
  const { liveModel, liveProvider } = environment;

  if (sidebarWidth <= 0) return null;

  // `effectiveSidebarRoutes` mirrors `sidebarSlotVisible` exactly: it is the
  // set of F-key panels that are routed to the sidebar AND win a slot under
  // SIDEBAR_PANEL_LIMIT this render. `SidebarContent` reads it to skip the
  // persistent AGENT SWARM / MISSIONS / SESSIONS cards when their F twin is
  // already mounted above — otherwise the user would see the same data
  // rendered twice (once as a routed twin, once as a persistent card).
  // Computed as a single Set here so the call sites stay declarative and
  // the gating logic lives in one place.
  const effectiveSidebarRoutes = new Set<PanelId>(
    (
      [
        'projectPicker',
        'fleet',
        'agents',
        'worktree',
        'plan',
        'todos',
        'queue',
        'processList',
        'goal',
        'sessions',
        'coordinator',
        'kanban',
        'connections',
      ] as const
    ).filter((id) => sidebarSlotVisible(id)),
  );

  return (
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
          runningCount={
            Object.values(statusbar.entriesWithLeader).filter((e) => e.status === 'running').length
          }
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
        <WorktreePanelSidebar worktrees={state.worktrees} width={sidebarContentWidth} />
      ) : null}
      {sidebarSlotVisible('plan') ? (
        <PlanPanelSidebar
          openCount={sidebarPlanData.items.filter((item) => item.status === 'open').length}
          inProgressCount={
            sidebarPlanData.items.filter((item) => item.status === 'in_progress').length
          }
          doneCount={sidebarPlanData.items.filter((item) => item.status === 'done').length}
          items={sidebarPlanData.items}
          title={sidebarPlanData.title}
          width={sidebarContentWidth}
        />
      ) : null}
      {sidebarSlotVisible('todos') ? (
        <TodosPanelSidebar todos={liveTodos ?? []} width={sidebarContentWidth} />
      ) : null}
      {sidebarSlotVisible('queue') ? (
        <QueuePanelSidebar items={state.queue} width={sidebarContentWidth} />
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
          completedPhases={
            state.goalRun
              ? Object.values(state.goalRun.phases).filter((p) => p.status === 'completed').length
              : 0
          }
          phaseNames={state.goalRun ? Object.values(state.goalRun.phases).map((p) => p.name) : []}
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
        <ConnectionsPanelSidebar connections={sidebarConnectionsData} width={sidebarContentWidth} />
      ) : null}
      {/* WrongProxy status panel — gated on the master switch from
          `liveSettings.wrongProxyEnabled` so it never appears when the
          user has the proxy off. The component itself renders the
          shareable `SidebarPanelFrame` chrome (no nested viewport), and
          `RightSidebar` is the sole owner of width/clipping. The panel
          is intentionally NOT in `PANEL_IDS`: it is not an F-key panel,
          and its slot allocation follows the master switch rather than
          a per-panel "position" preference — see app-view.tsx for the
          `useSidebarWrongProxy` hook that powers it (and the
          `&& sidebarWidth > 0` short-circuit so the probe loop stays
          dormant on narrow terminals). */}
      {sidebarWrongProxyEnabled ? (
        <WrongProxyPanelSidebar proxy={sidebarWrongProxyData} width={sidebarContentWidth} />
      ) : null}
      {hiddenSidebarPanelCount > 0 ? (
        <Text color={theme.textMuted}>+{hiddenSidebarPanelCount} more</Text>
      ) : null}
      <SidebarContent
        contextWindow={statusbar.contextWindow}
        contextBreakdown={statusbar.contextBreakdown}
        cacheStats={statusbar.cacheStats}
        entries={statusbar.entriesWithLeader}
        fleetCounts={statusbar.fleetCounts}
        provider={liveProvider}
        model={liveModel}
        themeName={getActiveThemeName()}
        width={sidebarWidth}
        scrollOffset={state.sidebarScrollOffset}
        focused={state.sidebarFocused}
        todos={liveTodos}
        showSwarmSection={effectiveAgentSwarmPanelMode(state, liveSettings) === 'sidebar'}
        liveSessions={state.sessionsPanel.sessions}
        resumeSessions={state.resumePicker.sessions}
        currentSessionId={agent.ctx.session?.id}
        processMemory={processMemory}
        cpuPercent={cpuPercent}
        cpuHistory={cpuHistory}
        rssHistory={rssHistory}
        heapHistory={heapHistory}
        totalMem={totalMem}
        effectiveSidebarRoutes={effectiveSidebarRoutes}
      />
    </RightSidebar>
  );
}
