import type React from 'react';
import type { FleetEntry } from '../app-state.js';
import type {
  SidebarWrongProxy,
  SidebarWrongProxyStatus,
} from '../hooks/use-sidebar-panel-data.js';
import { Box, Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';
import { METRIC_MIN_BODY_WIDTH, PILL_MIN_INNER_WIDTH, type WorktreeRow } from '../ui-contracts.js';
import { glyphs } from '../ui-glyphs.js';
import type { ProjectPickerItem } from './project-picker.js';
import {
  SidebarCountsRow,
  SidebarMeter,
  SidebarPanelFrame,
  SidebarSectionHeader,
  SidebarStatRow,
  trunc,
} from './sidebar-panel-frame.js';
import {
  EmptyState,
  fleetStatusVisual,
  fmtShortDuration,
  SidebarWorklistRow,
} from './sidebar-panels-shared.js';
import { fmtRatioPct } from './status-bar-format.js';

export interface ProjectPickerSidebarProps {
  items: readonly ProjectPickerItem[];
  selected: number;
  filter: string;
  hint?: string | undefined;
  currentProject?: string | undefined;
  width: number;
}

export function ProjectPickerSidebar({
  items,
  selected,
  filter,
  hint,
  currentProject,
  width,
}: ProjectPickerSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  const projectCount = items.filter((item) => item.kind === 'project').length;
  const selectableCount = items.filter((item) => item.key !== '__divider__').length;
  const start = Math.max(0, Math.min(selected - 2, Math.max(0, items.length - 5)));
  const visible = items.slice(start, start + 5);
  return (
    <SidebarPanelFrame
      accent={theme.brand}
      icon={glyphs.folder}
      title="PROJECT"
      width={width}
      kicker={filter ? trunc(filter, 20) : 'switcher'}
      pillLabel={inner >= PILL_MIN_INNER_WIDTH ? `${projectCount} projects` : undefined}
      pillColor={projectCount > 0 ? theme.brand : theme.textMuted}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text color={theme.textMuted}>{projectCount} projects</Text>
        ) : undefined
      }
      footer="↑↓ select · Enter open"
    >
      <SidebarSectionHeader
        glyph={glyphs.folder}
        label="CURRENT"
        color={theme.brand}
        badge={`${selectableCount} choices`}
        innerWidth={bodyWidth}
        pill
      />
      {currentProject ? (
        <Text color={theme.textPrimary} bold wrap="truncate">
          {trunc(currentProject, bodyWidth - 2)}
        </Text>
      ) : (
        <Text color={theme.textMuted}>—</Text>
      )}
      <SidebarSectionHeader
        glyph={glyphs.folder}
        label="CHOICES"
        color={theme.textMuted}
        badge={start > 0 || start + visible.length < items.length ? '↑↓' : undefined}
        innerWidth={bodyWidth}
        pill
      />
      {visible.length === 0 ? (
        <EmptyState message="no matching projects" innerWidth={bodyWidth} />
      ) : (
        visible.map((item, offset) => {
          const index = start + offset;
          const isSelected = index === selected;
          if (item.key === '__divider__') {
            return (
              <Text key={`${item.key}-${index}`} color={theme.textMuted}>
                {'─'.repeat(bodyWidth)}
              </Text>
            );
          }
          const icon = item.kind === 'project' ? glyphs.folder : glyphs.task;
          const accent = item.kind === 'project' ? theme.brand : theme.warn;
          return (
            <Box key={item.key} flexDirection="column" width={bodyWidth}>
              <Box flexDirection="row" width={bodyWidth}>
                <Text color={isSelected ? accent : theme.textMuted}>
                  {isSelected ? glyphs.railMid : ' '}
                </Text>
                <Text color={accent}> {icon} </Text>
                <Text
                  color={isSelected ? theme.textPrimary : theme.textSecondary}
                  bold={isSelected}
                  wrap="truncate"
                >
                  {trunc(item.label, Math.max(4, bodyWidth - 6))}
                </Text>
              </Box>
              {item.subtitle ? (
                <Text color={theme.textMuted} wrap="truncate">
                  {' '}
                  {glyphs.treeLast} {trunc(item.subtitle, Math.max(4, bodyWidth - 4))}
                </Text>
              ) : null}
            </Box>
          );
        })
      )}
      {hint ? (
        <Text color={theme.warn} wrap="truncate">
          {glyphs.warning} {trunc(hint, bodyWidth - 2)}
        </Text>
      ) : null}
    </SidebarPanelFrame>
  );
}

