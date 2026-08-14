import type { TodoItem } from '@wrongstack/core/agent';
import type React from 'react';
import type { GoalSummary, ResumeSessionEntry } from '../app-state.js';
import type { QueueItem } from '../app-state-core-types.js';
import { Box, Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import type { LiveSessionEntry } from './sessions-panel.js';
import { isCurrentSession } from './sidebar-content.js';
import {
  SidebarPanelCard,
  SidebarPanelFrame,
  SidebarSectionHeader,
  trunc,
} from './sidebar-panel-frame.js';
import {
  fmtRelative,
  liveSessionColor,
  liveSessionGlyph,
  SidebarWorklistRow,
} from './sidebar-panels-shared.js';

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
          <Text color={theme.success}>
            {glyphs.success}
            {doneCount}
          </Text>
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
              <SidebarWorklistRow
                key={item.id}
                icon={icon}
                iconColor={color}
                label={item.title}
                labelColor={item.status === 'done' ? theme.textMuted : theme.textPrimary}
                innerWidth={inner}
                dim={item.status === 'done'}
                strikethrough={item.status === 'done'}
              />
            );
          })
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

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
            const base = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
            const label = t.blockedBy?.[0] ? `${base} — waiting on ${t.blockedBy[0]}` : base;
            return (
              <SidebarWorklistRow
                key={t.id}
                icon={icon}
                iconColor={color}
                label={label}
                labelColor={t.status === 'completed' ? theme.textMuted : theme.textPrimary}
                innerWidth={inner}
                dim={t.status === 'completed'}
                strikethrough={t.status === 'completed'}
              />
            );
          })
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}

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
          items
            .slice(0, 10)
            .map((item, i) => (
              <SidebarWorklistRow
                key={item.id ?? i}
                icon={`${i + 1}.`}
                iconColor={theme.textMuted}
                label={item.displayText}
                labelColor={theme.textPrimary}
                innerWidth={inner}
              />
            ))
        )}
      </SidebarPanelCard>
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
          processes.slice(0, 10).map((p, i) => {
            const showPid = inner >= 24;
            const pidLabel = String(p.pid);
            return (
              <Box key={`${p.pid}-${i}`} flexDirection="row">
                <Text color={theme.success}>{glyphs.running}</Text>
                <Text color={theme.textPrimary}> </Text>
                <Text wrap="truncate">
                  {trunc(
                    p.name,
                    Math.max(4, inner - 2 - (showPid ? displayWidth(pidLabel) + 1 : 0)),
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
      </SidebarPanelCard>
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
  const displayGoal = goal ? goal.refinedGoal || goal.goal : '';
  const stateIcon =
    goal?.goalState === 'active'
      ? '🔄'
      : goal?.goalState === 'paused'
        ? '⏸'
        : goal?.goalState === 'completed'
          ? '✅'
          : '⏹';
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
              <Text color={theme.success}>{'█'.repeat(Math.round((progress / 100) * inner))}</Text>
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
                <SidebarWorklistRow
                  key={i}
                  icon={done ? glyphs.success : glyphs.pending}
                  iconColor={done ? theme.success : theme.textMuted}
                  label={d.replace(/^\[[ x✓]\]\s*/, '')}
                  labelColor={done ? theme.textMuted : theme.textSecondary}
                  innerWidth={inner}
                  dim={done}
                  strikethrough={done}
                />
              );
            })}
          </SidebarPanelCard>
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
      right={<Text color={total > 0 ? theme.success : theme.textMuted}>{total}</Text>}
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
            const isCurrent = isCurrentSession(s.sessionId, currentSessionId);
            const icon = isCurrent ? '●' : liveSessionGlyph(s.status);
            const color = liveSessionColor(s.status);
            const showAgentCount = inner >= 24;
            return (
              <Box key={s.sessionId} flexDirection="row">
                <Text color={color}>{icon}</Text>
                <Text color={isCurrent ? theme.accent : theme.textPrimary} bold={isCurrent}>
                  {' '}
                  {trunc(s.projectName, Math.max(4, inner - (showAgentCount ? 6 : 2)))}
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
            const showRelativeTime = inner >= 24;
            const rel = showRelativeTime ? fmtRelative(rs.lastActivityAt ?? rs.endedAt, nowRef) : '';
            const title = trunc(
              rs.title || rs.lastUserMessage || rs.id,
              Math.max(4, inner - 2 - (showRelativeTime ? displayWidth(rel) + 1 : 0)),
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
              <Box key={rs.id} flexDirection="row">
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
  return (
    <SidebarPanelFrame
      accent={theme.accent}
      icon={glyphs.task}
      title="KANBAN"
      width={width}
      kicker="board"
      right={
        <Text>
          <Text color={theme.success}>
            {glyphs.success}
            {columns.find((c) => c.name === 'done')?.count ?? 0}
          </Text>
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
          activeCardTitles
            .slice(0, 6)
            .map((title, i) => (
              <SidebarWorklistRow
                key={i}
                icon="●"
                iconColor={theme.warn}
                label={title}
                labelColor={theme.textPrimary}
                innerWidth={inner}
              />
            ))
        )}
      </SidebarPanelCard>
    </SidebarPanelFrame>
  );
}
