// Sidebar variants of every F-key panel.
//
// Each sidebar variant renders the same content as its bottom-region
// sibling but adapted to the narrow right-sidebar region (~20–48 columns).
// Visual language is identical (same colors, icons, heading structure,
// separators) so users can recognize the panel regardless of placement.
//
// Width contract: `width` is the content width already inside RightSidebar's
// border and padding. Every section uses that full width so dotted leaders,
// block meters, and metrics line up. RightSidebar owns clipping for the routed
// panels plus the persistent SidebarContent stack.
//
// All 13 sidebar variants in this single file:
//
//   F-key │ bottom panel             │ sidebar variant
//   ─────┼───────────────────────────┼──────────────────────────────
//   F1   │ ProjectPicker             │ ProjectPickerSidebar
//   F2   │ FleetPanel                │ FleetPanelSidebar
//   F3   │ AgentsMonitor             │ AgentsPanelSidebar
//   F4   │ WorktreeMonitor           │ WorktreePanelSidebar
//   F5   │ PlanPanel                 │ PlanPanelSidebar
//   F6   │ TodosMonitor              │ TodosPanelSidebar
//   F7   │ QueuePanel                │ QueuePanelSidebar
//   F8   │ ProcessListMonitor        │ ProcessListPanelSidebar
//   F9   │ GoalPanel                 │ GoalPanelSidebar
//   F10  │ SessionsPanel             │ SessionsPanelSidebar
//   F11  │ CoordinatorPanel          │ CoordinatorPanelSidebar
//   F12  │ KanbanPanel               │ KanbanPanelSidebar
//   Ctrl+N│ ConnectionsPanel         │ ConnectionsPanelSidebar
//
// Sidebar variants reuse the same data hooks as their bottom counterparts
// — they never construct their own state. They render only when the host
// (app-view) routes the F-key panel to 'sidebar' AND the panel is "open"
// (i.e., the F-key was pressed once). When the F-key is closed, the sidebar
// slot is hidden.

import type React from 'react';
import { Box, Text } from '../ink.js';
import type { FleetEntry } from '../app-state.js';
import type { TodoItem } from '@wrongstack/core/agent';
import type { GoalSummary } from '../app-state.js';
import type { QueueItem } from '../app-state-core-types.js';
import type { LiveSessionEntry } from './sessions-panel.js';
import type { ProjectPickerItem } from './project-picker.js';
import type { ResumeSessionEntry } from '../app-state.js';
import type { WorktreeRow } from '../ui-contracts.js';
import { theme } from '../theme.js';
import { displayWidth } from '../terminal-width.js';
import { glyphs } from '../ui-glyphs.js';
import { SidebarPanelCard, SidebarPanelFrame, SidebarSectionHeader, trunc } from './sidebar-panel-frame.js';

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

/** Status glyph + color for a fleet entry. */
function fleetStatusVisual(status: FleetEntry['status']): { glyph: string; color: string } {
  switch (status) {
    case 'running':
      return { glyph: glyphs.running, color: theme.success };
    case 'idle':
      return { glyph: glyphs.idle, color: theme.textMuted };
    case 'success':
      return { glyph: glyphs.success, color: theme.success };
    case 'failed':
    case 'timeout':
    case 'stopped':
      return { glyph: glyphs.failure, color: theme.error };
    default:
      return { glyph: '?', color: theme.textMuted };
  }
}

/** Live session status glyph. */
function liveSessionGlyph(status: string): string {
  switch (status) {
    case 'active':
      return '●';
    case 'idle':
      return '◉';
    case 'closing':
      return '◐';
    case 'stale':
      return '○';
    default:
      return '?';
  }
}

function liveSessionColor(status: string): string {
  if (status === 'active' || status === 'running') return theme.success;
  if (status === 'idle') return theme.accent;
  if (status === 'error' || status === 'stale') return theme.error;
  if (status === 'closing') return theme.warn;
  return theme.textMuted;
}