export interface FleetPanelSidebarProps {
  entries: Record<string, FleetEntry>;
  /**
   * Pre-computed running count from the caller. Retained for interface
   * compatibility; the panel derives every displayed count (pill + chips)
   * from `entries` so leader and subagents can never diverge.
   */
  runningCount: number;
  /** Live tick (ms) — drives per-agent elapsed labels. Defaults to Date.now(). */
  nowTick?: number | undefined;
  width: number;
}

export function FleetPanelSidebar({
  entries,
  nowTick,
  width,
}: FleetPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  const nowRef = nowTick ?? Date.now();
  const all = Object.values(entries);
  const leader = all.find((e) => e.id === 'leader');
  const subagents = all.filter((e) => e !== leader);
  const runningSubs = subagents.filter((e) => e.status === 'running');
  // Distribution counts include the leader — it renders as a row, so it must
  // be counted, or the chips and the pill would disagree (Chimera review).
  const leaderRunning = leader?.status === 'running' ? 1 : 0;
  const liveCount = runningSubs.length + leaderRunning;
  const idleCount =
    subagents.filter((e) => e.status === 'idle').length + (leader?.status === 'idle' ? 1 : 0);
  const doneCount =
    subagents.filter((e) => e.status === 'success').length + (leader?.status === 'success' ? 1 : 0);
  const failedCount =
    subagents.filter(
      (e) => e.status === 'failed' || e.status === 'timeout' || e.status === 'stopped',
    ).length +
    (leader?.status === 'failed' || leader?.status === 'timeout' || leader?.status === 'stopped'
      ? 1
      : 0);
  const rows = [...(leader ? [leader] : []), ...runningSubs].slice(0, 8);
  return (
    <SidebarPanelFrame
      accent={theme.monitor.fleet}
      icon={glyphs.fleet}
      title="AGENT SWARM"
      width={width}
      kicker="fleet"
      pillLabel={
        inner >= PILL_MIN_INNER_WIDTH ? (liveCount > 0 ? `${liveCount} LIVE` : 'IDLE') : undefined
      }
      pillColor={liveCount > 0 ? theme.success : theme.textMuted}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text color={liveCount > 0 ? theme.success : theme.textMuted} bold>
            {liveCount > 0 ? `${liveCount} LIVE` : 'IDLE'}
          </Text>
        ) : undefined
      }
    >
      {/* State distribution — the same chips row the bottom F2 monitor opens
          with, so the twin reads as the same panel at a glance. */}
      <SidebarCountsRow
        counts={[
          { label: glyphs.running, count: liveCount, color: theme.success },
          { label: glyphs.idle, count: idleCount, color: theme.textMuted },
          { label: glyphs.success, count: doneCount, color: theme.success },
          { label: glyphs.failure, count: failedCount, color: theme.error },
        ]}
        innerWidth={bodyWidth}
        marginTop={rows.length > 0 ? 1 : 0}
      />
      {rows.length === 0 ? (
        <EmptyState message="no active agents" innerWidth={bodyWidth} />
      ) : (
        rows.map((e) => {
          const v = fleetStatusVisual(e.status);
          const isLeader = e === leader;
          const showElapsed = inner >= METRIC_MIN_BODY_WIDTH && e.startedAt > 0;
          const elapsedLabel = showElapsed
            ? fmtShortDuration(Math.max(0, nowRef - e.startedAt))
            : '';
          // Reserve the label + a 1-col gutter so a long duration can never
          // consume the separator between name and elapsed (Chimera review).
          const name = trunc(
            e.name || e.id,
            Math.max(4, bodyWidth - 2 - (elapsedLabel ? displayWidth(elapsedLabel) + 2 : 0)),
          );
          // Second line pairs the live tool with the context-window load,
          // colored by pressure — the same telemetry the bottom monitor
          // shows per agent, packed into the narrow rail.
          const tool = e.currentTool?.name ?? 'idle';
          const ctxPct = e.ctxPct ?? 0;
          const showCtx = inner >= METRIC_MIN_BODY_WIDTH;
          const ctxLabel = showCtx ? fmtRatioPct(ctxPct) : '';
          const ctxColor =
            ctxPct >= 0.8 ? theme.error : ctxPct >= 0.6 ? theme.warn : theme.textMuted;
          return (
            <Box key={e.id} flexDirection="column" width={bodyWidth}>
              <Box flexDirection="row" width={bodyWidth}>
                <Text color={v.color}>{v.glyph}</Text>
                <Text
                  color={e.status === 'running' ? theme.textPrimary : theme.textSecondary}
                  bold={isLeader}
                  wrap="truncate"
                >
                  {' '}
                  {name}
                </Text>
                {elapsedLabel ? (
                  <>
                    <Box flexGrow={1} />
                    <Text color={theme.textMuted}>{elapsedLabel}</Text>
                  </>
                ) : null}
              </Box>
              <Box flexDirection="row" width={bodyWidth}>
                <Text color={theme.textMuted} wrap="truncate">
                  {'  '}
                  {trunc(tool, Math.max(3, bodyWidth - 4 - displayWidth(ctxLabel)))}
                </Text>
                {ctxLabel ? (
                  <>
                    <Box flexGrow={1} />
                    <Text color={ctxColor}>{ctxLabel}</Text>
                  </>
                ) : null}
              </Box>
            </Box>
          );
        })
      )}
    </SidebarPanelFrame>
  );
}

