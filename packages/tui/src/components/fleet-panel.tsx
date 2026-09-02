import type { TodoItem } from '@wrongstack/core/agent';
import type React from 'react';
import type { FleetEntry } from '../app-state.js';
import { Box, Text } from '../ink.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { fmtRatioPct } from './status-bar-format.js';

interface FleetPanelProps {
  /** Per-subagent state, keyed by subagentId. */
  entries: Record<string, FleetEntry>;
  /** Fleet-wide accumulated cost (from FleetUsageAggregator). */
  totalCost: number;
  /** Optional roster for resolving role ids to display names. */
  roster?: Record<string, { name: string }> | undefined;
  /** Live leader todo board, rendered as a compact mission queue. */
  todos?: readonly TodoItem[] | undefined;
  /** 1s clock tick so activity meters and elapsed labels stay live. */
  nowTick?: number | undefined;
  /** When set, LEADER remains visible with a collab-session badge. */
  collabSession?: {
    sessionId: string | null;
    bugCount: number;
    planCount: number;
    evalCount: number;
  } | null;
  /** Optional column width cap (when rendered beside a sidebar). */
  maxWidth?: number | undefined;
}

type SwarmColor = 'blue' | 'cyan' | 'green' | 'gray' | 'red' | 'yellow';

interface SwarmCell {
  id: string;
  index: string;
  name: string;
  meter: string;
  activity: string;
  metrics: string;
  statusIcon: string;
  statusLabel: string;
  elapsed: string;
  color: SwarmColor;
  dim?: boolean | undefined;
}

interface SwarmGrid {
  columns: number;
  tileWidth: number;
  overflow: number;
  rows: SwarmCell[][];
}

interface TodoPreviewRow {
  id: string;
  marker: string;
  text: string;
  color: SwarmColor;
  dim?: boolean | undefined;
}

const METER_WIDTH = 7;
const CARD_GAP = 1;

function isLeaderEntry(entry: FleetEntry): boolean {
  return entry.id === 'leader' || entry.name === 'LEADER';
}

function statusVisual(entry: FleetEntry): {
  color: SwarmColor;
  icon: string;
  label: string;
  dim?: boolean;
} {
  if (entry.status === 'running' && entry.budgetWarning) {
    return { color: 'yellow', icon: glyphs.warning, label: 'PRESSURE' };
  }
  if (entry.status === 'running') {
    return { color: 'green', icon: '●', label: 'LIVE' };
  }
  if (entry.status === 'success') {
    return { color: 'green', icon: glyphs.success, label: 'DONE' };
  }
  if (entry.status === 'failed') {
    return { color: 'red', icon: glyphs.failure, label: 'FAILED' };
  }
  if (entry.status === 'timeout') {
    return { color: 'yellow', icon: glyphs.clock, label: 'TIMEOUT' };
  }
  if (entry.status === 'stopped') {
    return { color: 'gray', icon: '■', label: 'STOPPED', dim: true };
  }
  return { color: 'gray', icon: glyphs.idle, label: 'READY', dim: true };
}

function fmtShortDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function fmtCost(n: number): string {
  if (n <= 0) return '';
  return `$${n.toFixed(4)}`;
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

function displayName(
  entry: FleetEntry,
  roster: Record<string, { name: string }> | undefined,
): string {
  const rosterName = roster?.[entry.id]?.name;
  const name = rosterName || entry.name || entry.id;
  return normalizeInlineText(name) || entry.id.slice(0, 8);
}

export function activityText(entry: FleetEntry, now: number): string {
  if (entry.budgetWarning && entry.status === 'running') {
    const warning = entry.budgetWarning;
    return `extending ${warning.kind} ${warning.used}/${warning.limit}`;
  }
  if (entry.currentTool) {
    return `${glyphs.tools} ${entry.currentTool.name} · ${fmtShortDuration(now - entry.currentTool.startedAt)}`;
  }
  // Streaming text and message snippets removed for subagents — they caused
  // visual flicker as text deltas updated. Only tool calls are shown now;
  // empty string when there are none.
  const lastTool = entry.recentTools.at(-1);
  if (lastTool) {
    const marker = lastTool.ok === false ? glyphs.failure : glyphs.success;
    return `${marker} ${lastTool.name}`;
  }
  if (entry.status === 'running') return '';
  if (entry.status === 'idle') return 'waiting for a mission';
  if (entry.status === 'success') return 'mission complete';
  if (entry.status === 'timeout') return 'time budget reached';
  if (entry.status === 'stopped') return 'agent stopped';
  return entry.failureReason ? normalizeInlineText(entry.failureReason) : 'mission failed';
}

function elapsedText(entry: FleetEntry, now: number): string {
  const anchor =
    entry.status === 'running' ? entry.startedAt : entry.lastEventAt || entry.startedAt;
  return fmtShortDuration(Math.max(0, now - anchor));
}

function metricsText(entry: FleetEntry, tileWidth: number): string {
  const parts = [`${entry.iterations}i`, `${entry.toolCalls}t`];
  if (tileWidth >= 44 && entry.ctxPct !== undefined) {
    parts.push(`${fmtRatioPct(entry.ctxPct)} ctx`);
  }
  if (tileWidth >= 52 && entry.extensions) parts.push(`+${entry.extensions}x`);
  return parts.join(' · ');
}

export function swarmMeter(entry: FleetEntry, now: number, width = METER_WIDTH): string {
  if (width <= 0) return '';
  if (entry.status === 'success') return '█'.repeat(width);
  if (entry.status === 'failed' || entry.status === 'timeout' || entry.status === 'stopped') {
    return '■'.repeat(width);
  }
  if (entry.status === 'idle') return '░'.repeat(width);

  const elapsedBucket = Math.floor(Math.max(0, now - entry.startedAt) / 1000);
  const phase = (elapsedBucket + entry.iterations + entry.toolCalls) % width;
  const filled = Math.max(Math.min(width, 2), Math.min(width, phase + 1));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function swarmColumnCount(width: number): number {
  if (width < 54) return 1;
  return Math.max(1, Math.min(4, Math.floor(width / 38)));
}

export function selectSwarmEntries(
  entries: Record<string, FleetEntry>,
  _now: number,
  opts: { includeLeader?: boolean | undefined } = {},
): FleetEntry[] {
  return Object.values(entries)
    .filter((entry) => {
      if (isLeaderEntry(entry) && !opts.includeLeader) return false;
      if (isLeaderEntry(entry)) return true;
      return entry.status === 'running';
    })
    .sort((a, b) => {
      if (isLeaderEntry(a) !== isLeaderEntry(b)) return isLeaderEntry(a) ? -1 : 1;
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      return a.startedAt - b.startedAt;
    });
}

export function buildSwarmGrid(
  entries: Record<string, FleetEntry>,
  now: number,
  width: number,
  opts: {
    includeLeader?: boolean | undefined;
    maxRows?: number | undefined;
    roster?: Record<string, { name: string }> | undefined;
  } = {},
): SwarmGrid {
  const columns = swarmColumnCount(width);
  const gapWidth = Math.max(0, columns - 1) * CARD_GAP;
  const tileWidth = Math.max(26, Math.floor((Math.max(26, width) - gapWidth) / columns));
  const maxRows = opts.maxRows ?? 2;
  const maxCells = Math.max(1, columns * maxRows);
  const selected = selectSwarmEntries(entries, now, { includeLeader: opts.includeLeader });
  const hasOverflow = selected.length > maxCells;
  const shown = hasOverflow ? selected.slice(0, maxCells - 1) : selected.slice(0, maxCells);
  let subagentIndex = 0;
  const cells = shown.map<SwarmCell>((entry) => {
    const visual = statusVisual(entry);
    const metrics = metricsText(entry, tileWidth);
    const activityWidth = Math.max(4, tileWidth - METER_WIDTH - metrics.length - 6);
    const rawName = isLeaderEntry(entry) ? 'LEADER' : displayName(entry, opts.roster);
    const nameWidth = Math.max(5, tileWidth - visual.label.length - 13);
    if (!isLeaderEntry(entry)) subagentIndex += 1;
    return {
      id: entry.id,
      index: isLeaderEntry(entry) ? '00' : String(subagentIndex).padStart(2, '0'),
      name: truncToWidth(rawName, nameWidth),
      meter: swarmMeter(entry, now),
      activity: truncToWidth(activityText(entry, now), activityWidth),
      metrics,
      statusIcon: visual.icon,
      statusLabel: visual.label,
      elapsed: elapsedText(entry, now),
      color: visual.color,
      ...(visual.dim ? { dim: true } : {}),
    };
  });

  const overflow = selected.length - shown.length;
  if (overflow > 0) {
    cells.push({
      id: '__overflow',
      index: '++',
      name: `${overflow} MORE`,
      meter: '░'.repeat(METER_WIDTH),
      activity: 'Open the Agents monitor',
      metrics: 'F3',
      statusIcon: glyphs.peers,
      statusLabel: 'HIDDEN',
      elapsed: '',
      color: 'gray',
      dim: true,
    });
  }

  const rows: SwarmCell[][] = [];
  for (let i = 0; i < cells.length; i += columns) rows.push(cells.slice(i, i + columns));
  return { columns, tileWidth, overflow, rows };
}

export function buildTodoPreviewRows(
  todos: readonly TodoItem[] | undefined,
  width: number,
  maxRows = 2,
): TodoPreviewRow[] {
  if (!todos || todos.length === 0 || maxRows <= 0) return [];
  const ordered = [...todos].sort((a, b) => {
    const rank = (todo: TodoItem): number =>
      todo.status === 'in_progress' ? 0 : todo.status === 'pending' ? 1 : 2;
    return rank(a) - rank(b);
  });
  const shown = ordered.slice(0, maxRows);
  const textWidth = Math.max(4, width - 5);
  const rows = shown.map<TodoPreviewRow>((todo) => {
    const base = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
    const label = todo.blockedBy?.[0] ? `${base} — waiting on ${todo.blockedBy[0]}` : base;
    if (todo.status === 'completed') {
      return {
        id: todo.id,
        marker: glyphs.success,
        text: truncToWidth(label, textWidth),
        color: 'green',
        dim: true,
      };
    }
    if (todo.status === 'in_progress') {
      return {
        id: todo.id,
        marker: '●',
        text: truncToWidth(label, textWidth),
        color: 'cyan',
      };
    }
    return {
      id: todo.id,
      marker: glyphs.pending,
      text: truncToWidth(label, textWidth),
      color: 'gray',
    };
  });
  const overflow = ordered.length - shown.length;
  if (overflow > 0) {
    rows.push({
      id: '__todo_overflow',
      marker: '+',
      text: truncToWidth(`${overflow} more missions`, textWidth),
      color: 'gray',
      dim: true,
    });
  }
  return rows;
}

function SwarmCard({ cell, width }: { cell: SwarmCell; width: number }): React.ReactElement {
  return (
    <Box
      width={width}
      height={2}
      flexShrink={0}
      flexDirection="column"
      {...(theme.supportsBackground ? { backgroundColor: theme.surfaceRaised } : {})}
    >
      <Box height={1}>
        <Text color={cell.color}>▎</Text>
        <Text color={theme.textMuted}> {cell.index} </Text>
        <Text
          color={theme.textPrimary}
          bold={!cell.dim}
          {...(cell.dim ? { dimColor: true } : {})}
          wrap="truncate"
        >
          {cell.name}
        </Text>
        <Box flexGrow={1} />
        <Text color={cell.color} bold={!cell.dim}>
          {cell.statusIcon} {cell.statusLabel}
        </Text>
        {cell.elapsed ? <Text color={theme.textMuted}> {cell.elapsed}</Text> : null}
        <Text> </Text>
      </Box>
      <Box height={1}>
        <Text color={cell.color}>▎</Text>
        <Text> </Text>
        <Text color={cell.color}>{cell.meter}</Text>
        <Text color={theme.textMuted}> {cell.activity}</Text>
        <Box flexGrow={1} />
        <Text color={theme.textMuted}>{cell.metrics} </Text>
      </Box>
    </Box>
  );
}

/**
 * Always-visible mission-control view for active subagents. The detailed F3
 * monitor owns transcripts and drill-down; this panel stays compact and makes
 * the fleet's current shape readable at a glance.
 */
export function FleetPanel({
  entries,
  totalCost,
  roster,
  todos,
  nowTick,
  collabSession,
  maxWidth,
}: FleetPanelProps): React.ReactElement | null {
  const terminal = useTerminalSize({ maxWidth, fallbackColumns: 90 });

  const list = Object.values(entries);
  const leader = list.find(isLeaderEntry);
  const now = nowTick ?? Date.now();
  const hasCollab = !!collabSession;
  const contentWidth = Math.max(30, terminal.columns - 4);
  const includeLeader = hasCollab || leader?.status === 'running';
  const maxRows = terminal.rows >= 32 ? 3 : terminal.rows >= 20 ? 2 : 1;
  const grid = buildSwarmGrid(entries, now, contentWidth, {
    includeLeader,
    maxRows,
    roster,
  });
  const todoRows = buildTodoPreviewRows(
    todos,
    contentWidth,
    terminal.rows >= 26 ? 2 : terminal.rows >= 18 ? 1 : 0,
  );
  const hasSwarm = grid.rows.length > 0;
  if (!hasSwarm && todoRows.length === 0 && !hasCollab) return null;

  // LIVE counts every running agent, leader included — a lone leader working
  // should read as `● 1 LIVE`, not a gray `0`.
  const runningCount = list.filter((entry) => entry.status === 'running').length;
  const totalIterations = list.reduce((sum, entry) => sum + entry.iterations, 0);
  const totalTools = list.reduce((sum, entry) => sum + entry.toolCalls, 0);
  const todoCounts = (todos ?? []).reduce(
    (counts, todo) => {
      if (todo.status === 'in_progress') counts.active += 1;
      else if (todo.status === 'pending') counts.queued += 1;
      else counts.done += 1;
      return counts;
    },
    { active: 0, queued: 0, done: 0 },
  );
  const cost = fmtCost(totalCost);

  return (
    <Box
      alignSelf="stretch"
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.monitor.fleet}
      paddingX={1}
    >
      <Box height={1}>
        <Text color={theme.monitor.fleet} bold>
          {glyphs.fleet} AGENT SWARM
        </Text>
        {terminal.columns >= 60 ? <Text color={theme.textMuted}> / parallel workspace</Text> : null}
        <Box flexGrow={1} />
        <Text color={runningCount > 0 ? theme.success : theme.textMuted} bold={runningCount > 0}>
          {runningCount > 0 ? '●' : '○'} {runningCount} LIVE
        </Text>
        {terminal.columns >= 72 ? (
          <Text color={theme.textMuted}>
            {' '}
            {totalIterations}i · {totalTools}t
          </Text>
        ) : null}
        {cost && terminal.columns >= 88 ? <Text color={theme.success}> {cost}</Text> : null}
      </Box>

      {hasCollab && collabSession ? (
        <Box height={1}>
          <Text color={theme.monitor.agents}>{glyphs.bug} COLLAB</Text>
          <Text color={theme.textMuted}>
            {' '}
            {collabSession.bugCount} bugs · {collabSession.planCount} plans ·{' '}
            {collabSession.evalCount} reviews
          </Text>
          {collabSession.sessionId ? (
            <Text color={theme.textMuted}> · {truncToWidth(collabSession.sessionId, 12)}</Text>
          ) : null}
        </Box>
      ) : null}

      {grid.rows.map((row, rowIndex) => (
        <Box
          key={`swarm-row-${rowIndex}`}
          flexDirection="row"
          gap={CARD_GAP}
          height={2}
          marginTop={rowIndex === 0 ? 1 : 0}
        >
          {row.map((cell) => (
            <SwarmCard key={cell.id} cell={cell} width={grid.tileWidth} />
          ))}
        </Box>
      ))}

      {todoRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Box height={1}>
            <Text color={theme.accent} bold>
              {glyphs.goal} MISSION QUEUE
            </Text>
            {terminal.columns >= 56 ? (
              <Text color={theme.textMuted}>
                {'  '}
                {todoCounts.active} active · {todoCounts.queued} queued · {todoCounts.done} done
              </Text>
            ) : (
              <Text color={theme.textMuted}>
                {'  '}
                {todoCounts.active}/{todoCounts.queued}/{todoCounts.done}
              </Text>
            )}
            <Box flexGrow={1} />
            {terminal.columns >= 64 ? <Text color={theme.textMuted}>F3 details</Text> : null}
          </Box>
          {todoRows.map((row) => (
            <Box key={row.id} height={1}>
              <Text color={theme.textMuted}> ├─ </Text>
              <Text color={row.color}>{row.marker}</Text>
              <Text> </Text>
              <Text
                color={row.dim ? theme.textMuted : theme.textSecondary}
                {...(row.dim ? { dimColor: true } : {})}
                wrap="truncate"
              >
                {row.text}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
