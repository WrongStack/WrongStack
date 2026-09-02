import type { TodoItem } from '@wrongstack/core/agent';
import type React from 'react';
import type { GoalSummary, ResumeSessionEntry } from '../app-state.js';
import type { QueueItem } from '../app-state-core-types.js';
import { Box, Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';
import { METRIC_MIN_BODY_WIDTH, PILL_MIN_INNER_WIDTH } from '../ui-contracts.js';
import { glyphs } from '../ui-glyphs.js';
import type { LiveSessionEntry } from './sessions-panel.js';
import { isCurrentSession } from './sidebar-content.js';
import { SidebarPanelFrame, SidebarSectionHeader, trunc } from './sidebar-panel-frame.js';
import {
  EmptyState,
  fmtRelative,
  liveSessionColor,
  liveSessionGlyph,
  SidebarWorklistRow,
} from './sidebar-panels-shared.js';
import { fmtRatioPct } from './status-bar-format.js';

export interface PlanPanelSidebarProps {
  openCount: number;
  inProgressCount: number;
  doneCount: number;
  items: readonly { id: string; title: string; status: 'open' | 'in_progress' | 'done' }[];
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
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  const total = openCount + inProgressCount + doneCount;
  const ratio = total > 0 ? doneCount / total : 0;
  const ordered = [
    ...items.filter((i) => i.status === 'in_progress').slice(0, 3),
    ...items.filter((i) => i.status === 'open').slice(0, 4),
    ...items.filter((i) => i.status === 'done').slice(0, 2),
  ];
  // The header pill summarizes the panel's state in one place. On wide rails
  // (innerWidth >= 22) it sits on the title row's right edge; on narrower
  // rails the right side falls back to a status row beneath the title.
  return (
    <SidebarPanelFrame
      accent={theme.accent}
      icon={glyphs.plan}
      title="PLAN"
      width={width}
      kicker={title ? trunc(title, 20) : undefined}
      pillLabel={inner >= PILL_MIN_INNER_WIDTH ? fmtRatioPct(ratio) : undefined}
      pillColor={ratio === 1 && total > 0 ? theme.success : theme.accent}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text>
            <Text color={theme.warn}>
              {glyphs.bulletHalf}
              {inProgressCount}
            </Text>
            <Text color={theme.textMuted}> </Text>
            <Text color={theme.success}>
              {glyphs.success}
              {doneCount}
            </Text>
            <Text color={theme.textMuted}> {total}</Text>
          </Text>
        ) : undefined
      }
      footer="F5 details"
    >
      <SidebarSectionHeader
        glyph={glyphs.plan}
        label="PROGRESS"
        color={theme.accent}
        badge={fmtRatioPct(ratio)}
        badgeColor={ratio === 1 && total > 0 ? theme.success : theme.accent}
        innerWidth={bodyWidth}
        pill
      />
      <Box marginTop={1} width={bodyWidth}>
        <Text color={ratio === 1 && total > 0 ? theme.success : theme.accent}>
          {glyphs.barFull.repeat(Math.round(ratio * bodyWidth))}
        </Text>
        <Text color={theme.borderSubtle}>
          {glyphs.barEmpty.repeat(Math.max(0, bodyWidth - Math.round(ratio * bodyWidth)))}
        </Text>
      </Box>
      <SidebarSectionHeader
        glyph={glyphs.task}
        label="STEPS"
        color={theme.textMuted}
        badge={`${doneCount}/${total}`}
        innerWidth={bodyWidth}
        pill
      />
      {ordered.length === 0 ? (
        <EmptyState message="no plan items" innerWidth={bodyWidth} />
      ) : (
        ordered.map((item) => {
          const icon =
            item.status === 'done'
              ? glyphs.success
              : item.status === 'in_progress'
                ? glyphs.bulletHalf
                : glyphs.bulletOpen;
          const color =
            item.status === 'done'
              ? theme.success
              : item.status === 'in_progress'
                ? theme.warn
                : theme.textMuted;
          return (
            <SidebarWorklistRow
              key={item.id}
              icon={icon}
              iconColor={color}
              label={item.title}
              labelColor={item.status === 'done' ? theme.textMuted : theme.textPrimary}
              innerWidth={bodyWidth}
              dim={item.status === 'done'}
              strikethrough={item.status === 'done'}
            />
          );
        })
      )}
    </SidebarPanelFrame>
  );
}

export interface TodosPanelSidebarProps {
  todos: readonly TodoItem[];
  width: number;
}