export interface AgentsPanelSidebarProps {
  entries: Record<string, FleetEntry>;
  totalCost: number;
  nowTick: number;
  width: number;
}

export function AgentsPanelSidebar({
  entries,
  totalCost,
  nowTick,
  width,
}: AgentsPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  const all = Object.values(entries);
  const running = all.filter((e) => e.status === 'running');
  const done = all.filter((e) => e.status === 'success');
  const failed = all.filter((e) => e.status === 'failed' || e.status === 'timeout');
  const hotAgent = [...running].sort((a, b) => (b.ctxPct ?? 0) - (a.ctxPct ?? 0))[0];
  const live = running.slice(0, 10);
  return (
    <SidebarPanelFrame
      accent={theme.monitor.agents}
      icon={glyphs.peers}
      title="AGENTS"
      width={width}
      kicker="live ops"
      pillLabel={
        inner >= PILL_MIN_INNER_WIDTH
          ? `${running.length}${done.length > 0 ? ` ${glyphs.success}${done.length}` : ''}${
              failed.length > 0 ? ` !${failed.length}` : ''
            }`
          : undefined
      }
      pillColor={
        failed.length > 0 ? theme.error : running.length > 0 ? theme.success : theme.textMuted
      }
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text>
            <Text color={theme.warn}>{running.length}</Text>
            <Text color={theme.textMuted}> </Text>
            <Text color={theme.success}>{done.length}</Text>
            {failed.length > 0 ? (
              <>
                <Text color={theme.textMuted}> </Text>
                <Text color={theme.error}>{failed.length}</Text>
              </>
            ) : null}
          </Text>
        ) : undefined
      }
      footer={`F3 details ${glyphs.dividerDiamond} $${totalCost.toFixed(4)}`}
    >
      {hotAgent ? (
        <>
          <SidebarSectionHeader
            glyph={glyphs.warning}
            label="HOTTEST"
            color={theme.warn}
            innerWidth={bodyWidth}
          />
          <Text color={theme.textPrimary} wrap="truncate" bold>
            {trunc(hotAgent.name || hotAgent.id, bodyWidth - 2)}
          </Text>
          <Text color={theme.textMuted} wrap="truncate">
            {trunc(
              `ctx ${fmtRatioPct(hotAgent.ctxPct ?? 0)} ${glyphs.dividerDiamond} ${hotAgent.currentTool?.name ?? 'idle'}`,
              bodyWidth,
            )}
          </Text>
          {hotAgent.ctxPct !== undefined && hotAgent.ctxPct > 0 ? (
            <SidebarMeter
              ratio={hotAgent.ctxPct}
              innerWidth={bodyWidth}
              color={hotAgent.ctxPct >= 0.8 ? theme.error : theme.warn}
              marginTop={0}
            />
          ) : null}
        </>
      ) : (
        <EmptyState message="no live agents" innerWidth={bodyWidth} />
      )}
      <SidebarSectionHeader
        glyph={glyphs.fleet}
        label="RUNNING"
        color={theme.monitor.agents}
        badge={`${running.length}`}
        badgeColor={theme.success}
        innerWidth={bodyWidth}
        pill
      />
      {live.map((e) => {
        const v = fleetStatusVisual(e.status);
        const elapsed = nowTick - e.startedAt;
        const showElapsed = inner >= METRIC_MIN_BODY_WIDTH;
        const elapsedLabel = showElapsed ? fmtShortDuration(elapsed) : '';
        const name = trunc(
          e.name || e.id,
          Math.max(4, bodyWidth - 2 - (showElapsed ? displayWidth(elapsedLabel) + 1 : 0)),
        );
        // Second line pairs the live tool with the context-window load,
        // colored by pressure — mirrors the F3 bottom monitor's per-agent
        // telemetry rows on the narrow rail.
        const tool = e.currentTool?.name ?? 'idle';
        const ctxPct = e.ctxPct ?? 0;
        const ctxLabel = showElapsed ? fmtRatioPct(ctxPct) : '';
        const ctxColor = ctxPct >= 0.8 ? theme.error : ctxPct >= 0.6 ? theme.warn : theme.textMuted;
        return (
          <Box key={e.id} flexDirection="column" width={bodyWidth}>
            <Box flexDirection="row" width={bodyWidth}>
              <Text color={v.color}>{v.glyph}</Text>
              <Text color={theme.textPrimary}> </Text>
              <Text wrap="truncate">{name}</Text>
              {showElapsed ? (
                <>
                  <Box flexGrow={1} />
                  <Text color={theme.textMuted}>{elapsedLabel}</Text>
                </>
              ) : null}
            </Box>
            <Box flexDirection="row" width={bodyWidth}>
              <Text color={theme.textMuted} wrap="truncate">
                {'  '}
                {trunc(tool, Math.max(3, bodyWidth - 4 - displayWidth(ctxLabel)))}
              </Text>
              {ctxLabel ? (
                <>
                  <Box flexGrow={1} />
                  <Text color={ctxColor}>{ctxLabel}</Text>
                </>
              ) : null}
            </Box>
          </Box>
        );
      })}
    </SidebarPanelFrame>
  );
}