/** Short relative time like "3m", "2h". */
function fmtRelative(iso: string | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtShortDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

// ─────────────────────────────────────────────────────────────────────────
// F1 — ProjectPickerSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface ProjectPickerSidebarProps {
  /** Already-filtered picker items. Navigation indices target this list directly. */
  items: readonly ProjectPickerItem[];
  /** Index into `items`. */
  selected: number;
  /** Current filter text. */
  filter: string;
  /** Optional status/error hint shown below the list. */
  hint?: string | undefined;
  /** Current project name to highlight. */
  currentProject?: string | undefined;
  /** Width of the sidebar in columns. */
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
              return <Text key={`${item.key}-${index}`} color={theme.textMuted}>{'─'.repeat(inner)}</Text>;
            }
            const icon = item.kind === 'project' ? glyphs.folder : glyphs.task;
            const accent = item.kind === 'project' ? theme.brand : theme.warn;
            return (
              <Box key={item.key} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={isSelected ? accent : theme.textMuted}>{isSelected ? '▎' : ' '}</Text>
                  <Text color={accent}> {icon} </Text>
                  <Text color={isSelected ? theme.textPrimary : theme.textSecondary} bold={isSelected} wrap="truncate">
                    {trunc(item.label, Math.max(4, inner - 6))}
                  </Text>
                </Box>
                {item.subtitle ? (
                  <Text color={theme.textMuted}> └ {trunc(item.subtitle, Math.max(4, inner - 4))}</Text>
                ) : null}
              </Box>
            );
          })
        )}
        {hint ? <Text color={theme.warn}>{glyphs.warning} {trunc(hint, inner - 2)}</Text> : null}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// F2 — FleetPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface FleetPanelSidebarProps {
  entries: Record<string, FleetEntry>;
  /** Active (running) subagent count. */
  runningCount: number;
  /** Width of the sidebar in columns. */
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

// ─────────────────────────────────────────────────────────────────────────
// F3 — AgentsPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

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
  // Pick the "hottest" agent by ctxPct.
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
          const name = trunc(e.name || e.id, inner - 12);
          return (
            <Box key={e.id} flexDirection="row">
              <Text color={v.color}>{v.glyph}</Text>
              <Text color={theme.textPrimary}> </Text>
              <Text wrap="truncate">{name}</Text>
              <Box flexGrow={1} />
              <Text color={theme.textMuted}>{fmtShortDuration(elapsed)}</Text>
            </Box>
          );
        })}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// F4 — WorktreePanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface WorktreePanelSidebarProps {
  worktrees: Record<string, WorktreeRow>;
  /** Width of the sidebar in columns. */
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

// ─────────────────────────────────────────────────────────────────────────
// F5 — PlanPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface PlanPanelSidebarProps {
  /** Plan items grouped by status. */
  openCount: number;
  inProgressCount: number;
  doneCount: number;
  /** Up to N plan item titles to display. */
  items: readonly { id: string; title: string; status: 'open' | 'in_progress' | 'done' }[];
  /** Title of the plan (if any). */
  title?: string | undefined;
  width: number;
}

