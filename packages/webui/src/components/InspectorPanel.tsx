/**
 * InspectorPanel — a DevTools-style bottom dock that slides up/down.
 *
 * Replaces the old fixed BottomDock (which floated over and blocked the chat
 * input) and the two modal FleetDrawer/AgentsDrawer overlays. The panel
 * participates in normal flex layout: when collapsed only a slim handle bar is
 * visible; when expanded it takes a fixed slice of the main column and the
 * chat transcript above shrinks to fit. No backdrop, no modal — the chat
 * input stays fully usable while the panel is open.
 *
 * Tabs: Fleet (agent list + stats) | Agents (per-agent detail card).
 */

import { Bot, ChevronDown, ChevronUp, Users, Activity } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { AgentCard } from './AgentsMonitor';
import { ConcurrencyGauge, EventTimeline } from '@/components/ui';
import { FleetAgentRow } from './FleetMonitor';
import { SideEffectTimeline } from './SideEffectTimeline';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { useFleetStore, useSideEffectStore, useUIStore } from '@/stores';
import type { FleetTimelineEvent, SubagentView } from '@/stores';

/** Expanded panel height (px). Tall enough for a useful agent list without
 *  eating the whole chat surface. The outer container animates between this
 *  and 0 for the slide effect. */
const PANEL_HEIGHT = 320;

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
function sortFleet(agents: Map<string, SubagentView>, leaderId: string | undefined): SubagentView[] {
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

export function InspectorPanel() {
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const inspectorTab = useUIStore((s) => s.inspectorTab);
  const toggleInspector = useUIStore((s) => s.toggleInspector);
  const setInspectorOpen = useUIStore((s) => s.setInspectorOpen);
  const setInspectorTab = useUIStore((s) => s.setInspectorTab);
  const { t } = useAppTranslation();

  // Fleet-wide signals (subscribed narrowly so tab switches / typing in the
  // chat don't re-render this component).
  const fleetAgents = useFleetStore((s) => s.agents);
  const leaderId = useFleetStore((s) => s.leaderId);
  const fleetTokensIn = useFleetStore((s) => s.fleetTokensIn);
  const fleetTokensOut = useFleetStore((s) => s.fleetTokensOut);
  const fleetConcurrency = useFleetStore((s) => s.fleetConcurrency);
  const fleetConcurrencyMax = useFleetStore((s) => s.fleetConcurrencyMax);
  const eventTimeline = useFleetStore((s) => s.eventTimeline);

  const fleetList = useMemo(
    () => sortFleet(fleetAgents, leaderId),
    [fleetAgents, leaderId],
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

  const openFleetTab = () => setInspectorTab('fleet');
  const openAgentsTab = () => setInspectorTab('agents');
  const openSideEffectsTab = () => setInspectorTab('sideEffects');

  const sideEffectCount = useSideEffectStore((s) => s.sideEffects.length);

  // Clicking a row in the fleet list jumps to that agent's detail card.
  const handleSelectAgent = (agent: SubagentView) => {
    setSelectedAgentId(agent.id);
    openAgentsTab();
  };

  return (
    <div className="shrink-0 border-t bg-card flex flex-col">
      {/* ── Toggle handle — always visible, sits at the bottom edge ── */}
      <button
        type="button"
        onClick={toggleInspector}
        className={cn(
          'group w-full flex items-center justify-between gap-2 px-3 h-7 text-[11px]',
          'text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors',
        )}
        title={inspectorOpen ? t('activity:inspector.hidePanel') : t('activity:inspector.showPanel')}
      >
        <span className="flex items-center gap-2 min-w-0">
          {inspectorOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="font-medium uppercase tracking-wider">{t('activity:inspector.label')}</span>
          {/* Live summary — running count + tokens, even while collapsed */}
          {fleetTotal > 0 && (
            <>
              <span className="opacity-40">·</span>
              <span className="flex items-center gap-1">
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
              <span className="opacity-40 hidden sm:inline">·</span>
              <span className="tabular-nums font-mono hidden sm:inline">
                ↓{fmtTok(fleetTokensIn)} ↑{fmtTok(fleetTokensOut)} · {fmtCost(totalCost)}
              </span>
            </>
          )}
          {/* Side-effect count — clickable to jump to Audit tab */}
          {sideEffectCount > 0 && (
            <>
              <span className="opacity-40">·</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setInspectorOpen(true);
                  setInspectorTab('sideEffects');
                }}
                className="flex items-center gap-1 text-warning hover:text-warning/85 transition-colors"
                title={t('activity:inspector.openAudit')}
              >
                <Activity className="h-3 w-3" />
                <span className="tabular-nums">{sideEffectCount}</span>
              </button>
            </>
          )}
        </span>
        <span className="flex items-center gap-1 shrink-0 opacity-70 group-hover:opacity-100">
          <Bot className="h-3 w-3" />
          <Users className="h-3 w-3" />
          <Activity className="h-3 w-3" />
        </span>
      </button>

      {/* ── Slide-up panel — height animates between 0 and PANEL_HEIGHT ──
          The inner wrapper keeps a fixed height so its content never
          squishes during the transition; only the outer clip animates. */}
      <div
        className="overflow-hidden transition-[height] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ height: inspectorOpen ? PANEL_HEIGHT : 0 }}
      >
        <div className="flex flex-col" style={{ height: PANEL_HEIGHT }}>
          {/* Tab bar */}
          <div className="flex items-center gap-1 px-2 h-8 border-b bg-muted/30 shrink-0">
            <TabButton
              active={inspectorTab === 'fleet'}
              onClick={openFleetTab}
              icon={<Bot className="h-3.5 w-3.5" />}
              label={t('activity:inspector.tabFleet')}
              count={fleetTotal}
              running={runningCount}
            />
            <TabButton
              active={inspectorTab === 'agents'}
              onClick={openAgentsTab}
              icon={<Users className="h-3.5 w-3.5" />}
              label={t('activity:inspector.tabAgents')}
              count={fleetTotal}
            />
            <TabButton
              active={inspectorTab === 'sideEffects'}
              onClick={openSideEffectsTab}
              icon={<Activity className="h-3.5 w-3.5" />}
              label={t('activity:inspector.tabAudit')}
              count={sideEffectCount}
            />
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setInspectorOpen(false)}
              className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              aria-label={t('activity:inspector.collapseAria')}
              title={t('activity:inspector.collapseTitle')}
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {inspectorTab === 'fleet' ? (
              <FleetTabContent
                fleetList={fleetList}
                leaderId={leaderId}
                selectedAgentId={selectedAgentId}
                runningCount={runningCount}
                fleetConcurrency={fleetConcurrency}
                fleetConcurrencyMax={fleetConcurrencyMax}
                fleetTokensIn={fleetTokensIn}
                fleetTokensOut={fleetTokensOut}
                totalCost={totalCost}
                eventTimeline={eventTimeline}
                onSelectAgent={handleSelectAgent}
              />
            ) : inspectorTab === 'agents' ? (
              <AgentsTabContent
                fleetList={fleetList}
                selectedAgent={selectedAgent}
                leaderId={leaderId}
                selectedAgentId={selectedAgent?.id ?? null}
                onSelectAgent={setSelectedAgentId}
              />
            ) : (
              <SideEffectTimeline />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tab button ─────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
  running,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count: number;
  running?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2.5 h-6 rounded-md text-[11px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
          : 'text-muted-foreground hover:text-foreground hover:bg-background/60',
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
    </button>
  );
}

// ── Fleet tab content ──────────────────────────────────────────────────

function FleetTabContent({
  fleetList,
  leaderId,
  selectedAgentId,
  runningCount,
  fleetConcurrency,
  fleetConcurrencyMax,
  fleetTokensIn,
  fleetTokensOut,
  totalCost,
  eventTimeline,
  onSelectAgent,
}: {
  fleetList: SubagentView[];
  leaderId: string | undefined;
  selectedAgentId: string | null;
  runningCount: number;
  fleetConcurrency: number;
  fleetConcurrencyMax: number;
  fleetTokensIn: number;
  fleetTokensOut: number;
  totalCost: number;
  eventTimeline: FleetTimelineEvent[];
  onSelectAgent: (agent: SubagentView) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Summary strip */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b text-[11px] text-muted-foreground shrink-0">
        <span className="flex items-center gap-1">
          {runningCount > 0 && (
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
          )}
          <span className="tabular-nums">
            {t('activity:agents.runningCount', { count: runningCount })} · {t('activity:agents.totalCount', { count: fleetList.length })}
          </span>
        </span>
        <ConcurrencyGauge current={fleetConcurrency} max={fleetConcurrencyMax} showLabel />
        <div className="flex-1" />
        <span className="tabular-nums font-mono">
          ↓{fmtTok(fleetTokensIn)} ↑{fmtTok(fleetTokensOut)} · {fmtCost(totalCost)}
        </span>
      </div>

      {/* Agent list */}
      {fleetList.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <Users className="h-8 w-8 mb-2 opacity-20" />
          <p className="text-xs font-medium">{t('activity:inspector.noAgentsActive')}</p>
          <p className="text-[11px] mt-0.5">{t('activity:inspector.agentsAppearHint')}</p>
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-1.5">
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
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
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
              title={i === selectedIdx ? t('activity:inspector.selected', { name: agent.name }) : agent.name}
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