export interface WorktreePanelSidebarProps {
  worktrees: Record<string, WorktreeRow>;
  /** Live tick (ms) — drives per-worktree age labels. Defaults to Date.now(). */
  nowTick?: number | undefined;
  width: number;
}

function worktreeStatusVisual(status: string): { glyph: string; color: string } {
  switch (status) {
    case 'active':
      return { glyph: '•', color: theme.warn };
    case 'committing':
      return { glyph: '◐', color: theme.accent };
    case 'merging':
      return { glyph: '⇡', color: theme.brand };
    case 'merged':
      return { glyph: glyphs.success, color: theme.success };
    case 'needs-review':
      return { glyph: glyphs.warning, color: theme.brand };
    case 'failed':
      return { glyph: glyphs.failure, color: theme.error };
    default:
      return { glyph: '○', color: theme.textMuted };
  }
}

export function WorktreePanelSidebar({
  worktrees,
  nowTick,
  width,
}: WorktreePanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  const nowRef = nowTick ?? Date.now();
  const list = Object.values(worktrees);
  const active = list.filter(
    (w) => w.status === 'active' || w.status === 'committing' || w.status === 'merging',
  ).length;
  const merged = list.filter((w) => w.status === 'merged').length;
  const failed = list.filter((w) => w.status === 'failed' || w.status === 'needs-review').length;
  return (
    <SidebarPanelFrame
      accent={theme.monitor.worktree}
      icon={glyphs.gitBranch}
      title="WORKTREES"
      width={width}
      kicker="isolation"
      pillLabel={
        inner >= PILL_MIN_INNER_WIDTH
          ? `${active} act ${glyphs.success}${merged}${failed > 0 ? ` !${failed}` : ''}`
          : undefined
      }
      pillColor={failed > 0 ? theme.error : active > 0 ? theme.warn : theme.textMuted}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text>
            <Text color={theme.warn}>A{active}</Text>
            <Text color={theme.textMuted}> </Text>
            <Text color={theme.success}>D{merged}</Text>
            {failed > 0 ? (
              <>
                <Text color={theme.textMuted}> </Text>
                <Text color={theme.error}>!{failed}</Text>
              </>
            ) : null}
          </Text>
        ) : undefined
      }
      footer="F4 details"
    >
      <SidebarCountsRow
        counts={[
          { label: glyphs.running, count: active, color: theme.warn },
          { label: glyphs.success, count: merged, color: theme.success },
          { label: glyphs.failure, count: failed, color: theme.error },
        ]}
        innerWidth={bodyWidth}
        marginTop={list.length > 0 ? 1 : 0}
      />
      {list.length === 0 ? (
        <EmptyState message="no worktrees" innerWidth={bodyWidth} />
      ) : (
        list.slice(0, 8).map((w) => {
          const v = worktreeStatusVisual(w.status);
          const diff = `+${w.insertions}/-${w.deletions}`;
          const showDiff = inner >= METRIC_MIN_BODY_WIDTH;
          const rowChrome = displayWidth(v.glyph) + 1;
          const diffWidth = showDiff ? displayWidth(diff) + 1 : 0;
          const branch = trunc(
            w.branch.replace(/^wstack\/ap\//, ''),
            Math.max(4, bodyWidth - rowChrome - diffWidth),
          );
          // Second line carries the worktree's isolation metadata — owner
          // label, touched-file count, and age — the same trio the F4
          // bottom monitor lists per worktree.
          const showMeta = inner >= METRIC_MIN_BODY_WIDTH;
          const metaParts = [
            w.ownerLabel || '',
            showMeta ? `${w.files}f` : '',
            showMeta && w.allocatedAt > 0
              ? fmtShortDuration(Math.max(0, nowRef - w.allocatedAt))
              : '',
          ].filter(Boolean);
          return (
            <Box key={w.branch} flexDirection="column" width={bodyWidth}>
              <Box flexDirection="row" width={bodyWidth}>
                <Text color={v.color}>{v.glyph}</Text>
                <Text color={theme.textPrimary}> </Text>
                <Text wrap="truncate">{branch}</Text>
                {showDiff ? (
                  <>
                    <Box flexGrow={1} />
                    <Text color={theme.textMuted}>{diff}</Text>
                  </>
                ) : null}
              </Box>
              {metaParts.length > 0 ? (
                <Text color={theme.textMuted} wrap="truncate">
                  {'  '}
                  {glyphs.treeLast} {trunc(metaParts.join(' · '), Math.max(3, bodyWidth - 4))}
                </Text>
              ) : null}
            </Box>
          );
        })
      )}
    </SidebarPanelFrame>
  );
}

