// Compact sidebar content — a layered, color-coded mission-control rail.
//
// Designed for the narrow RightSidebar region (~20-48 columns). Each section
// is a "card" with a glyph header, a dotted leader line, and a right-aligned
// status badge. Shows, top to bottom:
//   1. Context — big % badge + full-width block meter + token count
//   2. Model — provider/model identity line
//   3. Agent Swarm — LIVE badge, composition summary, per-agent 2-line rows
//   4. Mission Queue — a longer todo board (up to 8 rows) with done/total badge
//   5. Sessions — live sessions (F10) + recent resume sessions (/resume)
//
// All data is passed as props — this component is pure presentation with no
// hooks, no event listeners, no keyboard input. It fits inside the sidebar
// shell (components/sidebar.tsx).
//
// Width contract: every section box is exactly `innerWidth` columns wide so
// dotted-leader fills and block meters line up. Row counts deliberately mirror
// computeMaxSidebarScroll() in reducers/workspace-panels.ts — keep the two in
// sync when changing the layout.

import type { TodoItem } from '@wrongstack/core/agent';
import type { ContextBreakdown } from '@wrongstack/core/utils';
import type React from 'react';
import type { ResumeSessionEntry } from '../app-state.js';
import type { FleetEntry } from '../app-state-fleet.js';
import type { HeapSample } from '../heap-watchdog.js';
import { Box, Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { pastel, theme } from '../theme.js';
import { SIDEBAR_MISSION_ROWS } from '../ui-contracts.js';
import { glyphs } from '../ui-glyphs.js';
import type { LiveSessionEntry } from './sessions-panel.js';
import {
  blockMeter,
  contextBarColor,
  dialGlyph,
  fmtMemory,
  fmtTok,
  sparkline,
} from './status-bar-format.js';

export interface SidebarContentProps {
  /** Live context window data from useStatusbarViewModel. */
  contextWindow: { used: number; max: number } | undefined;
  /** Honest per-category accounting behind the context window display. */
  contextBreakdown?: ContextBreakdown | undefined;
  /** Fleet entries (leader + subagents) from useStatusbarViewModel. */
  entries: Record<string, FleetEntry>;
  /** Fleet counts summary. */
  fleetCounts: { running: number; idle: number; pending: number; completed: number } | undefined;
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
  /** When true, show the agent-swarm + mission-queue section. Gated by the
   *  effective agent-swarm panel mode being 'sidebar' (see app-view.tsx). */
  showSwarmSection?: boolean | undefined;
  /** Live sessions from the SessionRegistry — same data as the F10 panel.
   *  Shown as compact "live" rows with project name + status + agent count. */
  liveSessions?: readonly LiveSessionEntry[] | undefined;
  /** Recent stored sessions for the `/resume` picker. Shown as compact rows
   *  with title + last-activity + outcome badge. */
  resumeSessions?: readonly ResumeSessionEntry[] | undefined;
  /** The current session ID — used to highlight the active session row. */
  currentSessionId?: string | undefined;
  /** Current RSS/heap sample for this CLI process. */
  processMemory?: HeapSample | undefined;
  /** CPU usage percentage (0-100). Derived from process.cpuUsage delta. */
  cpuPercent?: number | undefined;
  /** Recent CPU ratios (0-1, oldest → newest) for the trend sparkline. */
  cpuHistory?: readonly number[] | undefined;
  /** Recent RSS/totalMem ratios (0-1) for the trend sparkline. */
  rssHistory?: readonly number[] | undefined;
  /** Recent heap-pressure ratios (0-1) for the trend sparkline. */
  heapHistory?: readonly number[] | undefined;
  /** Total physical RAM in bytes — denominator of the RAM ratio. */
  totalMem?: number | undefined;
}

/** Truncate a string to fit within `max` display columns, adding an ellipsis. */
function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Normalized "is this session row the current session?" predicate used by
 * both the `SidebarContent` SESSIONS card (live + resume rows) and the
 * `SessionsPanelSidebar` (sidebar twin). The runtime `currentSessionId`
 * is the authoritative source — when defined, the row whose id matches
 * is the current row. When undefined (e.g. before the host registers a
 * session), the per-row `isCurrent` flag is the fallback (carried over
 * from the resume-picker domain for the case where the picker marks
 * the current session as non-resumable but the host hasn't published
 * the runtime id yet). A row without an id can never be the current
 * row, regardless of what its fallback flag says. The two SESSIONS
 * rows used to disagree on which key to read (live used strict id
 * compare, resume used `rs.isCurrent` first); this helper is the
 * single source of truth.
 */
export function isCurrentSession(
  rowId: string | undefined,
  currentSessionId: string | undefined,
  fallbackIsCurrent?: boolean | undefined,
): boolean {
  // A row without an id can never be the current row, regardless of
  // what its fallback flag says. This guards the (rowId=undefined,
  // fallbackIsCurrent=true) edge case from highlighting a no-id row.
  if (rowId === undefined) return false;
  if (currentSessionId !== undefined) {
    return rowId === currentSessionId;
  }
  return fallbackIsCurrent === true;
}

/** Format a fleet entry's status as a compact colored glyph. */
function statusGlyph(entry: FleetEntry): { icon: string; color: string } {
  switch (entry.status) {
    case 'running':
      return { icon: glyphs.running, color: theme.success };
    case 'idle':
      return { icon: glyphs.idle, color: theme.textMuted };
    case 'success':
      return { icon: glyphs.success, color: theme.success };
    case 'failed':
    case 'timeout':
    case 'stopped':
      return { icon: glyphs.failure, color: theme.error };
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
  // 'closing' and any unknown status fall through to theme.warn so a new
  // server-side status (e.g. 'paused', 'waking') never renders silently as
  // textMuted; it gets an attention-grabbing color instead.
  return theme.warn;
}

/** Outcome badge for a resume session entry. */
function outcomeBadge(
  outcome: ResumeSessionEntry['outcome'],
): { label: string; color: string } | null {
  switch (outcome) {
    case 'completed':
      return { label: glyphs.success, color: theme.success };
    case 'error':
      return { label: glyphs.failure, color: theme.error };
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

/**
 * A section header: colored glyph + bold uppercase label, a dotted leader
 * filling the remaining width, and an optional right-aligned badge. Always
 * renders exactly one row of exactly `innerWidth` columns — the badge is
 * dropped gracefully when there is no room (narrow terminals).
 */
function SectionHeader({
  glyph,
  label,
  color,
  badge,
  badgeColor,
  innerWidth,
}: {
  glyph: string;
  label: string;
  color: string;
  badge?: string | undefined;
  badgeColor?: string | undefined;
  innerWidth: number;
}): React.ReactElement {
  const left = `${glyph} ${label}`;
  const leftW = displayWidth(left);
  const badgeW = badge ? displayWidth(badge) + 1 : 0;
  const fitsBadge = !!badge && innerWidth - leftW - badgeW >= 0;
  const fillCount = Math.max(0, innerWidth - leftW - (fitsBadge ? badgeW : 0));
  return (
    <Box>
      <Text color={color} bold>
        {left}
      </Text>
      <Text color={theme.borderSubtle}>{'·'.repeat(fillCount)}</Text>
      {fitsBadge ? (
        <Text color={badgeColor ?? color} bold>
          {' '}
          {badge}
        </Text>
      ) : null}
    </Box>
  );
}

/** A raised "card" wrapper. On truecolor terminals it gets a subtle lifted
 *  surface so sections read as stacked panels; otherwise it is a plain box. */
function Card({
  innerWidth,
  marginBottom = 1,
  children,
}: {
  innerWidth: number;
  marginBottom?: number | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={innerWidth}
      marginBottom={marginBottom}
      {...(theme.supportsBackground ? { backgroundColor: theme.surfaceRaised } : {})}
    >
      {children}
    </Box>
  );
}

interface ContextSegment {
  label: string;
  shortLabel: string;
  tokens: number;
  color: string;
  glyph: string;
}

export function contextSpectrum(
  breakdown: ContextBreakdown | undefined,
  contextWindow: { used: number; max: number } | undefined,
  width: number,
): Array<ContextSegment & { cells: number }> {
  if (!contextWindow || width <= 0) return [];
  const max = Math.max(1, contextWindow.max);
  const used = Math.min(max, Math.max(0, contextWindow.used));
  const measured = breakdown
    ? [
        {
          label: 'System',
          shortLabel: 'SYS',
          tokens: breakdown.system.total,
          color: pastel.peach,
          glyph: '◆',
        },
        {
          label: 'Tools',
          shortLabel: 'TLS',
          tokens: breakdown.tools.total,
          color: theme.accent,
          glyph: '◇',
        },
        {
          label: 'History',
          shortLabel: 'HST',
          tokens: breakdown.history.total,
          color: theme.brand,
          glyph: '●',
        },
        {
          label: 'Volatile',
          shortLabel: 'VOL',
          tokens: breakdown.volatile.total,
          color: theme.warn,
          glyph: '◈',
        },
      ]
    : [
        {
          label: 'Used',
          shortLabel: 'USE',
          tokens: used,
          color: contextBarColor(used / max),
          glyph: '●',
        },
      ];
  const measuredTotal = measured.reduce((sum, segment) => sum + segment.tokens, 0);
  const scale = measuredTotal > used && measuredTotal > 0 ? used / measuredTotal : 1;
  const normalized = measured.map((segment) => ({
    ...segment,
    tokens: Math.max(0, Math.round(segment.tokens * scale)),
  }));
  const normalizedTotal = normalized.reduce((sum, segment) => sum + segment.tokens, 0);
  if (normalizedTotal < used) {
    normalized.push({
      label: 'Other',
      shortLabel: 'DELTA',
      tokens: used - normalizedTotal,
      color: theme.textSecondary,
      glyph: '△',
    });
  }
  normalized.push({
    label: 'Free',
    shortLabel: 'FREE',
    tokens: Math.max(0, max - used),
    color: theme.borderDefault,
    glyph: '·',
  });
  const spectrumTotal = Math.max(
    1,
    normalized.reduce((sum, segment) => sum + segment.tokens, 0),
  );
  const rawCells = normalized.map((segment) => (segment.tokens / spectrumTotal) * width);
  const cells = rawCells.map(Math.floor);
  let remainder = Math.max(0, width - cells.reduce((sum, count) => sum + count, 0));
  const order = rawCells
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const item of order) {
    if (remainder <= 0) break;
    cells[item.index] = (cells[item.index] ?? 0) + 1;
    remainder--;
  }
  return normalized.map((segment, index) => ({ ...segment, cells: cells[index] ?? 0 }));
}

interface MissionRow {
  id: string;
  status: TodoItem['status'];
  label: string;
}

/** Sort + cap the todo board for the mission queue, plus done/total stats. */
function buildMissionRows(
  todos: readonly TodoItem[] | undefined,
  maxRows: number,
): { rows: MissionRow[]; overflow: number; done: number; total: number } {
  const list = todos ?? [];
  const total = list.length;
  const done = list.filter((t) => t.status === 'completed').length;
  if (total === 0 || maxRows <= 0) return { rows: [], overflow: 0, done, total };
  const rank = (t: TodoItem): number =>
    t.status === 'in_progress' ? 0 : t.status === 'pending' ? 1 : 2;
  const ordered = [...list].sort((a, b) => rank(a) - rank(b));
  const shown = ordered.slice(0, maxRows);
  // Labels pass through unmodified — Ink wraps them onto multiple lines within
  // the row's column width when the sidebar is narrow, so the full todo
  // content stays visible. Vertical overflow is owned by RightSidebar's
  // overflowY="hidden" viewport (and the scroll-controlled SidebarContent).
  const rows = shown.map<MissionRow>((t) => ({
    id: t.id,
    status: t.status,
    label: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content,
  }));
  return { rows, overflow: ordered.length - shown.length, done, total };
}

/**
 * A labeled system-vitals row: morphing dial glyph + right-aligned trend
 * sparkline. Replaces the old block meter — still exactly one row per
 * metric, so the SYSTEM card keeps its 5-row budget in
 * computeMaxSidebarScroll(). The dial and value are colored by the *current*
 * load via contextBarColor; the sparkline traces the recent history in the
 * same heat color (latest sample at the right edge).
 */
function DialRow({
  label,
  value,
  ratio,
  history,
  innerWidth,
}: {
  label: string;
  value: string;
  ratio: number;
  history?: readonly number[] | undefined;
  innerWidth: number;
}): React.ReactElement {
  const color = contextBarColor(ratio);
  // Fixed chrome: label, dial, value, 3 single-space separators, and one gap
  // before the right-aligned sparkline. Every remaining column is a sparkline
  // cell; below 3 cells the sparkline is dropped (narrowest sidebars still
  // get dial + value).
  const sparkW = innerWidth - displayWidth(label) - displayWidth(value) - 4;
  const spark = sparkW >= 3 ? sparkline(history ?? [], sparkW) : '';
  return (
    <Box flexDirection="row" width={innerWidth}>
      <Text color={theme.textSecondary} bold>
        {label}
      </Text>
      <Text> </Text>
      <Text color={color}>{dialGlyph(ratio)}</Text>
      <Text> </Text>
      <Text color={color} bold>
        {value}
      </Text>
      {spark ? (
        <>
          <Box flexGrow={1} />
          <Text> </Text>
          <Text color={color}>{spark}</Text>
        </>
      ) : null}
    </Box>
  );
}

export function SidebarContent({
  contextWindow,
  contextBreakdown,
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
  processMemory,
  cpuPercent,
  cpuHistory,
  rssHistory,
  heapHistory,
  totalMem,
}: SidebarContentProps): React.ReactElement {
  // Subtract border (2) + padding (2) = 4 cols of chrome to get content area
  const innerWidth = Math.max(8, width - 4);

  // Context meter
  const ctxRatio = contextWindow ? Math.min(1, contextWindow.used / contextWindow.max) : 0;
  const ctxColor = contextBarColor(ctxRatio);
  const ctxPct = Math.round(ctxRatio * 100);
  const meter = blockMeter(ctxRatio, innerWidth);
  const spectrum = contextSpectrum(contextBreakdown, contextWindow, innerWidth);
  const modelIdentity = provider && model ? `${provider}/${model}` : (model ?? provider);

  // Fleet entries: show leader first, then running subagents.
  // Cap at 12 agents total (leader + up to 11 subagents), each rendered
  // as a 2-line row (name+ctx% on line 1, status+tool on line 2).
  const MAX_SIDEBAR_AGENTS = 12;
  const allEntries = Object.values(entries);
  const leader = allEntries.find((e) => e.id === 'leader' || e.name === 'Leader Agent');
  const subagents = allEntries.filter((e) => e !== leader);
  const runningSubagents = subagents.filter((e) => e.status === 'running');
  const agentCap = leader ? MAX_SIDEBAR_AGENTS - 1 : MAX_SIDEBAR_AGENTS;
  const shownAgents = [...(leader ? [leader] : []), ...runningSubagents.slice(0, agentCap)];
  const hiddenAgentCount = runningSubagents.length - agentCap;

  const running = fleetCounts?.running ?? runningSubagents.length;

  // Mission queue — a longer board than the bottom swarm panel. Sorted by
  // status priority (in_progress → pending → completed), capped at
  // SIDEBAR_MISSION_ROWS. Only populated when the swarm section is enabled.
  const mission = showSwarmSection
    ? buildMissionRows(todos, SIDEBAR_MISSION_ROWS)
    : { rows: [] as MissionRow[], overflow: 0, done: 0, total: 0 };

  return (
    <Box flexDirection="column" gap={0} marginTop={scrollOffset > 0 ? -scrollOffset : undefined}>
      {/* ── Focus indicator ── */}
      {focused ? (
        <Box width={innerWidth} marginBottom={1}>
          <Text color={theme.accent} bold>
            ↑↓
          </Text>
          <Text color={theme.textMuted}> scroll · Shift+Tab exits</Text>
        </Box>
      ) : null}

      {/* ── Model + context hero: the statusbar identity, elevated into a stage. ── */}
      <Card innerWidth={innerWidth}>
        <Box width={innerWidth}>
          <Text color={theme.accent} bold>
            ╼╼
          </Text>
          <Text color={theme.brand} bold>
            {' '}
            MODEL CORE{' '}
          </Text>
          <Text color={theme.accent} bold>
            {'╾'.repeat(Math.max(0, innerWidth - 14))}
          </Text>
        </Box>
        {modelIdentity ? (
          <Box flexDirection="column">
            <Text color={theme.textMuted} wrap="truncate">
              {provider
                ? `◈ ${trunc(provider.toUpperCase(), Math.max(1, innerWidth - 2))}`
                : '◈ ACTIVE'}
            </Text>
            <Text color={theme.textPrimary} bold wrap="truncate">
              {trunc(modelIdentity, innerWidth)}
            </Text>
          </Box>
        ) : null}
        <Box width={innerWidth}>
          <Text color={ctxColor} bold>
            {contextWindow ? `${String(ctxPct).padStart(3, '0')}%` : ' — '}
          </Text>
          <Text color={theme.textMuted}>{innerWidth >= 18 ? ' CONTEXT LOAD' : ' CTX LOAD'}</Text>
        </Box>
        {contextWindow ? (
          <>
            <Box>
              <Text color={ctxColor}>{meter.filled}</Text>
              <Text color={theme.borderSubtle}>{meter.empty}</Text>
            </Box>
            <Box width={innerWidth}>
              {spectrum.map((segment) => (
                <Text key={segment.shortLabel} color={segment.color}>
                  {(segment.shortLabel === 'FREE' ? '·' : '━').repeat(segment.cells)}
                </Text>
              ))}
            </Box>
            <Text color={theme.textMuted} wrap="truncate">
              {fmtTok(contextWindow.used)} / {fmtTok(contextWindow.max)} tokens
            </Text>
            {spectrum.map((segment) => {
              if (segment.shortLabel === 'FREE' && segment.tokens <= 0) return null;
              const pct = Math.round((segment.tokens / Math.max(1, contextWindow.max)) * 100);
              return (
                <Box key={segment.shortLabel} width={innerWidth}>
                  <Text color={segment.color}>
                    {segment.glyph} {segment.shortLabel}
                  </Text>
                  <Box flexGrow={1} />
                  <Text color={theme.textSecondary}>{fmtTok(segment.tokens)}</Text>
                  <Text color={theme.textMuted}> {pct}%</Text>
                </Box>
              );
            })}
          </>
        ) : (
          <Text color={theme.textMuted}>awaiting context telemetry</Text>
        )}
      </Card>

      {/* ── System vitals: CPU, RAM, heap — relocated from the statusline ── */}
      {processMemory || cpuPercent != null ? (
        <Card innerWidth={innerWidth}>
          <SectionHeader
            glyph={glyphs.cpu}
            label="SYSTEM"
            color={theme.textSecondary}
            badge={cpuPercent != null ? `${cpuPercent.toFixed(0)}%` : undefined}
            badgeColor={cpuPercent != null ? contextBarColor(cpuPercent / 100) : undefined}
            innerWidth={innerWidth}
          />
          {cpuPercent != null ? (
            <DialRow
              label="CPU"
              value={`${cpuPercent.toFixed(0)}%`}
              ratio={cpuPercent / 100}
              history={cpuHistory}
              innerWidth={innerWidth}
            />
          ) : null}
          {processMemory ? (
            <>
              <DialRow
                label="RAM"
                value={fmtMemory(processMemory.rss)}
                // RSS is the process's whole resident set — ratio it against
                // physical RAM, not the V8 heap limit (HeapSample.load).
                ratio={
                  totalMem && totalMem > 0
                    ? Math.min(1, processMemory.rss / totalMem)
                    : processMemory.load
                }
                history={rssHistory}
                innerWidth={innerWidth}
              />
              <DialRow
                label="HEAP"
                value={fmtMemory(processMemory.heapUsed)}
                ratio={processMemory.load}
                history={heapHistory}
                innerWidth={innerWidth}
              />
            </>
          ) : null}
        </Card>
      ) : null}

      {/* ── Agent Swarm: one gated, raised surface for summary + rows ── */}
      {showSwarmSection ? (
        <Card innerWidth={innerWidth}>
          <SectionHeader
            glyph={glyphs.fleet}
            label="AGENT SWARM"
            color={theme.monitor.fleet}
            badge={running > 0 ? `${running} LIVE` : 'IDLE'}
            badgeColor={running > 0 ? theme.success : theme.textMuted}
            innerWidth={innerWidth}
          />
          <Box>
            <Text color={running > 0 ? theme.success : theme.textMuted}>▎</Text>
            <Text color={running > 0 ? theme.textSecondary : theme.textMuted} wrap="truncate">
              {running > 0 ? ` ${running} running` : ' idle'}
            </Text>
          </Box>
          {shownAgents.map((entry) => {
            const { icon, color } = statusGlyph(entry);
            const isRunning = entry.status === 'running';
            const name = trunc(entry.name || entry.id, innerWidth - 8);
            const ctxPctAgent = entry.ctxPct != null ? `${Math.round(entry.ctxPct * 100)}%` : '';
            const statusLabel =
              entry.status === 'running'
                ? 'running'
                : entry.status === 'idle'
                  ? 'idle'
                  : entry.status;
            const tool = entry.currentTool?.name
              ? trunc(entry.currentTool.name, innerWidth - statusLabel.length - 6)
              : '';
            return (
              <Box key={entry.id} flexDirection="column">
                {/* Line 1: accent rail + identity + context telemetry. */}
                <Box flexDirection="row">
                  <Text color={color}>▎</Text>
                  <Text color={color}> {icon} </Text>
                  <Text
                    color={isRunning ? theme.textPrimary : theme.textSecondary}
                    bold={isRunning}
                    wrap="truncate"
                  >
                    {name}
                  </Text>
                  <Box flexGrow={1} />
                  {ctxPctAgent ? (
                    <Text color={contextBarColor(entry.ctxPct ?? 0)}>{ctxPctAgent}</Text>
                  ) : null}
                </Box>
                {/* Line 2: status + current tool, aligned beneath identity. */}
                <Box flexDirection="row">
                  <Text color={color}>▎</Text>
                  <Text color={theme.textMuted} wrap="truncate">
                    {'   '}
                    {statusLabel}
                    {tool ? ` · ${tool}` : ''}
                  </Text>
                </Box>
              </Box>
            );
          })}
          {hiddenAgentCount > 0 ? (
            <Text color={theme.textMuted}>▎ +{hiddenAgentCount} more</Text>
          ) : null}
        </Card>
      ) : null}

      {/* ── Mission Queue card (longer board than the bottom panel) ── */}
      {mission.total > 0 ? (
        <Card innerWidth={innerWidth}>
          <SectionHeader
            glyph={glyphs.queue}
            label="MISSIONS"
            color={theme.warn}
            badge={`${mission.done}/${mission.total}`}
            badgeColor={mission.done === mission.total ? theme.success : theme.warn}
            innerWidth={innerWidth}
          />
          {mission.rows.map((m) => {
            if (m.status === 'completed') {
              return (
                <Box key={m.id} width={innerWidth} flexDirection="row">
                  <Text color={theme.success}>{glyphs.success} </Text>
                  <Text color={theme.textMuted} dimColor strikethrough>
                    {m.label}
                  </Text>
                </Box>
              );
            }
            if (m.status === 'in_progress') {
              return (
                <Box key={m.id} width={innerWidth} flexDirection="row">
                  <Text color={theme.accent}>{glyphs.running} </Text>
                  <Text color={theme.textPrimary} bold>
                    {m.label}
                  </Text>
                </Box>
              );
            }
            return (
              <Box key={m.id} width={innerWidth} flexDirection="row">
                <Text color={theme.textMuted}>{glyphs.pending} </Text>
                <Text color={theme.textSecondary}>{m.label}</Text>
              </Box>
            );
          })}
          {mission.overflow > 0 ? (
            <Text color={theme.textMuted} dimColor>
              {'  '}+{mission.overflow} more
            </Text>
          ) : null}
        </Card>
      ) : null}

      {/* ── Sessions card ── */}
      {(liveSessions?.length ?? 0) > 0 || (resumeSessions?.length ?? 0) > 0 ? (
        <Card innerWidth={innerWidth} marginBottom={0}>
          <SectionHeader
            glyph={glyphs.sessions}
            label="SESSIONS"
            color={theme.success}
            badge={String((liveSessions?.length ?? 0) + (resumeSessions?.length ?? 0))}
            badgeColor={theme.textSecondary}
            innerWidth={innerWidth}
          />

          {/* Live sessions (F10) */}
          {liveSessions && liveSessions.length > 0 ? (
            <Box flexDirection="column">
              {liveSessions.slice(0, 3).map((s) => {
                const isCurrent = isCurrentSession(s.sessionId, currentSessionId);
                const icon = isCurrent ? '●' : liveSessionIcon(s.status);
                const color = liveSessionColor(s.status);
                const name = trunc(s.projectName, innerWidth - 6);
                const agents = s.agentCount > 0 ? ` ${s.agentCount}a` : '';
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
                const isCurrent = isCurrentSession(rs.id, currentSessionId, rs.isCurrent);
                const badge = outcomeBadge(rs.outcome);
                const title = trunc(rs.title || rs.lastUserMessage || rs.id, innerWidth - 8);
                const rel = fmtRelative(rs.lastActivityAt ?? rs.endedAt);
                return (
                  <Box key={rs.id} flexDirection="row">
                    <Text color={badge ? badge.color : theme.textMuted}>
                      {badge ? badge.label : '·'}{' '}
                    </Text>
                    <Text
                      color={isCurrent ? theme.accent : theme.textSecondary}
                      wrap="truncate"
                      bold={isCurrent}
                    >
                      {title}
                    </Text>
                    {rel ? <Text color={theme.textMuted}> {rel}</Text> : null}
                  </Box>
                );
              })}
            </Box>
          ) : null}
        </Card>
      ) : null}
    </Box>
  );
}
