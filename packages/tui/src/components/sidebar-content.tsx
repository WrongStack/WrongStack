// Compact sidebar content — fleet status + context meter + mission queue + sessions.
//
// Designed for the narrow RightSidebar region (~20-48 columns). Shows:
//   1. Context usage meter (reuses the statusline bracket meter)
//   2. Fleet summary (running/idle/completed counts)
//   3. Per-agent compact rows (name + status + ctx%) for running subagents
//   4. Mission Queue (todo items) when showSwarmSection is enabled
//   5. Sessions section: live sessions (F10) + recent resume sessions (/resume)
//
// All data is passed as props — this component is pure presentation with no
// hooks, no event listeners, no keyboard input. It fits inside the sidebar
// shell (components/sidebar.tsx).

import type { ResumeSessionEntry } from '../app-state.js';
import type { FleetEntry } from '../app-state-fleet.js';
import type { TodoItem } from '@wrongstack/core/agent';
import type React from 'react';
import { Box, Text } from '../ink.js';
import { buildTodoPreviewRows } from './fleet-panel.js';
import { contextBarColor, fmtTok, renderMeter } from './status-bar-format.js';
import type { LiveSessionEntry } from './sessions-panel.js';
import { theme } from '../theme.js';

export interface SidebarContentProps {
  /** Live context window data from useStatusbarViewModel. */
  contextWindow: { used: number; max: number } | undefined;
  /** Fleet entries (leader + subagents) from useStatusbarViewModel. */
  entries: Record<string, FleetEntry>;
  /** Fleet counts summary. */
  fleetCounts:
    | { running: number; idle: number; pending: number; completed: number }
    | undefined;
  /** Current provider label for display. */
  provider?: string | undefined;
  /** Current model label for display. */
  model?: string | undefined;
  /** Actual sidebar width in columns (including border+padding chrome).
   *  Used to size the content area and truncate text appropriately. */
  width: number;
  /** Vertical scroll offset — number of rows scrolled from the top. */
  scrollOffset?: number | undefined;
  /** When true, the sidebar has keyboard focus (↑↓ scroll). */
  focused?: boolean | undefined;
  /** Live leader todo board — rendered as a compact mission queue. */
  todos?: readonly TodoItem[] | undefined;
  /** When true, show the agent-swarm + mission-queue section. Gated by
   *  resolveAgentSwarmPanelVisibility() from app-status-region.tsx. */
  showSwarmSection?: boolean | undefined;
  /** Live sessions from the SessionRegistry — same data as the F10 panel.
   *  Shown as compact "live" rows with project name + status + agent count. */
  liveSessions?: readonly LiveSessionEntry[] | undefined;
  /** Recent stored sessions for the `/resume` picker. Shown as compact rows
   *  with title + last-activity + outcome badge. */
  resumeSessions?: readonly ResumeSessionEntry[] | undefined;
  /** The current session ID — used to highlight the active session row. */
  currentSessionId?: string | undefined;
}

/** Truncate a string to fit within `max` display columns, adding an ellipsis. */
function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** Format a fleet entry's status as a compact colored glyph. */
function statusGlyph(entry: FleetEntry): { icon: string; color: string } {
  switch (entry.status) {
    case 'running':
      return { icon: '●', color: theme.accent };
    case 'idle':
      return { icon: '○', color: theme.textMuted };
    case 'success':
      return { icon: '✓', color: theme.success };
    case 'failed':
    case 'timeout':
    case 'stopped':
      return { icon: '✗', color: theme.error };
    default:
      return { icon: '?', color: theme.textMuted };
  }
}

