import type { TodoItem } from '@wrongstack/core';
import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';
import { useEffect, useState } from 'react';
import type { FleetEntry } from '../app.js';

export interface FleetPanelProps {
  /** Per-subagent state, keyed by subagentId. */
  entries: Record<string, FleetEntry>;
  /** Fleet-wide accumulated cost (from FleetUsageAggregator). */
  totalCost: number;
  /** Optional roster for resolving role ids to display names. */
  roster?: Record<string, { name: string }> | undefined;
  /** Live leader todo board, rendered as a compact preview below the swarm. */
  todos?: readonly TodoItem[] | undefined;
  /** 1s clock tick so activity meters and elapsed labels stay live. */
  nowTick?: number | undefined;
  /** When set, the LEADER row is always shown (even when idle) with a collab session indicator. */
  collabSession?: {
    sessionId: string | null;
    bugCount: number;
    planCount: number;
    evalCount: number;
  } | null;
}

type SwarmColor = 'blue' | 'cyan' | 'green' | 'gray' | 'red' | 'yellow';

export interface SwarmCell {
  id: string;
  index: string;
  meter: string;
  text: string;
  color: SwarmColor;
  dim?: boolean | undefined;
}

export interface SwarmGrid {
  columns: number;
  tileWidth: number;
  overflow: number;
  rows: SwarmCell[][];
}

export interface TodoPreviewRow {
  id: string;
  marker: string;
  text: string;
  color: SwarmColor;
  dim?: boolean | undefined;
}

const METER_WIDTH = 10;

function isLeaderEntry(entry: FleetEntry): boolean {
  return entry.id === 'leader' || entry.name === 'LEADER';
}

function statusColor(status: FleetEntry['status']): SwarmColor {
  if (status === 'running') return 'green';
  if (status === 'success') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'timeout') return 'yellow';
  if (status === 'stopped') return 'gray';
  return 'gray';
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