export interface CoordinatorPanelSidebarProps {
  running: boolean;
  activePhases: number;
  completedPhases: number;
  phaseNames: readonly string[];
  elapsedMs: number;
  width: number;
}

export function CoordinatorPanelSidebar({
  running,
  activePhases,
  completedPhases,
  phaseNames,
  elapsedMs,
  width,
}: CoordinatorPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  return (
    <SidebarPanelFrame
      accent={theme.brand}
      icon={glyphs.auto}
      title="COORDINATOR"
      width={width}
      kicker="phases"
      pillLabel={
        inner >= PILL_MIN_INNER_WIDTH ? (running ? `${activePhases} active` : 'idle') : undefined
      }
      pillColor={running ? theme.warn : theme.textMuted}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text color={running ? theme.warn : theme.textMuted} bold>
            {running ? `${activePhases} active` : 'idle'}
          </Text>
        ) : undefined
      }
      footer={`F11 details ${glyphs.dividerDiamond} ${fmtShortDuration(elapsedMs)}`}
    >
      <SidebarSectionHeader
        glyph={glyphs.plan}
        label="PHASES"
        color={theme.brand}
        badge={`${completedPhases}/${phaseNames.length || completedPhases}`}
        innerWidth={bodyWidth}
        pill
      />
      {phaseNames.length > 0 ? (
        <SidebarMeter
          ratio={completedPhases / Math.max(1, phaseNames.length)}
          innerWidth={bodyWidth}
          color={completedPhases >= phaseNames.length ? theme.success : theme.brand}
        />
      ) : null}
      {phaseNames.length === 0 ? (
        <EmptyState message="no active phases" innerWidth={bodyWidth} />
      ) : (
        phaseNames.slice(0, 10).map((name, i) => {
          const isDone = i < completedPhases;
          const isActive = i === completedPhases && running;
          const icon = isDone ? glyphs.success : isActive ? glyphs.running : glyphs.pending;
          const color = isDone ? theme.success : isActive ? theme.warn : theme.textMuted;
          return (
            <SidebarWorklistRow
              key={name}
              icon={icon}
              iconColor={color}
              label={name}
              labelColor={isDone ? theme.textMuted : theme.textPrimary}
              innerWidth={bodyWidth}
              dim={isDone}
              strikethrough={isDone}
            />
          );
        })
      )}
    </SidebarPanelFrame>
  );
}

