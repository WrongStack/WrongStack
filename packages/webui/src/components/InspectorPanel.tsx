/**
 * InspectorPanel — the global right-side workbench inspector.
 *
 * It is intentionally a non-modal Radix Sheet on desktop-sized workspaces:
 * the drawer overlays the main surface instead of shrinking chat/editor/board
 * layout, while the rest of the workbench stays visible and interactive.
 * Fleet, agent detail and side-effect audit are the first migrated targets;
 * task, node and message detail surfaces can join the same shell next.
 */

import { Activity, Bot, ChevronLeft, Columns3, PanelRightOpen, Scale, Users, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  EventTimeline,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { openPanel } from '@/components/activity-bar/nav';
import type { FleetTimelineEvent, InspectorTab, SubagentView } from '@/stores';
import { useCouncilLogStore, useFleetStore, useKanbanStore, useSessionStore, useSideEffectStore, useUIStore } from '@/stores';
import { AgentCard } from './AgentCard';
import { FleetAgentRow } from '@/components/ui/fleet-agent-row';
import { CouncilLogTimeline } from './CouncilLogTimeline';
import { SideEffectTimeline } from './SideEffectTimeline';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';

function fmtCost(v: number): string {
  if (v <= 0) return '$0';
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(5)}`.replace(/0+$/, '').replace(/\.$/, '');
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Shared fleet sort: leader first, then running, then by start time. */
function sortFleet(
  agents: Map<string, SubagentView>,
  leaderId: string | undefined,
): SubagentView[] {
  const arr = Array.from(agents.values());
  arr.sort((x, y) => {
    if (x.id === leaderId) return -1;
    if (y.id === leaderId) return 1;
    const xa = x.status === 'running' ? 0 : 1;
    const ya = y.status === 'running' ? 0 : 1;
    if (xa !== ya) return xa - ya;
    return x.startedAt - y.startedAt;
  });
  return arr;
}

/** Compact shell action used by the top bar. Keeping its subscriptions here
 * avoids making the App root re-render for every fleet/audit counter update. */
export function InspectorTrigger(): React.ReactElement {
  const { t } = useAppTranslation();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const activeActivity = useUIStore((s) => s.activeActivity);
  const currentSessionId = useSessionStore((s) => s.session?.id);
  const agentsSidebarActive = sidebarOpen && activeActivity === 'agents';
  const runningCount = useFleetStore(
    (s) =>
      Array.from(s.agents.values()).filter(
        (agent) =>
          (!agent.sessionId || !currentSessionId || agent.sessionId === currentSessionId) &&
          agent.status === 'running',
      ).length,
  );
  const badge = runningCount;

  return (
    <button
      type="button"
      data-testid="inspector-trigger"
      aria-expanded={agentsSidebarActive}
      aria-label={t('activity:inspector.openAgentsPanel')}
      onClick={() => openPanel('agents')}
      className={cn(
        'relative inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors',
        agentsSidebarActive
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
      title={t('activity:inspector.openAgentsPanel')}
    >
      <Bot className="h-3.5 w-3.5" />
      <span className="hidden lg:inline">{t('activity:nav.agents')}</span>
      {badge > 0 ? (
        <span className="min-w-4 bg-primary/15 px-1 text-[10px] font-semibold tabular-nums text-primary">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
}

export function InspectorPanel() {
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const inspectorTab = useUIStore((s) => s.inspectorTab);
  const setInspectorOpen = useUIStore((s) => s.setInspectorOpen);
  const setInspectorTab = useUIStore((s) => s.setInspectorTab);
  const inspectorFocusedAgentId = useUIStore((s) => s.inspectorFocusedAgentId);
  const setInspectorFocusedAgentId = useUIStore((s) => s.setInspectorFocusedAgentId);
  const currentSessionId = useSessionStore((s) => s.session?.id);
  const { t } = useAppTranslation();

  // Fleet-wide signals (subscribed narrowly so tab switches / typing in the
  // chat don't re-render this component).
  const fleetAgents = useFleetStore((s) => s.agents);
  const leaderId = useFleetStore((s) => s.leaderId);
  const fleetTokensIn = useFleetStore((s) => s.fleetTokensIn);
  const fleetTokensOut = useFleetStore((s) => s.fleetTokensOut);
  const eventTimeline = useFleetStore((s) => s.eventTimeline);

  const sessionFleetAgents = useMemo(() => {
    const m = new Map<string, SubagentView>();
    for (const [k, v] of fleetAgents) {
      if (!v.sessionId || !currentSessionId || v.sessionId === currentSessionId) {
        m.set(k, v);
      }
    }
    return m;
  }, [fleetAgents, currentSessionId]);

  const fleetList = useMemo(
    () => sortFleet(sessionFleetAgents, leaderId),
    [sessionFleetAgents, leaderId],
  );

  const runningCount = fleetList.filter((a) => a.status === 'running').length;
  const totalCost = fleetList.reduce((sum, a) => sum + a.costUsd, 0);
  const fleetTotal = fleetList.length;

  // Agents-tab selection state lives locally — the panel owns which agent
  // card is expanded. Kept inside the component so fleet-tab interactions
  // don't reset it.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = useMemo(() => {
    if (!selectedAgentId) return fleetList[0] ?? null;
    return fleetAgents.get(selectedAgentId) ?? fleetList[0] ?? null;
  }, [selectedAgentId, fleetList, fleetAgents]);

  const sideEffectCount = useSideEffectStore((s) => s.sideEffects.length);
  // Subscribed as two scalars rather than the panel array: the array changes
  // identity on every seat vote, and the tab bar must not re-render the whole
  // inspector for each one.
  const councilCount = useCouncilLogStore((s) => s.panels.length);
  const councilVotingCount = useCouncilLogStore(
    (s) => s.panels.filter((panel) => panel.phase === 'voting').length,
  );

  // Clicking a row in the fleet list jumps to that agent's detail card.
  const handleSelectAgent = (agent: SubagentView) => {
    setSelectedAgentId(agent.id);
    setInspectorTab('agents');
  };

  // React to external focus request (e.g., clicking "Open in Inspector"
  // from the AgentsPanel detail section).
  useEffect(() => {
    if (inspectorFocusedAgentId && inspectorOpen) {
      setSelectedAgentId(inspectorFocusedAgentId);
      setInspectorTab('agents');
      setInspectorFocusedAgentId(null);
    }
  }, [inspectorFocusedAgentId, inspectorOpen, setInspectorTab, setInspectorFocusedAgentId]);

  const inspectorTarget = useUIStore((s) => s.inspectorTarget);
  const openInspectorTarget = useUIStore((s) => s.openInspectorTarget);

  return (
    <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen} modal={false}>
      <SheetContent
        id="workbench-inspector"
        data-testid="inspector-drawer"
        side="right"
        showOverlay={false}
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLElement>('[data-testid="inspector-trigger"]')?.focus();
        }}
        className="flex w-[calc(100vw-3rem)] max-w-none flex-col gap-0 overflow-hidden border-l border-border/80 bg-card/96 p-0 shadow-[-24px_0_64px_-36px_hsl(var(--shadow-color)/0.65)] backdrop-blur-xl sm:w-[min(680px,48vw)] sm:max-w-[680px]"
      >
        {inspectorTarget?.kind === 'task' ? (
          <>
            <SheetHeader className="relative gap-1 border-b border-border/70 bg-muted/20 px-4 py-3 pr-12">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openInspectorTarget({ kind: 'fleet', tab: 'fleet' })}
                  className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  title="Back to Fleet"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span>Fleet</span>
                </button>
                <span className="text-muted-foreground/40">/</span>
                <SheetTitle className="flex items-center gap-1.5 text-sm font-semibold truncate">
                  <Columns3 className="h-4 w-4 text-primary shrink-0" />
                  <span className="truncate">{inspectorTarget.title || inspectorTarget.taskId}</span>
                </SheetTitle>
              </div>
              <SheetDescription className="text-[11px] font-mono text-muted-foreground truncate">
                Task ID: {inspectorTarget.taskId} {inspectorTarget.boardId ? `· Board: ${inspectorTarget.boardId}` : ''}
              </SheetDescription>
              <SheetClose asChild>
                <button
                  type="button"
                  data-testid="inspector-close"
                  className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={t('activity:inspector.collapseAria')}
                  title={t('activity:inspector.collapseTitle')}
                >
                  <X className="h-4 w-4" />
                </button>
              </SheetClose>
            </SheetHeader>

            <TaskInspectorContent
              taskId={inspectorTarget.taskId}
              boardId={inspectorTarget.boardId}
              onBack={() => openInspectorTarget({ kind: 'fleet', tab: 'fleet' })}
            />
          </>
        ) : (
          <>
            <SheetHeader className="relative gap-1 border-b border-border/70 bg-muted/20 px-4 py-3 pr-12">
              <SheetTitle className="flex items-center gap-2 text-sm">
                <PanelRightOpen className="h-4 w-4 text-primary" />
                {t('activity:inspector.label')}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                {fleetTotal > 0 ? (
                  <>
                    <span className="inline-flex items-center gap-1">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          runningCount > 0 ? 'bg-success animate-pulse' : 'bg-muted-foreground/50',
                        )}
                      />
                      <span className="tabular-nums">
                        {runningCount}/{fleetTotal}
                      </span>
                    </span>
                    <span className="font-mono tabular-nums">
                      ↓{fmtTok(fleetTokensIn)} ↑{fmtTok(fleetTokensOut)} · {fmtCost(totalCost)}
                    </span>
                  </>
                ) : (
                  <span>{t('activity:inspector.agentsAppearHint')}</span>
                )}
              </SheetDescription>
              <SheetClose asChild>
                <button
                  type="button"
                  data-testid="inspector-close"
                  className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={t('activity:inspector.collapseAria')}
                  title={t('activity:inspector.collapseTitle')}
                >
                  <X className="h-4 w-4" />
                </button>
              </SheetClose>
            </SheetHeader>

            <Tabs
              value={inspectorTab}
              onValueChange={(value) => setInspectorTab(value as InspectorTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList
                className="flex h-10 min-h-10 shrink-0 justify-start gap-1 border-x-0 border-t-0 border-b border-border/70 bg-muted/30 p-2 shadow-none"
                aria-label={t('activity:inspector.label')}
              >
                <TabButton
                  value="fleet"
                  icon={<Bot className="h-3.5 w-3.5" />}
                  label={t('activity:inspector.tabFleet')}
                  count={fleetTotal}
                  running={runningCount}
                />
                <TabButton
                  value="agents"
                  icon={<Users className="h-3.5 w-3.5" />}
                  label={t('activity:inspector.tabAgents')}
                  count={fleetTotal}
                />
                <TabButton
                  value="sideEffects"
                  icon={<Activity className="h-3.5 w-3.5" />}
                  label={t('activity:inspector.tabAudit')}
                  count={sideEffectCount}
                />
                <TabButton
                  value="council"
                  icon={<Scale className="h-3.5 w-3.5" />}
                  label={t('activity:inspector.tabCouncil', { defaultValue: 'Council' })}
                  count={councilCount}
                  running={councilVotingCount}
                />
              </TabsList>

              <TabsContent value="fleet" className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
                <FleetTabContent
                  fleetList={fleetList}
                  leaderId={leaderId}
                  selectedAgentId={selectedAgentId}
                  eventTimeline={eventTimeline}
                  onSelectAgent={handleSelectAgent}
                />
              </TabsContent>
              <TabsContent value="agents" className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
                <AgentsTabContent
                  fleetList={fleetList}
                  selectedAgent={selectedAgent}
                  leaderId={leaderId}
                  selectedAgentId={selectedAgent?.id ?? null}
                  onSelectAgent={setSelectedAgentId}
                />
              </TabsContent>
              <TabsContent value="sideEffects" className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
                <SideEffectTimeline />
              </TabsContent>
              <TabsContent value="council" className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
                <CouncilLogTimeline />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function TaskInspectorContent({
  taskId,
  boardId: _boardId,
  onBack,
}: {
  taskId: string;
  boardId?: string | undefined;
  onBack: () => void;
}) {
  const activeBoard = useKanbanStore((s) => s.activeBoard);
  const task = useMemo(() => {
    return activeBoard?.tasks.find((t) => t.id === taskId) ?? null;
  }, [activeBoard, taskId]);

  if (!task) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground p-4">
        <Columns3 className="h-8 w-8 mb-2 opacity-30 text-primary" />
        <p className="text-xs font-medium">Task details ({taskId})</p>
        <p className="text-[11px] text-muted-foreground mt-1">
          Select a task from Kanban or SDD to inspect full parameters.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 px-3 py-1 text-xs rounded bg-muted hover:bg-muted/80 text-foreground transition-colors"
        >
          Back to Fleet
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-4 space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground uppercase">{task.id}</span>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary uppercase">
            {task.columnId || 'todo'}
          </span>
        </div>
        <h3 className="text-sm font-semibold text-foreground">{task.title}</h3>
      </div>

      {task.description && (
        <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-foreground/90 whitespace-pre-wrap">
          {task.description}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border border-border/60 p-2 bg-card/40">
          <div className="text-[10px] uppercase text-muted-foreground font-semibold">Priority</div>
          <div className="font-mono text-xs text-foreground mt-0.5 capitalize">{task.priority || 'Medium'}</div>
        </div>
        <div className="rounded border border-border/60 p-2 bg-card/40">
          <div className="text-[10px] uppercase text-muted-foreground font-semibold">Assigned Agent</div>
          <div className="font-mono text-xs text-foreground mt-0.5">{task.assignedAgent || task.assignee || task.assignment?.agentId || 'Unassigned'}</div>
        </div>
      </div>
    </div>
  );
}

// ── Tab button ─────────────────────────────────────────────────────────

function TabButton({
  value,
  icon,
  label,
  count,
  running,
}: {
  value: InspectorTab;
  icon: ReactNode;
  label: string;
  count: number;
  running?: number;
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'flex h-6 items-center gap-1.5 rounded-md px-2.5 py-0 text-[11px] font-medium text-muted-foreground shadow-none transition-colors scroll-mt-12',
        'hover:bg-background/60 hover:text-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=active]:ring-border',
      )}
    >
      {icon}
      {label}
      {count > 0 && (
        <span
          className={cn(
            'tabular-nums text-[10px] px-1 rounded-full',
            running && running > 0
              ? 'bg-success/15 text-success'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {running !== undefined ? `${running}/${count}` : count}
        </span>
      )}
    </TabsTrigger>
  );
}

// ── Fleet tab content ──────────────────────────────────────────────────

function FleetTabContent({
  fleetList,
  leaderId,
  selectedAgentId,
  eventTimeline,
  onSelectAgent,
}: {
  fleetList: SubagentView[];
  leaderId: string | undefined;
  selectedAgentId: string | null;
  eventTimeline: FleetTimelineEvent[];
  onSelectAgent: (agent: SubagentView) => void;
}) {
  const { t } = useAppTranslation();
  // Fleet is bounded (active agents), show all without pagination.
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Agent list */}
      {fleetList.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <Users className="h-8 w-8 mb-2 opacity-20" />
          <p className="text-xs font-medium">{t('activity:inspector.noAgentsActive')}</p>
          <p className="text-[11px] mt-0.5">{t('activity:inspector.agentsAppearHint')}</p>
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {fleetList.map((agent) => (
            <FleetAgentRow
              key={agent.id}
              agent={agent}
              isSelected={selectedAgentId === agent.id}
              isLeader={agent.id === leaderId}
              onClick={() => onSelectAgent(agent)}
            />
          ))}
        </div>
      )}

      {/* Event timeline footer */}
      {eventTimeline.length > 0 && (
        <div className="border-t px-3 py-1.5 shrink-0">
          <EventTimeline events={eventTimeline} max={4} />
        </div>
      )}
    </div>
  );
}

// ── Agents tab content ─────────────────────────────────────────────────

function AgentsTabContent({
  fleetList,
  selectedAgent,
  leaderId,
  selectedAgentId,
  onSelectAgent,
}: {
  fleetList: SubagentView[];
  selectedAgent: SubagentView | null;
  leaderId: string | undefined;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const { t } = useAppTranslation();
  // Fleet is bounded (active agents), show all without pagination.
  if (fleetList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <Bot className="h-8 w-8 mb-2 opacity-20" />
        <p className="text-xs font-medium">{t('activity:inspector.noAgentsActive')}</p>
      </div>
    );
  }
  if (!selectedAgent) return null;

  const selectedIdx = Math.max(
    0,
    fleetList.findIndex((a) => a.id === selectedAgentId),
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Detail card */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <div className="max-w-2xl mx-auto">
          <AgentCard agent={selectedAgent} isLeader={selectedAgent.id === leaderId} />
        </div>
      </div>

      {/* Agent selector strip */}
      <div className="border-t px-2 py-1.5 shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
          {fleetList.map((agent, i) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelectAgent(agent.id)}
              className={cn(
                'shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] transition-colors',
                agent.id === selectedAgent?.id
                  ? 'bg-primary/15 text-primary ring-1 ring-primary/40'
                  : 'hover:bg-accent text-muted-foreground',
              )}
              title={
                i === selectedIdx
                  ? t('activity:inspector.selected', { name: agent.name })
                  : agent.name
              }
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  agent.status === 'running'
                    ? 'bg-success animate-pulse'
                    : agent.status === 'failed'
                      ? 'bg-destructive'
                      : 'bg-muted-foreground/50',
                )}
              />
              <span className="truncate max-w-[8rem]">{agent.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
