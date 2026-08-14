import type React from 'react';
import type { FleetEntry } from '../app-state.js';
import { Box, Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';
import type { WorktreeRow } from '../ui-contracts.js';
import { glyphs } from '../ui-glyphs.js';
import type { ProjectPickerItem } from './project-picker.js';
import {
  SidebarPanelCard,
  SidebarPanelFrame,
  SidebarSectionHeader,
  trunc,
} from './sidebar-panel-frame.js';
import { fleetStatusVisual, fmtShortDuration } from './sidebar-panels-shared.js';

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
      right={<Text color={theme.textMuted}>{projectCount} projects</Text>}
    >
      <SidebarPanelCard innerWidth={inner}>
        <SidebarSectionHeader
          glyph={glyphs.folder}
          label="CURRENT"
          color={theme.brand}
          badge={`${selectableCount} choices`}
          innerWidth={inner}
        />
        {currentProject ? (
          <Text color={theme.textPrimary} bold wrap="truncate">
            {trunc(currentProject, inner - 2)}
          </Text>
        ) : (
          <Text color={theme.textMuted}>—</Text>
        )}
      </SidebarPanelCard>
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        <SidebarSectionHeader
          glyph={glyphs.folder}
          label="CHOICES"
          color={theme.textMuted}
          badge={start > 0 || start + visible.length < items.length ? '↑↓' : undefined}
          innerWidth={inner}
        />
        {visible.length === 0 ? (
          <Text color={theme.textMuted}>no matching projects</Text>
        ) : (
          visible.map((item, offset) => {
            const index = start + offset;
            const isSelected = index === selected;
            if (item.key === '__divider__') {
              return (
                <Text key={`${item.key}-${index}`} color={theme.textMuted}>
                  {'─'.repeat(inner)}
                </Text>
              );
            }
            const icon = item.kind === 'project' ? glyphs.folder : glyphs.task;
            const accent = item.kind === 'project' ? theme.brand : theme.warn;
            return (
              <Box key={item.key} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={isSelected ? accent : theme.textMuted}>
                    {isSelected ? '▎' : ' '}
                  </Text>
                  <Text color={accent}> {icon} </Text>
                  <Text
                    color={isSelected ? theme.textPrimary : theme.textSecondary}
                    bold={isSelected}
                    wrap="truncate"
                  >
                    {trunc(item.label, Math.max(4, inner - 6))}
                  </Text>
                </Box>
                {item.subtitle ? (
                  <Text color={theme.textMuted}>
                    {' '}
                    └ {trunc(item.subtitle, Math.max(4, inner - 4))}
                  </Text>
                ) : null}
              </Box>
            );
          })
        )}
        {hint ? (
          <Text color={theme.warn}>
            {glyphs.warning} {trunc(hint, inner - 2)}
          </Text>
        ) : null}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

export interface FleetPanelSidebarProps {
  entries: Record<string, FleetEntry>;
  runningCount: number;
  width: number;
}

export function FleetPanelSidebar({
  entries,
  runningCount,
  width,
}: FleetPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  const all = Object.values(entries);
  const leader = all.find((e) => e.id === 'leader');
  const subagents = all.filter((e) => e !== leader && e.status === 'running');
  const rows = [...(leader ? [leader] : []), ...subagents].slice(0, 10);
  return (
    <SidebarPanelFrame
      accent={theme.monitor.fleet}
      icon={glyphs.fleet}
      title="AGENT SWARM"
      width={width}
      kicker="fleet"
      right={
        <Text color={runningCount > 0 ? theme.success : theme.textMuted} bold>
          {runningCount > 0 ? `${runningCount} LIVE` : 'IDLE'}
        </Text>
      }
    >
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        {rows.length === 0 ? (
          <Text color={theme.textMuted}>no active agents</Text>
        ) : (
          rows.map((e) => {
            const v = fleetStatusVisual(e.status);
            const name = trunc(e.name || e.id, inner - 8);
            return (
              <Box key={e.id} flexDirection="row">
                <Text color={v.color}>{v.glyph}</Text>
                <Text color={e.status === 'running' ? theme.textPrimary : theme.textSecondary}>
                  {' '}
                  {name}
                </Text>
              </Box>
            );
          })
        )}
      </SidebarPanelCard>
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
      right={
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
      }
      footer={`F3 details · $${totalCost.toFixed(4)}`}
    >
      <SidebarPanelCard innerWidth={inner} marginBottom={1}>
        {hotAgent ? (
          <>
            <SidebarSectionHeader
              glyph={glyphs.warning}
              label="HOTTEST"
              color={theme.warn}
              innerWidth={inner}
            />
            <Text color={theme.textPrimary} wrap="truncate" bold>
              {trunc(hotAgent.name || hotAgent.id, inner - 4)}
            </Text>
            <Text color={theme.textMuted} wrap="truncate">
              {trunc(
                `ctx ${Math.round((hotAgent.ctxPct ?? 0) * 100)}% · ${hotAgent.currentTool?.name ?? 'idle'}`,
                inner,
              )}
            </Text>
          </>
        ) : (
          <Text color={theme.textMuted}>no live agents</Text>
        )}
      </SidebarPanelCard>
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        <SidebarSectionHeader
          glyph={glyphs.fleet}
          label="RUNNING"
          color={theme.monitor.agents}
          badge={`${running.length}`}
          badgeColor={theme.success}
          innerWidth={inner}
        />
        {live.map((e) => {
          const v = fleetStatusVisual(e.status);
          const elapsed = nowTick - e.startedAt;
          const showElapsed = inner >= 24;
          const elapsedLabel = showElapsed ? fmtShortDuration(elapsed) : '';
          const name = trunc(
            e.name || e.id,
            Math.max(4, inner - 2 - (showElapsed ? displayWidth(elapsedLabel) + 1 : 0)),
          );
          return (
            <Box key={e.id} flexDirection="row">
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
          );
        })}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

export interface WorktreePanelSidebarProps {
  worktrees: Record<string, WorktreeRow>;
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
  width,
}: WorktreePanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
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
      right={
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
      }
      footer="F4 details"
    >
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        {list.length === 0 ? (
          <Text color={theme.textMuted}>no worktrees</Text>
        ) : (
          list.slice(0, 10).map((w) => {
            const v = worktreeStatusVisual(w.status);
            const diff = `+${w.insertions}/-${w.deletions}`;
            const showDiff = inner >= 24;
            const rowChrome = displayWidth(v.glyph) + 1;
            const diffWidth = showDiff ? displayWidth(diff) + 1 : 0;
            const branch = trunc(
              w.branch.replace(/^wstack\/ap\//, ''),
              Math.max(4, inner - rowChrome - diffWidth),
            );
            return (
              <Box key={w.branch} flexDirection="row">
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
            );
          })
        )}
      </SidebarPanelCard>
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
  return (
    <SidebarPanelFrame
      accent={theme.brand}
      icon={glyphs.auto}
      title="COORDINATOR"
      width={width}
      kicker="autonomous"
      right={
        <Text color={running ? theme.success : theme.textMuted} bold>
          {running ? '● RUNNING' : '○ IDLE'}
        </Text>
      }
      footer="F11 details"
    >
      <SidebarPanelCard innerWidth={inner}>
        <SidebarSectionHeader
          glyph={glyphs.running}
          label="PHASES"
          color={theme.brand}
          badge={`${activePhases}/${activePhases + completedPhases}`}
          innerWidth={inner}
        />
        {phaseNames.length === 0 ? (
          <Text color={theme.textMuted}>no active phases</Text>
        ) : (
          phaseNames.slice(0, 5).map((name, i) => (
            <Box key={i} flexDirection="row">
              <Text color={theme.accent}>●</Text>
              <Text color={theme.textPrimary} wrap="truncate">
                {' '}
                {trunc(name, inner - 4)}
              </Text>
            </Box>
          ))
        )}
      </SidebarPanelCard>
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        <Text color={theme.textMuted}>elapsed {fmtShortDuration(elapsedMs)}</Text>
      </SidebarPanelCard>
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

export function ConnectionsPanelSidebar({
  connections,
  width,
}: ConnectionsPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  const okCount = connections.filter((c) => c.status === 'ok').length;
  const warnCount = connections.filter((c) => c.status === 'warn').length;
  const downCount = connections.filter((c) => c.status === 'down').length;
  return (
    <SidebarPanelFrame
      accent={theme.accent}
      icon={glyphs.tools}
      title="CONNECTIONS"
      width={width}
      kicker="service health"
      right={
        <Text>
          <Text color={theme.success}>
            {glyphs.success}
            {okCount}
          </Text>
          {warnCount > 0 ? (
            <>
              <Text color={theme.textMuted}> </Text>
              <Text color={theme.warn}>
                {glyphs.warning}
                {warnCount}
              </Text>
            </>
          ) : null}
          {downCount > 0 ? (
            <>
              <Text color={theme.textMuted}> </Text>
              <Text color={theme.error}>
                {glyphs.failure}
                {downCount}
              </Text>
            </>
          ) : null}
        </Text>
      }
      footer="Ctrl+N details"
    >
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        <Box width={inner} overflowX="hidden">
          <Text color={theme.accent} bold wrap="truncate">
            ╭
          </Text>
          <Text color={okCount > 0 ? theme.success : theme.textMuted} wrap="truncate">
            {'━'.repeat(Math.max(1, Math.floor((inner - 2) / 2)))}
          </Text>
          <Text
            color={warnCount > 0 || downCount > 0 ? theme.warn : theme.accent}
            bold
            wrap="truncate"
          >
            ◆
          </Text>
          <Text color={okCount > 0 ? theme.success : theme.textMuted} wrap="truncate">
            {'━'.repeat(Math.max(0, inner - Math.floor((inner - 2) / 2) - 3))}
          </Text>
          <Text color={theme.accent} bold wrap="truncate">
            ╮
          </Text>
        </Box>
        <Box width={inner} overflowX="hidden">
          {inner >= 24 ? (
            <Text color={theme.accent} wrap="truncate">
              ╰─
            </Text>
          ) : null}
          <Text color={theme.textMuted} wrap="truncate">
            {inner >= 24 ? ' SIGNAL MATRIX ' : 'SIGNAL MATRIX'}
          </Text>
          <Box flexGrow={1} />
          {inner >= 24 ? (
            <Text color={theme.accent} wrap="truncate">
              ─╯
            </Text>
          ) : null}
        </Box>
        {connections.length === 0 ? (
          <Text color={theme.textMuted}>◇ scanning for links…</Text>
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
            const showLatency = inner >= 24;
            const lat = showLatency && c.latencyMs != null ? `${c.latencyMs}ms` : '';
            const lane = c.status === 'ok' ? '━━' : c.status === 'warn' ? '┅┅' : '··';
            const rowChrome = displayWidth(icon) + displayWidth(lane);
            return (
              <Box key={`${c.name}-${i}`} flexDirection="column">
                <Box flexDirection="row" width={inner}>
                  <Text color={color}>
                    {icon}
                    {lane}
                  </Text>
                  <Text color={theme.textPrimary} bold={c.status === 'ok'} wrap="truncate">
                    {trunc(
                      c.name,
                      Math.max(3, inner - rowChrome - (lat ? displayWidth(lat) + 1 : 0)),
                    )}
                  </Text>
                  {lat ? (
                    <>
                      <Box flexGrow={1} />
                      <Text color={color}>{lat}</Text>
                    </>
                  ) : null}
                </Box>
                <Text color={color} dimColor>
                  {'  '}
                  {'⌁'.repeat(Math.max(1, Math.min(inner - 2, 3 + (i % 4))))}
                  <Text color={theme.textMuted}> link {String(i + 1).padStart(2, '0')}</Text>
                </Text>
              </Box>
            );
          })
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}