export interface ConnectionsPanelSidebarProps {
  connections: readonly {
    name: string;
    status: 'ok' | 'warn' | 'down' | 'unknown';
    latencyMs?: number | undefined;
  }[];
  width: number;
}

/**
 * Status pill + glyph mapping for the WrongProxy sidebar twin. Kept
 * local to this file (instead of as a module-level constant) because
 * it is only meaningful in this sidebar card and duplicates the
 * envelope of `ConnectionsPanelSidebar` only loosely.
 */
function wrongProxyVisual(status: SidebarWrongProxyStatus): {
  glyph: string;
  color: string;
  pill: string;
} {
  switch (status) {
    case 'ok':
      return { glyph: glyphs.success, color: theme.success, pill: 'LIVE' };
    case 'warn':
      return { glyph: glyphs.warning, color: theme.warn, pill: 'WARN' };
    case 'down':
      return { glyph: glyphs.failure, color: theme.error, pill: 'DOWN' };
    default:
      return { glyph: '?', color: theme.textMuted, pill: '?' };
  }
}

export function ConnectionsPanelSidebar({
  connections,
  width,
}: ConnectionsPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  const okCount = connections.filter((c) => c.status === 'ok').length;
  const warnCount = connections.filter((c) => c.status === 'warn').length;
  const downCount = connections.filter((c) => c.status === 'down').length;
  return (
    <SidebarPanelFrame
      accent={theme.brand}
      icon={glyphs.tools}
      title="CONNECTIONS"
      width={width}
      kicker="signal matrix"
      pillLabel={
        inner >= PILL_MIN_INNER_WIDTH
          ? downCount > 0
            ? `${downCount} DOWN`
            : warnCount > 0
              ? `${warnCount} WARN`
              : `${okCount} OK`
          : undefined
      }
      pillColor={downCount > 0 ? theme.error : warnCount > 0 ? theme.warn : theme.success}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text
            color={downCount > 0 ? theme.error : warnCount > 0 ? theme.warn : theme.success}
            bold
          >
            {downCount > 0
              ? `${downCount} DOWN`
              : warnCount > 0
                ? `${warnCount} WARN`
                : `${okCount} OK`}
          </Text>
        ) : undefined
      }
    >
      <SidebarSectionHeader
        glyph={glyphs.tools}
        label="SIGNAL MATRIX"
        color={theme.brand}
        badge={`${okCount}/${connections.length || 1}`}
        innerWidth={bodyWidth}
        pill
      />
      <SidebarCountsRow
        counts={[
          { label: glyphs.success, count: okCount, color: theme.success },
          { label: glyphs.warning, count: warnCount, color: theme.warn },
          { label: glyphs.failure, count: downCount, color: theme.error },
        ]}
        innerWidth={bodyWidth}
        marginTop={1}
      />
      <SidebarMeter
        ratio={okCount / Math.max(1, connections.length || 1)}
        innerWidth={bodyWidth}
        color={theme.success}
      />
      {connections.length === 0 ? (
        <EmptyState message="scanning for links…" innerWidth={bodyWidth} variant="scanning" />
      ) : (
        connections.slice(0, 10).map((c, i) => {
          const icon =
            c.status === 'ok'
              ? glyphs.success
              : c.status === 'warn'
                ? glyphs.warning
                : c.status === 'down'
                  ? glyphs.failure
                  : '?';
          const color =
            c.status === 'ok'
              ? theme.success
              : c.status === 'warn'
                ? theme.warn
                : c.status === 'down'
                  ? theme.error
                  : theme.textMuted;
          const showLatency = inner >= METRIC_MIN_BODY_WIDTH;
          const lat = showLatency && c.latencyMs != null ? `${c.latencyMs}ms` : '';
          const lane = c.status === 'ok' ? '━━' : c.status === 'warn' ? '┅┅' : '··';
          const rowChrome = displayWidth(icon) + displayWidth(lane);
          return (
            <Box key={`${c.name}-${i}`} flexDirection="row" width={bodyWidth}>
              <Text color={color}>
                {icon}
                {lane}
              </Text>
              <Text color={theme.textPrimary} bold={c.status === 'ok'} wrap="truncate">
                {trunc(
                  c.name,
                  Math.max(3, bodyWidth - rowChrome - (lat ? displayWidth(lat) + 1 : 0)),
                )}
              </Text>
              {lat ? (
                <>
                  <Box flexGrow={1} />
                  <Text color={color}>{lat}</Text>
                </>
              ) : null}
            </Box>
          );
        })
      )}
    </SidebarPanelFrame>
  );
}