export function TodosPanelSidebar({ todos, width }: TodosPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
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
      pillLabel={inner >= PILL_MIN_INNER_WIDTH ? `${done}/${todos.length}` : undefined}
      pillColor={done === todos.length && todos.length > 0 ? theme.success : theme.accent}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text>
            <Text color={theme.success}>{done}</Text>
            <Text color={theme.textMuted}>/{todos.length}</Text>
          </Text>
        ) : undefined
      }
      footer="F6 details"
    >
      {ordered.length === 0 ? (
        <EmptyState message="no todos" innerWidth={bodyWidth} />
      ) : (
        ordered.map((t) => {
          const icon =
            t.status === 'completed'
              ? glyphs.success
              : t.status === 'in_progress'
                ? glyphs.running
                : glyphs.pending;
          const color =
            t.status === 'completed'
              ? theme.success
              : t.status === 'in_progress'
                ? theme.accent
                : theme.textMuted;
          const base = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
          const label = t.blockedBy?.[0] ? `${base} — waiting on ${t.blockedBy[0]}` : base;
          return (
            <SidebarWorklistRow
              key={t.id}
              icon={icon}
              iconColor={color}
              label={label}
              labelColor={t.status === 'completed' ? theme.textMuted : theme.textPrimary}
              innerWidth={bodyWidth}
              dim={t.status === 'completed'}
              strikethrough={t.status === 'completed'}
            />
          );
        })
      )}
    </SidebarPanelFrame>
  );
}

export interface QueuePanelSidebarProps {
  items: readonly QueueItem[];
  width: number;
}

export function QueuePanelSidebar({ items, width }: QueuePanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  return (
    <SidebarPanelFrame
      accent={theme.accent}
      icon={glyphs.queue}
      title="QUEUE"
      width={width}
      kicker="queued prompts"
      pillLabel={inner >= PILL_MIN_INNER_WIDTH ? `${items.length}` : undefined}
      pillColor={items.length > 0 ? theme.warn : theme.textMuted}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text color={items.length > 0 ? theme.warn : theme.textMuted} bold>
            {items.length}
          </Text>
        ) : undefined
      }
      footer="F7 details"
    >
      {items.length === 0 ? (
        <EmptyState message="queue is empty" innerWidth={bodyWidth} />
      ) : (
        items
          .slice(0, 10)
          .map((item, i) => (
            <SidebarWorklistRow
              key={item.id ?? i}
              icon={`${i + 1}.`}
              iconColor={theme.textMuted}
              label={item.displayText}
              labelColor={theme.textPrimary}
              innerWidth={bodyWidth}
            />
          ))
      )}
    </SidebarPanelFrame>
  );
}