function activityText(entry: FleetEntry, now: number): string {
  if (entry.currentTool) {
    return `${entry.currentTool.name} ${fmtShortDuration(now - entry.currentTool.startedAt)}`;
  }
  const streaming = normalizeInlineText(entry.streamingText);
  if (entry.status === 'running' && streaming) return streaming;
  const lastMessage = entry.recentMessages.at(-1);
  if (lastMessage) return normalizeInlineText(lastMessage.text);
  const lastTool = entry.recentTools.at(-1);
  if (lastTool) {
    const ok = lastTool.ok === false ? 'failed' : 'done';
    return `${ok} ${lastTool.name}`;
  }
  if (entry.status === 'running') return 'thinking';
  if (entry.status === 'idle') return 'standing by';
  if (entry.status === 'success') return 'complete';
  if (entry.status === 'timeout') return 'timeout';
  if (entry.status === 'stopped') return 'stopped';
  return entry.failureReason ? `failed ${entry.failureReason}` : 'failed';
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
  return Math.max(1, Math.min(5, Math.floor(width / 38)));
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
      const rank = (entry: FleetEntry): number => {
        if (entry.status === 'running') return 0;
        return 1;
      };
      const ar = rank(a);
      const br = rank(b);
      if (ar !== br) return ar - br;
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
  const gapWidth = Math.max(0, columns - 1) * 2;
  const tileWidth = Math.max(24, Math.floor((Math.max(24, width) - gapWidth) / columns));
  const maxRows = opts.maxRows ?? 3;
  const maxCells = Math.max(1, columns * maxRows);
  const selected = selectSwarmEntries(entries, now, { includeLeader: opts.includeLeader });
  const hasOverflow = selected.length > maxCells;
  const shown = hasOverflow ? selected.slice(0, maxCells - 1) : selected.slice(0, maxCells);
  const bodyWidth = Math.max(6, tileWidth - 3 - 1 - (METER_WIDTH + 2) - 1);
  const cells = shown.map<SwarmCell>((entry, i) => {
    const name = displayName(entry, opts.roster);
    const label = `${name} · ${activityText(entry, now)}`;
    return {
      id: entry.id,
      index: String(i + 1).padStart(3, '0'),
      meter: swarmMeter(entry, now),
      text: truncToWidth(label, bodyWidth),
      color: statusColor(entry.status),
      dim: entry.status === 'idle',
    };
  });

  const overflow = selected.length - shown.length;
  if (overflow > 0) {
    cells.push({
      id: '__overflow',
      index: '+++',
      meter: '░'.repeat(METER_WIDTH),
      text: truncToWidth(`${overflow} more agents`, bodyWidth),
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
  maxRows = 5,
): TodoPreviewRow[] {
  if (!todos || todos.length === 0 || maxRows <= 0) return [];
  const ordered = [...todos].sort((a, b) => {
    const rank = (t: TodoItem): number =>
      t.status === 'in_progress' ? 0 : t.status === 'pending' ? 1 : 2;
    return rank(a) - rank(b);
  });
  const shown = ordered.slice(0, maxRows);
  const textWidth = Math.max(4, width - 5);
  const rows = shown.map<TodoPreviewRow>((todo) => {
    const label = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
    if (todo.status === 'completed') {
      return {
        id: todo.id,
        marker: '✓',
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
        color: 'blue',
      };
    }
    return {
      id: todo.id,
      marker: '○',
      text: truncToWidth(label, textWidth),
      color: 'gray',
    };
  });
  const overflow = ordered.length - shown.length;
  if (overflow > 0) {
    rows.push({
      id: '__todo_overflow',
      marker: '+',
      text: truncToWidth(`${overflow} more`, textWidth),
      color: 'gray',
      dim: true,
    });
  }
  return rows;
}

/**
 * Compact fleet summary rendered below the status bar when subagents are
 * active. It is intentionally separate from the F2/F3 monitors: this is the
 * always-visible "what is the fleet doing right now?" strip, while those
 * panels remain the detailed drill-down surfaces.
 */
export function FleetPanel({
  entries,
  totalCost,
  roster,
  todos,
  nowTick,
  collabSession,
}: FleetPanelProps): React.ReactElement | null {
  // Track terminal width to adapt name truncation.
  const { stdout } = useStdout();
  const [termWidth, setTermWidth] = useState(stdout?.columns ?? 90);
  useEffect(() => {
    const handleResize = () => setTermWidth(stdout?.columns ?? 90);
    handleResize();
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout]);

  const list = Object.values(entries);
  const leader = list.find((e) => e.id === 'leader');
  const subagents = list.filter((e) => !isLeaderEntry(e));
  const hasCollab = !!collabSession;
  const now = nowTick ?? Date.now();
  const contentWidth = Math.max(40, termWidth - 2);
  const includeLeader = hasCollab || leader?.status === 'running';
  const grid = buildSwarmGrid(entries, now, contentWidth, {
    includeLeader,
    maxRows: termWidth >= 120 ? 3 : 4,
    roster,
  });
  const todoRows = buildTodoPreviewRows(todos, contentWidth, 5);
  const hasSwarm = grid.rows.length > 0;
  if (!hasSwarm && todoRows.length === 0 && !hasCollab) return null;

  const runningCount = subagents.filter((e) => e.status === 'running').length;

  const summaryBits = [
    runningCount > 0 ? `${runningCount} running` : '',
    fmtCost(totalCost),
  ].filter(Boolean);
  const collabLabel =
    hasCollab && collabSession.sessionId
      ? `collab ${collabSession.bugCount}b/${collabSession.planCount}p/${collabSession.evalCount}e`
      : '';
  if (collabLabel) summaryBits.push(collabLabel);
  const summary = summaryBits.join(' · ');
  const title = ` Agent Swarm${summary ? ` - ${summary}` : ''} `;
  const header = `─${truncToWidth(title, Math.max(10, contentWidth - 1)).padEnd(contentWidth - 1, '─')}`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box height={1}>
        <Text color="blue">{header}</Text>
      </Box>

      {grid.rows.map((row, rowIndex) => (
        <Box key={`swarm-row-${rowIndex}`} flexDirection="row" gap={2} height={1}>
          {row.map((cell) => (
            <Box key={cell.id} width={grid.tileWidth} flexShrink={0}>
              <Text color="blue">{cell.index}</Text>
              <Text dimColor> [</Text>
              <Text color={cell.color}>{cell.meter}</Text>
              <Text dimColor>] </Text>
              <Text color={cell.color} {...(cell.dim ? { dimColor: true } : {})} wrap="truncate">
                {cell.text}
              </Text>
            </Box>
          ))}
        </Box>
      ))}

      {todoRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="blue">Todo</Text>
          {todoRows.map((row) => (
            <Box key={row.id} height={1}>
              <Text color={row.color}>{row.marker}</Text>
              <Text> </Text>
              <Text color={row.color} {...(row.dim ? { dimColor: true } : {})} wrap="truncate">
                {row.text}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