export function PlanPanelSidebar({
  openCount,
  inProgressCount,
  doneCount,
  items,
  title,
  width,
}: PlanPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  const total = openCount + inProgressCount + doneCount;
  const ratio = total > 0 ? doneCount / total : 0;
  const ordered = [
    ...items.filter((i) => i.status === 'in_progress').slice(0, 3),
    ...items.filter((i) => i.status === 'open').slice(0, 4),
    ...items.filter((i) => i.status === 'done').slice(0, 2),
  ];
  return (
    <SidebarPanelFrame
      accent={theme.accent}
      icon={glyphs.plan}
      title="PLAN"
      width={width}
      kicker={title ? trunc(title, 20) : undefined}
      right={
        <Text>
          <Text color={theme.warn}>◐{inProgressCount}</Text>
          <Text color={theme.textMuted}> </Text>
          <Text color={theme.success}>{glyphs.success}{doneCount}</Text>
          <Text color={theme.textMuted}> {total}</Text>
        </Text>
      }
      footer="F5 details"
    >
      <SidebarPanelCard innerWidth={inner}>
        <SidebarSectionHeader
          glyph={glyphs.plan}
          label="PROGRESS"
          color={theme.accent}
          badge={`${Math.round(ratio * 100)}%`}
          badgeColor={ratio === 1 && total > 0 ? theme.success : theme.accent}
          innerWidth={inner}
        />
        <Box>
          <Text color={ratio === 1 && total > 0 ? theme.success : theme.accent}>
            {'█'.repeat(Math.round(ratio * inner))}
          </Text>
          <Text color={theme.borderSubtle}>
            {'░'.repeat(Math.max(0, inner - Math.round(ratio * inner)))}
          </Text>
        </Box>
      </SidebarPanelCard>
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        <SidebarSectionHeader
          glyph={glyphs.task}
          label="STEPS"
          color={theme.textMuted}
          badge={`${doneCount}/${total}`}
          innerWidth={inner}
        />
        {ordered.length === 0 ? (
          <Text color={theme.textMuted}>no plan items</Text>
        ) : (
          ordered.map((item) => {
            const icon =
              item.status === 'done' ? glyphs.success : item.status === 'in_progress' ? '◐' : '○';
            const color =
              item.status === 'done'
                ? theme.success
                : item.status === 'in_progress'
                  ? theme.warn
                  : theme.textMuted;
            return (
              <Box key={item.id} width={inner} flexDirection="row">
                <Text color={color}>{icon}</Text>
                <Text
                  color={item.status === 'done' ? theme.textMuted : theme.textPrimary}
                  {...(item.status === 'done' ? { dimColor: true, strikethrough: true } : {})}
                >
                  {' '}
                  {item.title}
                </Text>
              </Box>
            );
          })
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// F6 — TodosPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface TodosPanelSidebarProps {
  todos: readonly TodoItem[];
  width: number;
}

export function TodosPanelSidebar({ todos, width }: TodosPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  const ordered = [...todos]
    .sort((a, b) => {
      const rank = (t: TodoItem) =>
        t.status === 'in_progress' ? 0 : t.status === 'pending' ? 1 : 2;
      return rank(a) - rank(b);
    })
    .slice(0, 12);
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <SidebarPanelFrame
      accent={theme.accent}
      icon={glyphs.goal}
      title="TODOS"
      width={width}
      kicker="mission queue"
      right={
        <Text>
          <Text color={theme.success}>{done}</Text>
          <Text color={theme.textMuted}>/{todos.length}</Text>
        </Text>
      }
      footer="F6 details"
    >
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        {ordered.length === 0 ? (
          <Text color={theme.textMuted}>no todos</Text>
        ) : (
          ordered.map((t) => {
            const icon =
              t.status === 'completed' ? glyphs.success : t.status === 'in_progress' ? '●' : '○';
            const color =
              t.status === 'completed'
                ? theme.success
                : t.status === 'in_progress'
                  ? theme.accent
                  : theme.textMuted;
            const label =
              t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
            return (
              <Box key={t.id} width={inner} flexDirection="row">
                <Text color={color}>{icon}</Text>
                <Text
                  color={t.status === 'completed' ? theme.textMuted : theme.textPrimary}
                  {...(t.status === 'completed' ? { dimColor: true, strikethrough: true } : {})}
                >
                  {' '}
                  {label}
                </Text>
              </Box>
            );
          })
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// F7 — QueuePanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface QueuePanelSidebarProps {
  items: readonly QueueItem[];
  width: number;
}

export function QueuePanelSidebar({ items, width }: QueuePanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  return (
    <SidebarPanelFrame
      accent={theme.accent}
      icon={glyphs.queue}
      title="QUEUE"
      width={width}
      kicker="queued prompts"
      right={
        <Text color={items.length > 0 ? theme.warn : theme.textMuted} bold>
          {items.length}
        </Text>
      }
      footer="F7 details"
    >
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        {items.length === 0 ? (
          <Text color={theme.textMuted}>queue is empty</Text>
        ) : (
          items.slice(0, 10).map((item, i) => (
            <Box key={item.id ?? i} width={inner} flexDirection="row">
              <Text color={theme.textMuted}>{i + 1}.</Text>
              <Text
                color={theme.textPrimary}
              >
                {' '}
                {item.displayText}
              </Text>
            </Box>
          ))
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// F8 — ProcessListPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface ProcessListPanelSidebarProps {
  /** Active process count and a few process summaries. */
  activeCount: number;
  /** Total process count. */
  totalCount: number;
  /** Up to 8 process rows: name + pid. */
  processes: readonly { pid: number; name: string; status?: string }[];
  width: number;
}

export function ProcessListPanelSidebar({
  activeCount,
  totalCount,
  processes,
  width,
}: ProcessListPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  return (
    <SidebarPanelFrame
      accent={theme.monitor.fleet}
      icon={glyphs.process}
      title="PROCESSES"
      width={width}
      kicker="running"
      right={
        <Text>
          <Text color={theme.success}>{activeCount}</Text>
          <Text color={theme.textMuted}>/{totalCount}</Text>
        </Text>
      }
      footer="F8 details"
    >
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        {processes.length === 0 ? (
          <Text color={theme.textMuted}>no processes</Text>
        ) : (
          processes.slice(0, 10).map((p, i) => (
            <Box key={`${p.pid}-${i}`} flexDirection="row">
              <Text color={theme.success}>{glyphs.running}</Text>
              <Text color={theme.textPrimary}> </Text>
              <Text wrap="truncate">{trunc(p.name, inner - 12)}</Text>
              <Box flexGrow={1} />
              <Text color={theme.textMuted}>{p.pid}</Text>
            </Box>
          ))
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// F9 — GoalPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface GoalPanelSidebarProps {
  goal: GoalSummary | null;
  coordinatorRunning: boolean;
  width: number;
}

export function GoalPanelSidebar({
  goal,
  coordinatorRunning,
  width,
}: GoalPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  const displayGoal = goal ? goal.refinedGoal || goal.goal : '';
  const stateIcon =
    goal?.goalState === 'active'
      ? '🔄'
      : goal?.goalState === 'paused'
        ? '⏸'
        : goal?.goalState === 'completed'
          ? '✅'
          : '⏹';
  const progress = typeof goal?.progress === 'number' ? goal.progress : 0;
  const deliverables = goal?.deliverables ?? [];
  const doneCount = deliverables.filter((d) => /^\[[x✓]\]|✅|\(done\)/i.test(d)).length;
  return (
    <SidebarPanelFrame
      accent={theme.brand}
      icon={glyphs.goal}
      title="GOAL"
      width={width}
      kicker="mission control"
      right={
        goal ? (
          <Text color={coordinatorRunning ? theme.success : theme.textMuted} bold>
            {stateIcon} {goal.goalState.toUpperCase()}
          </Text>
        ) : null
      }
      footer="F9 details"
    >
      {!goal ? (
        <SidebarPanelCard innerWidth={inner}>
          <Text color={theme.textMuted}>no mission set</Text>
        </SidebarPanelCard>
      ) : (
        <>
          <SidebarPanelCard innerWidth={inner}>
            <SidebarSectionHeader
              glyph={glyphs.goal}
              label="MISSION"
              color={theme.brand}
              innerWidth={inner}
            />
            <Text color={theme.textPrimary} bold wrap="truncate">
              {trunc(displayGoal, inner - 2)}
            </Text>
          </SidebarPanelCard>
          <SidebarPanelCard innerWidth={inner}>
            <SidebarSectionHeader
              glyph={glyphs.success}
              label="PROGRESS"
              color={theme.success}
              badge={`${Math.round(progress)}%`}
              innerWidth={inner}
            />
            <Box>
              <Text color={theme.success}>
                {'█'.repeat(Math.round((progress / 100) * inner))}
              </Text>
              <Text color={theme.borderSubtle}>
                {'░'.repeat(Math.max(0, inner - Math.round((progress / 100) * inner)))}
              </Text>
            </Box>
          </SidebarPanelCard>
          <SidebarPanelCard innerWidth={inner} marginBottom={0}>
            <SidebarSectionHeader
              glyph={glyphs.task}
              label="DELIVERABLES"
              color={theme.warn}
              badge={`${doneCount}/${deliverables.length}`}
              innerWidth={inner}
            />
            {deliverables.slice(0, 6).map((d, i) => {
              const done = /^\[[x✓]\]|✅|\(done\)/i.test(d);
              return (
                <Box key={i} width={inner} flexDirection="row">
                  <Text color={done ? theme.success : theme.textMuted}>
                    {done ? glyphs.success : glyphs.pending}
                  </Text>
                  <Text
                    color={done ? theme.textMuted : theme.textSecondary}
                    {...(done ? { dimColor: true, strikethrough: true } : {})}
                  >
                    {' '}
                    {d.replace(/^\[[ x✓]\]\s*/, '')}
                  </Text>
                </Box>
              );
            })}
          </SidebarPanelCard>
        </>
      )}
    </SidebarPanelFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// F10 — SessionsPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface SessionsPanelSidebarProps {
  liveSessions?: readonly LiveSessionEntry[] | undefined;
  resumeSessions?: readonly ResumeSessionEntry[] | undefined;
  currentSessionId?: string | undefined;
  width: number;
}

export function SessionsPanelSidebar({
  liveSessions,
  resumeSessions,
  currentSessionId,
  width,
}: SessionsPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  const live = liveSessions?.slice(0, 3) ?? [];
  const resume = resumeSessions?.slice(0, 3) ?? [];
  const total = (liveSessions?.length ?? 0) + (resumeSessions?.length ?? 0);
  return (
    <SidebarPanelFrame
      accent={theme.success}
      icon={glyphs.sessions}
      title="SESSIONS"
      width={width}
      kicker="live + resume"
      right={
        <Text color={total > 0 ? theme.success : theme.textMuted}>{total}</Text>
      }
      footer="F10 details"
    >
      {live.length > 0 ? (
        <SidebarPanelCard innerWidth={inner}>
          <SidebarSectionHeader
            glyph={glyphs.peers}
            label="LIVE"
            color={theme.success}
            badge={`${live.length}`}
            innerWidth={inner}
          />
          {live.map((s) => {
            const isCurrent = s.sessionId === currentSessionId;
            const icon = isCurrent ? '●' : liveSessionGlyph(s.status);
            const color = liveSessionColor(s.status);
            return (
              <Box key={s.sessionId} flexDirection="row">
                <Text color={color}>{icon}</Text>
                <Text color={isCurrent ? theme.accent : theme.textPrimary} bold={isCurrent}>
                  {' '}
                  {trunc(s.projectName, inner - 6)}
                </Text>
                <Box flexGrow={1} />
                <Text color={theme.textMuted}>{s.agentCount}a</Text>
              </Box>
            );
          })}
        </SidebarPanelCard>
      ) : null}
      {resume.length > 0 ? (
        <SidebarPanelCard innerWidth={inner} marginBottom={0}>
          <SidebarSectionHeader
            glyph={glyphs.save}
            label="RESUME"
            color={theme.textMuted}
            badge={`${resume.length}`}
            innerWidth={inner}
          />
          {resume.map((rs) => {
            const title = trunc(rs.title || rs.lastUserMessage || rs.id, inner - 10);
            const rel = fmtRelative(rs.lastActivityAt ?? rs.endedAt);
            const outcomeGlyph =
              rs.outcome === 'completed'
                ? glyphs.success
                : rs.outcome === 'error'
                  ? glyphs.failure
                  : rs.outcome === 'timeout'
                    ? '⏱'
                    : '⊘';
            const outcomeColor =
              rs.outcome === 'completed'
                ? theme.success
                : rs.outcome === 'error'
                  ? theme.error
                  : rs.outcome === 'timeout'
                    ? theme.warn
                    : theme.textMuted;
            return (
              <Box key={rs.id} flexDirection="row">
                <Text color={outcomeColor}>{outcomeGlyph}</Text>
                <Text
                  color={rs.isCurrent ? theme.accent : theme.textSecondary}
                  bold={rs.isCurrent === true}
                  wrap="truncate"
                >
                  {' '}
                  {title}
                </Text>
                <Box flexGrow={1} />
                <Text color={theme.textMuted}>{rel}</Text>
              </Box>
            );
          })}
        </SidebarPanelCard>
      ) : null}
      {total === 0 ? (
        <SidebarPanelCard innerWidth={inner} marginBottom={0}>
          <Text color={theme.textMuted}>no sessions</Text>
        </SidebarPanelCard>
      ) : null}
    </SidebarPanelFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// F11 — CoordinatorPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface CoordinatorPanelSidebarProps {
  running: boolean;
  /** Active phase count. */
  activePhases: number;
  /** Completed phase count. */
  completedPhases: number;
  /** Up to 5 active phase names. */
  phaseNames: readonly string[];
  /** Elapsed ms since coordinator started. */
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

// ─────────────────────────────────────────────────────────────────────────
// F12 — KanbanPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface KanbanPanelSidebarProps {
  /** Per-column counts: Backlog / Up Next / In Progress / Review / Done. */
  columns: readonly { name: string; count: number; wip?: number }[];
  /** Active card count (total cards across all columns). */
  totalActive: number;
  /** Up to 6 active card titles. */
  activeCardTitles: readonly string[];
  width: number;
}

export function KanbanPanelSidebar({
  columns,
  totalActive,
  activeCardTitles,
  width,
}: KanbanPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  return (
    <SidebarPanelFrame
      accent={theme.accent}
      icon={glyphs.task}
      title="KANBAN"
      width={width}
      kicker="board"
      right={
        <Text>
          <Text color={theme.success}>{glyphs.success}{columns.find((c) => c.name === 'done')?.count ?? 0}</Text>
          <Text color={theme.textMuted}> {totalActive}</Text>
        </Text>
      }
      footer="F12 details"
    >
      <SidebarPanelCard innerWidth={inner}>
        <SidebarSectionHeader
          glyph={glyphs.fleet}
          label="COLUMNS"
          color={theme.accent}
          innerWidth={inner}
        />
        {columns.slice(0, 5).map((c, i) => (
          <Box key={i} flexDirection="row">
            <Text color={theme.textSecondary} wrap="truncate">
              {trunc(c.name, inner - 6)}
            </Text>
            <Box flexGrow={1} />
            <Text color={theme.textMuted}>{c.count}</Text>
          </Box>
        ))}
      </SidebarPanelCard>
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        <SidebarSectionHeader
          glyph={glyphs.running}
          label="ACTIVE"
          color={theme.warn}
          innerWidth={inner}
        />
        {activeCardTitles.length === 0 ? (
          <Text color={theme.textMuted}>no active cards</Text>
        ) : (
          activeCardTitles.slice(0, 6).map((title, i) => (
            <Box key={i} width={inner} flexDirection="row">
              <Text color={theme.warn}>●</Text>
              <Text color={theme.textPrimary}>
                {' '}
                {title}
              </Text>
            </Box>
          ))
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Ctrl+N — ConnectionsPanelSidebar
// ─────────────────────────────────────────────────────────────────────────

export interface ConnectionsPanelSidebarProps {
  /** Connection summaries: name + status badge. */
  connections: readonly { name: string; status: 'ok' | 'warn' | 'down' | 'unknown'; latencyMs?: number | undefined }[];
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
          <Text color={theme.success}>{glyphs.success}{okCount}</Text>
          {warnCount > 0 ? (
            <>
              <Text color={theme.textMuted}> </Text>
              <Text color={theme.warn}>{glyphs.warning}{warnCount}</Text>
            </>
          ) : null}
          {downCount > 0 ? (
            <>
              <Text color={theme.textMuted}> </Text>
              <Text color={theme.error}>{glyphs.failure}{downCount}</Text>
            </>
          ) : null}
        </Text>
      }
      footer="Ctrl+N details"
    >
      <SidebarPanelCard innerWidth={inner} marginBottom={0}>
        {connections.length === 0 ? (
          <Text color={theme.textMuted}>no connections</Text>
        ) : (
          connections.slice(0, 10).map((c, i) => {
            const icon =
              c.status === 'ok' ? glyphs.success : c.status === 'warn' ? glyphs.warning : c.status === 'down' ? glyphs.failure : '?';
            const color =
              c.status === 'ok'
                ? theme.success
                : c.status === 'warn'
                  ? theme.warn
                  : c.status === 'down'
                    ? theme.error
                    : theme.textMuted;
            const lat = c.latencyMs != null ? `${c.latencyMs}ms` : '';
            return (
              <Box key={`${c.name}-${i}`} flexDirection="row">
                <Text color={color}>{icon}</Text>
                <Text color={theme.textPrimary} wrap="truncate">
                  {' '}
                  {trunc(c.name, inner - 10)}
                </Text>
                <Box flexGrow={1} />
                <Text color={theme.textMuted}>{lat}</Text>
              </Box>
            );
          })
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}