export interface ProcessListPanelSidebarProps {
  activeCount: number;
  totalCount: number;
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
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  return (
    <SidebarPanelFrame
      accent={theme.monitor.fleet}
      icon={glyphs.process}
      title="PROCESSES"
      width={width}
      kicker="running"
      pillLabel={inner >= PILL_MIN_INNER_WIDTH ? `${activeCount}/${totalCount}` : undefined}
      pillColor={activeCount > 0 ? theme.success : theme.textMuted}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text>
            <Text color={theme.success}>{activeCount}</Text>
            <Text color={theme.textMuted}>/{totalCount}</Text>
          </Text>
        ) : undefined
      }
      footer="F8 details"
    >
      {processes.length === 0 ? (
        <EmptyState message="no processes" innerWidth={bodyWidth} />
      ) : (
        processes.slice(0, 10).map((p, i) => {
          const status = (p.status ?? '').toLowerCase();
          const statusVisual =
            status === 'running'
              ? { glyph: glyphs.running, color: theme.success }
              : status === 'idle' || status === 'stopped' || status === 'paused'
                ? { glyph: glyphs.idle, color: theme.textMuted }
                : status === 'failed'
                  ? { glyph: glyphs.failure, color: theme.error }
                  : { glyph: glyphs.running, color: theme.success };
          const showPid = inner >= METRIC_MIN_BODY_WIDTH;
          const pidLabel = String(p.pid);
          return (
            <Box key={`${p.pid}-${i}`} flexDirection="row" width={bodyWidth}>
              <Text color={statusVisual.color}>{statusVisual.glyph}</Text>
              <Text color={theme.textPrimary}> </Text>
              <Text wrap="truncate">
                {trunc(
                  p.name,
                  Math.max(4, bodyWidth - 2 - (showPid ? displayWidth(pidLabel) + 1 : 0)),
                )}
              </Text>
              {showPid ? (
                <>
                  <Box flexGrow={1} />
                  <Text color={theme.textMuted}>{pidLabel}</Text>
                </>
              ) : null}
            </Box>
          );
        })
      )}
    </SidebarPanelFrame>
  );
}

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
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  const displayGoal = goal ? goal.refinedGoal || goal.goal : '';
  const stateVisual = goal
    ? goal.goalState === 'active'
      ? { glyph: glyphs.running, color: theme.warn }
      : goal.goalState === 'paused'
        ? { glyph: glyphs.pause, color: theme.textMuted }
        : goal.goalState === 'completed'
          ? { glyph: glyphs.success, color: theme.success }
          : { glyph: glyphs.idle, color: theme.textMuted }
    : { glyph: glyphs.idle, color: theme.textMuted };
  const progress = Math.min(
    100,
    Math.max(0, typeof goal?.progress === 'number' ? goal.progress : 0),
  );
  const deliverables = goal?.deliverables ?? [];
  const doneCount = deliverables.filter((d) => /^\[[x✓]\]|✅|\(done\)/i.test(d)).length;
  return (
    <SidebarPanelFrame
      accent={theme.brand}
      icon={glyphs.goal}
      title="GOAL"
      width={width}
      kicker="mission control"
      pillLabel={
        inner >= PILL_MIN_INNER_WIDTH && goal
          ? `${stateVisual.glyph} ${goal.goalState.toUpperCase()}`
          : undefined
      }
      pillColor={coordinatorRunning ? theme.success : theme.textMuted}
      right={
        inner < PILL_MIN_INNER_WIDTH && goal ? (
          <Text color={coordinatorRunning ? theme.success : theme.textMuted} bold>
            {stateVisual.glyph} {goal.goalState.toUpperCase()}
          </Text>
        ) : null
      }
      footer="F9 details"
    >
      {!goal ? (
        <EmptyState message="no mission set" innerWidth={bodyWidth} />
      ) : (
        <>
          <SidebarSectionHeader
            glyph={glyphs.goal}
            label="MISSION"
            color={theme.brand}
            innerWidth={bodyWidth}
          />
          <Text color={theme.textPrimary} bold wrap="truncate">
            {trunc(displayGoal, bodyWidth - 2)}
          </Text>
          <SidebarSectionHeader
            glyph={glyphs.success}
            label="PROGRESS"
            color={theme.success}
            badge={`${Math.round(progress)}%`}
            innerWidth={bodyWidth}
            pill
          />
          <Box marginTop={1} width={bodyWidth}>
            <Text color={theme.success}>
              {glyphs.barFull.repeat(Math.round((progress / 100) * bodyWidth))}
            </Text>
            <Text color={theme.borderSubtle}>
              {glyphs.barEmpty.repeat(
                Math.max(0, bodyWidth - Math.round((progress / 100) * bodyWidth)),
              )}
            </Text>
          </Box>
          <SidebarSectionHeader
            glyph={glyphs.task}
            label="DELIVERABLES"
            color={theme.warn}
            badge={`${doneCount}/${deliverables.length}`}
            innerWidth={bodyWidth}
            pill
          />
          {deliverables.length === 0 ? (
            <EmptyState message="no deliverables" innerWidth={bodyWidth} />
          ) : (
            deliverables.slice(0, 6).map((d, i) => {
              const done = /^\[[x✓]\]|✅|\(done\)/i.test(d);
              return (
                <SidebarWorklistRow
                  key={i}
                  icon={done ? glyphs.success : glyphs.pending}
                  iconColor={done ? theme.success : theme.textMuted}
                  label={d.replace(/^\[[ x✓]\]\s*/, '')}
                  labelColor={done ? theme.textMuted : theme.textSecondary}
                  innerWidth={bodyWidth}
                  dim={done}
                  strikethrough={done}
                />
              );
            })
          )}
        </>
      )}
    </SidebarPanelFrame>
  );
}

export interface SessionsPanelSidebarProps {
  liveSessions?: readonly LiveSessionEntry[] | undefined;
  resumeSessions?: readonly ResumeSessionEntry[] | undefined;
  currentSessionId?: string | undefined;
  now?: number | undefined;
  width: number;
}