/** Compact icon for a live session status. */
function liveSessionIcon(status: string): string {
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

/** Compact color for a live session status. */
function liveSessionColor(status: string): string {
  if (status === 'active' || status === 'running') return theme.success;
  if (status === 'idle') return theme.accent;
  if (status === 'error' || status === 'stale') return theme.error;
  if (status === 'closing') return theme.warn;
  return theme.textMuted;
}

/** Outcome badge for a resume session entry. */
function outcomeBadge(
  outcome: ResumeSessionEntry['outcome'],
): { label: string; color: string } | null {
  switch (outcome) {
    case 'completed':
      return { label: '✓', color: theme.success };
    case 'error':
      return { label: '✗', color: theme.error };
    case 'timeout':
      return { label: '⏱', color: theme.warn };
    case 'aborted':
      return { label: '⊘', color: theme.textMuted };
    default:
      return null;
  }
}

/** Short relative time like "3m", "2h", "1d". */
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

export function SidebarContent({
  contextWindow,
  entries,
  fleetCounts,
  provider,
  model,
  width,
  scrollOffset = 0,
  focused = false,
  todos,
  showSwarmSection = false,
  liveSessions,
  resumeSessions,
  currentSessionId,
}: SidebarContentProps): React.ReactElement {
  // Subtract border (2) + padding (2) = 4 cols of chrome to get content area
  const innerWidth = Math.max(8, width - 4);
  const meterWidth = Math.max(6, innerWidth - 8);

  // Context meter
  const ctxRatio = contextWindow
    ? Math.min(1, contextWindow.used / contextWindow.max)
    : 0;
  const ctxColor = contextBarColor(ctxRatio);

  // Fleet entries: show leader first, then running subagents.
  // Cap at 12 agents total (leader + up to 11 subagents), each rendered
  // as a 2-line row (name+ctx% on line 1, status+tool on line 2).
  const MAX_SIDEBAR_AGENTS = 12;
  const allEntries = Object.values(entries);
  const leader = allEntries.find(
    (e) => e.id === 'leader' || e.name === 'Leader Agent',
  );
  const subagents = allEntries.filter((e) => e !== leader);
  const runningSubagents = subagents.filter((e) => e.status === 'running');
  const agentCap = leader ? MAX_SIDEBAR_AGENTS - 1 : MAX_SIDEBAR_AGENTS;
  const shownAgents = [
    ...(leader ? [leader] : []),
    ...runningSubagents.slice(0, agentCap),
  ];
  const hiddenAgentCount = runningSubagents.length - agentCap;

  const running = fleetCounts?.running ?? runningSubagents.length;

  // Mission queue: only show when the swarm section is enabled and there
  // are todos to display. buildTodoPreviewRows is already width-parametric
  // and returns rows sorted by status priority (in_progress → pending →
  // completed). We cap to 3 rows to fit the narrow sidebar.
  const todoRows = showSwarmSection
    ? buildTodoPreviewRows(todos, innerWidth, 3)
    : [];

  return (
    <Box
      flexDirection="column"
      gap={0}
      marginTop={scrollOffset > 0 ? -scrollOffset : undefined}
    >
      {/* ── Focus indicator ── */}
      {focused ? (
        <Text color={theme.accent} dimColor>
          ↑↓ scroll · Shift+Tab unfocus
        </Text>
      ) : null}

      {/* ── Context meter ── */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={ctxColor}>
          Context
        </Text>
        {contextWindow ? (
          <>
            <Text>
              <Text color={ctxColor}>{renderMeter(ctxRatio, meterWidth)}</Text>
            </Text>
            <Text color={theme.textMuted} wrap="truncate">
              {fmtTok(contextWindow.used)}/{fmtTok(contextWindow.max)}
            </Text>
          </>
        ) : (
          <Text color={theme.textMuted}>—</Text>
        )}
      </Box>

      {/* ── Model ── */}
      {provider && model ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.tool}>
            Model
          </Text>
          <Text color={theme.textSecondary} wrap="truncate">
            {trunc(`${provider}/${model}`, innerWidth)}
          </Text>
        </Box>
      ) : null}

      {/* ── Fleet ── */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.assistant}>
          Fleet
        </Text>
        {running > 0 ? (
          <Text color={theme.accent}>
            ● {running} running
          </Text>
        ) : (
          <Text color={theme.textMuted}>○ idle</Text>
        )}
      </Box>

      {/* ── Agent rows (2-line format: name+ctx% / status+tool) ── */}
      {shownAgents.length > 0 ? (
        <Box flexDirection="column">
          {shownAgents.map((entry) => {
            const { icon, color } = statusGlyph(entry);
            const name = trunc(entry.name || entry.id, innerWidth - 6);
            const ctxPct =
              entry.ctxPct != null
                ? `${Math.round(entry.ctxPct * 100)}%`
                : '';
            const statusLabel = entry.status === 'running' ? 'running'
              : entry.status === 'idle' ? 'idle'
              : entry.status;
            const tool = entry.currentTool?.name
              ? trunc(entry.currentTool.name, innerWidth - statusLabel.length - 4)
              : '';
            return (
              <Box key={entry.id} flexDirection="column" marginBottom={0}>
                {/* Line 1: icon + name + ctx% */}
                <Box flexDirection="row">
                  <Text color={color}>{icon} </Text>
                  <Text color={theme.textSecondary} wrap="truncate">
                    {name}
                  </Text>
                  {ctxPct ? (
                    <Text color={ctxColor}> {ctxPct}</Text>
                  ) : null}
                </Box>
                {/* Line 2: status + current tool */}
                <Box flexDirection="row">
                  <Text color={color}>  </Text>
                  <Text color={theme.textMuted} wrap="truncate">
                    {statusLabel}{tool ? ` · ${tool}` : ''}
                  </Text>
                </Box>
              </Box>
            );
          })}
          {hiddenAgentCount > 0 ? (
            <Text color={theme.textMuted}> +{hiddenAgentCount} more</Text>
          ) : null}
        </Box>
      ) : null}

      {/* ── Mission Queue ── */}
      {todoRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.accent}>
            Mission Queue
          </Text>
          {todoRows.map((row) => (
            <Box key={row.id} flexDirection="row">
              <Text color={row.color}>{row.marker} </Text>
              <Text
                color={row.dim ? theme.textMuted : theme.textSecondary}
                wrap="truncate"
                {...(row.dim ? { dimColor: true } : {})}
              >
                {row.text}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}

      {/* ── Sessions ── */}
      {(liveSessions?.length ?? 0) > 0 || (resumeSessions?.length ?? 0) > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.accent}>
            Sessions
          </Text>

          {/* Live sessions (F10) */}
          {liveSessions && liveSessions.length > 0 ? (
            <Box flexDirection="column">
              {liveSessions.slice(0, 3).map((s) => {
                const isCurrent = s.sessionId === currentSessionId;
                const icon = isCurrent ? '●' : liveSessionIcon(s.status);
                const color = liveSessionColor(s.status);
                const name = trunc(s.projectName, innerWidth - 6);
                const agents =
                  s.agentCount > 0 ? ` ${s.agentCount}a` : '';
                return (
                  <Box key={s.sessionId} flexDirection="row">
                    <Text color={color}>{icon} </Text>
                    <Text
                      color={isCurrent ? theme.accent : theme.textSecondary}
                      wrap="truncate"
                      bold={isCurrent}
                    >
                      {name}
                    </Text>
                    <Text color={theme.textMuted}>{agents}</Text>
                  </Box>
                );
              })}
            </Box>
          ) : null}

          {/* Resume sessions (/resume) */}
          {resumeSessions && resumeSessions.length > 0 ? (
            <Box flexDirection="column" marginTop={liveSessions && liveSessions.length > 0 ? 1 : 0}>
              {resumeSessions.slice(0, 3).map((rs) => {
                const badge = outcomeBadge(rs.outcome);
                const title = trunc(
                  rs.title || rs.lastUserMessage || rs.id,
                  innerWidth - 8,
                );
                const rel = fmtRelative(rs.lastActivityAt ?? rs.endedAt);
                return (
                  <Box key={rs.id} flexDirection="row">
                    <Text color={badge ? badge.color : theme.textMuted}>
                      {badge ? badge.label : '·'}{' '}
                    </Text>
                    <Text
                      color={rs.isCurrent ? theme.accent : theme.textSecondary}
                      wrap="truncate"
                      {...(rs.isCurrent ? { bold: true } : {})}
                    >
                      {title}
                    </Text>
                    {rel ? (
                      <Text color={theme.textMuted}> {rel}</Text>
                    ) : null}
                  </Box>
                );
              })}
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