export interface WrongProxyPanelSidebarProps {
  /**
   * Live probe state. When `null` (URL missing or probe disabled) the
   * panel renders an idle placeholder inside the same frame so the
   * layout never jumps when the toggle flips on mid-session.
   */
  proxy: SidebarWrongProxy | null;
  width: number;
}

/**
 * Sidebar twin for the live WrongProxy / WrongTrace daemon. Renders the
 * proxy URL with its round-trip latency, the probe error detail when
 * warn/down, and — when the daemon's `/api/health` body exposes them —
 * the WrongTrace IPC socket path and daemon version.
 *
 * The panel is mounted only when `wrongProxyEnabled` is true at the
 * `app-view-sidebar.tsx` gate — see the `wrongProxyEnabled` usage there.
 * This component still defensively renders an empty-state when
 * `proxy === null` so a mount/unmount race during a toggle flip does
 * not flash an inconsistent card.
 */
export function WrongProxyPanelSidebar({
  proxy,
  width,
}: WrongProxyPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Mirror the body-width math used by every other sidebar twin on
  // this page: `Card` adds 2 cols for `│` sides and 2 cols for body
  // padding on rails wide enough to afford the chrome (>= 18), and
  // SectionHeader / StatRow dotted leaders size to that inset width.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  const visual = proxy ? wrongProxyVisual(proxy.status) : wrongProxyVisual('unknown');
  const showLatency = inner >= METRIC_MIN_BODY_WIDTH;
  const latencyLabel = proxy?.latencyMs !== undefined ? `${proxy.latencyMs}ms` : '';
  const urlLabel = proxy?.url ?? '—';
  // Pre-truncate the IPC socket path so the StatRow dot-leader math
  // stays exact on narrow rails — `SidebarStatRow` assumes the caller
  // passes a value that fits (it only clamps the leader, not the value).
  // "· ipc " label + 3 (min leader + gap) reserve on the left.
  const ipcLabel = `${glyphs.dividerDot} ipc`;
  const ipcValue = proxy?.socketPath
    ? trunc(proxy.socketPath, Math.max(4, bodyWidth - displayWidth(ipcLabel) - 3))
    : null;
  const daemonLabel = `${glyphs.dividerDot} daemon`;
  const daemonValue = proxy?.version
    ? trunc(proxy.version, Math.max(4, bodyWidth - displayWidth(daemonLabel) - 3))
    : null;
  return (
    <SidebarPanelFrame
      accent={visual.color}
      icon={glyphs.link}
      title="WRONGPROXY"
      width={width}
      kicker="proxy daemon"
      pillLabel={inner >= PILL_MIN_INNER_WIDTH ? `${visual.glyph} ${visual.pill}` : undefined}
      pillColor={visual.color}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text color={visual.color} bold>
            {visual.glyph} {visual.pill}
          </Text>
        ) : undefined
      }
    >
      <Box flexDirection="row" width={bodyWidth}>
        <Text color={visual.color}>{visual.glyph}</Text>
        <Text color={theme.textPrimary} bold wrap="truncate">
          {' '}
          {trunc(
            urlLabel,
            Math.max(
              3,
              bodyWidth - (showLatency && latencyLabel ? displayWidth(latencyLabel) + 1 : 2),
            ),
          )}
        </Text>
        {showLatency && latencyLabel ? (
          <>
            <Box flexGrow={1} />
            <Text color={theme.textMuted}>{latencyLabel}</Text>
          </>
        ) : null}
      </Box>
      {proxy?.detail ? (
        <Text color={proxy.status === 'down' ? theme.error : theme.warn} wrap="truncate">
          {glyphs.warning} {trunc(proxy.detail, bodyWidth - 2)}
        </Text>
      ) : null}
      {/* WrongTrace IPC info — rendered only when the daemon reported a
          socket path / version, so an HTTP-only daemon keeps the card at
          its minimal height. */}
      {ipcValue ? (
        <SidebarStatRow
          label={ipcLabel}
          value={ipcValue}
          color={theme.textMuted}
          innerWidth={bodyWidth}
          valueMuted
        />
      ) : null}
      {daemonValue ? (
        <SidebarStatRow
          label={daemonLabel}
          value={daemonValue}
          color={theme.textPrimary}
          innerWidth={bodyWidth}
        />
      ) : null}
    </SidebarPanelFrame>
  );
}