export function SessionsPanelSidebar({
  liveSessions,
  resumeSessions,
  currentSessionId,
  now,
  width,
}: SessionsPanelSidebarProps): React.ReactElement {
  const inner = Math.max(8, width);
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  const nowRef = now ?? Date.now();
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
      pillLabel={inner >= PILL_MIN_INNER_WIDTH ? `${total}` : undefined}
      pillColor={total > 0 ? theme.success : theme.textMuted}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text color={total > 0 ? theme.success : theme.textMuted}>{total}</Text>
        ) : undefined
      }
      footer="F10 details"
    >
      {live.length > 0 ? (
        <>
          <SidebarSectionHeader
            glyph={glyphs.peers}
            label="LIVE"
            color={theme.success}
            badge={`${live.length}`}
            innerWidth={bodyWidth}
            pill
          />
          {live.map((s) => {
            const isCurrent = isCurrentSession(s.sessionId, currentSessionId);
            const icon = isCurrent ? glyphs.bullet : liveSessionGlyph(s.status);
            const color = liveSessionColor(s.status);
            const showAgentCount = inner >= METRIC_MIN_BODY_WIDTH;
            return (
              <Box key={s.sessionId} flexDirection="row" width={bodyWidth}>
                <Text color={color}>{icon}</Text>
                <Text
                  color={isCurrent ? theme.accent : theme.textPrimary}
                  bold={isCurrent}
                  wrap="truncate"
                >
                  {' '}
                  {trunc(s.projectName, Math.max(4, bodyWidth - (showAgentCount ? 6 : 2)))}
                </Text>
                {showAgentCount ? (
                  <>
                    <Box flexGrow={1} />
                    <Text color={theme.textMuted}>{s.agentCount}a</Text>
                  </>
                ) : null}
              </Box>
            );
          })}
        </>
      ) : null}
      {resume.length > 0 ? (
        <>
          <SidebarSectionHeader
            glyph={glyphs.save}
            label="RESUME"
            color={theme.textMuted}
            badge={`${resume.length}`}
            innerWidth={bodyWidth}
            pill
          />
          {resume.map((rs) => {
            const showRelativeTime = inner >= METRIC_MIN_BODY_WIDTH;
            const rel = showRelativeTime
              ? fmtRelative(rs.lastActivityAt ?? rs.endedAt, nowRef)
              : '';
            const title = trunc(
              rs.title || rs.lastUserMessage || rs.id,
              Math.max(4, bodyWidth - 2 - (showRelativeTime ? displayWidth(rel) + 1 : 0)),
            );
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
            const isCurrent = isCurrentSession(rs.id, currentSessionId, rs.isCurrent);
            return (
              <Box key={rs.id} flexDirection="row" width={bodyWidth}>
                <Text color={outcomeColor}>{outcomeGlyph}</Text>
                <Text
                  color={isCurrent ? theme.accent : theme.textSecondary}
                  bold={isCurrent}
                  wrap="truncate"
                >
                  {' '}
                  {title}
                </Text>
                {showRelativeTime ? (
                  <>
                    <Box flexGrow={1} />
                    <Text color={theme.textMuted}>{rel}</Text>
                  </>
                ) : null}
              </Box>
            );
          })}
        </>
      ) : null}
      {total === 0 ? <EmptyState message="no sessions" innerWidth={bodyWidth} /> : null}
    </SidebarPanelFrame>
  );
}

export interface KanbanPanelSidebarProps {
  columns: readonly { name: string; count: number; wip?: number }[];
  totalActive: number;
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
  // Card body content width — the Card adds 2 cols for `│` sides and 2 cols
  // for body padding on rails wide enough to afford the chrome (inner >= 18).
  // The SectionHeader / StatRow / WorklistRow dotted leaders size to this
  // inset width so they fill the available content area without overshooting
  // the right `│` bar.
  const bodyWidth = inner >= 18 ? inner - 4 : inner;
  return (
    <SidebarPanelFrame
      accent={theme.accent}
      icon={glyphs.task}
      title="KANBAN"
      width={width}
      kicker="board"
      pillLabel={inner >= PILL_MIN_INNER_WIDTH ? `${totalActive} active` : undefined}
      pillColor={totalActive > 0 ? theme.warn : theme.textMuted}
      right={
        inner < PILL_MIN_INNER_WIDTH ? (
          <Text>
            <Text color={theme.success}>
              {glyphs.success}
              {columns.find((c) => c.name === 'done')?.count ?? 0}
            </Text>
            <Text color={theme.textMuted}> {totalActive}</Text>
          </Text>
        ) : undefined
      }
      footer="F12 details"
    >
      <SidebarSectionHeader
        glyph={glyphs.fleet}
        label="COLUMNS"
        color={theme.accent}
        innerWidth={bodyWidth}
      />
      {columns.slice(0, 5).map((c, i) => (
        <Box key={i} flexDirection="row" width={bodyWidth}>
          <Text color={theme.textSecondary} wrap="truncate">
            {trunc(c.name, bodyWidth - 6)}
          </Text>
          <Box flexGrow={1} />
          <Text color={theme.textMuted}>{c.count}</Text>
        </Box>
      ))}
      <SidebarSectionHeader
        glyph={glyphs.running}
        label="ACTIVE"
        color={theme.warn}
        innerWidth={bodyWidth}
        pill
      />
      {activeCardTitles.length === 0 ? (
        <EmptyState message="no active cards" innerWidth={bodyWidth} />
      ) : (
        activeCardTitles.slice(0, 6).map((title, i) => {
          const icon = i === 0 ? glyphs.pending : glyphs.warning;
          const iconColor = i === 0 ? theme.textMuted : theme.warn;
          const label = i === 0 ? title : `${i + 1}. ${title}`;
          return (
            <SidebarWorklistRow
              key={i}
              icon={icon}
              iconColor={iconColor}
              label={label}
              labelColor={theme.textPrimary}
              innerWidth={bodyWidth}
            />
          );
        })
      )}
    </SidebarPanelFrame>
  );
}
