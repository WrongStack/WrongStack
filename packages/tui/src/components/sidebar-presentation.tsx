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

import type { ContextBreakdown, TodoItem } from '@wrongstack/core/agent';
import type React from 'react';
import type { ResumeSessionEntry } from '../app-state.js';
import type { FleetEntry } from '../app-state-fleet.js';
import { Box, Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { contextBarColor, dialGlyph, sparkline } from './status-bar-format.js';

/** Truncate a string to fit within `max` display columns, adding an ellipsis. */
export function trunc(s: string, max: number): string {
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
export function statusGlyph(entry: FleetEntry): { icon: string; color: string } {
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
export function liveSessionIcon(status: string): string {
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
export function liveSessionColor(status: string): string {
  if (status === 'active' || status === 'running') return theme.success;
  if (status === 'idle') return theme.accent;
  if (status === 'error' || status === 'stale') return theme.error;
  // 'closing' and any unknown status fall through to theme.warn so a new
  // server-side status (e.g. 'paused', 'waking') never renders silently as
  // textMuted; it gets an attention-grabbing color instead.
  return theme.warn;
}

/** Outcome badge for a resume session entry. */
export function outcomeBadge(
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
export function fmtRelative(iso: string | undefined): string {
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
 * (Replaced by `SidebarSectionHeader` in `./sidebar-panel-frame.tsx`.)
 * Kept here as a doc-comment so anyone hunting for "the sidebar's section
 * header" lands on the right file. The local `SectionHeader` symbol was
 * promoted to the shared `sidebar-panel-frame.tsx` so routed panels and
 * persistent content cards use the same capsuled-pill component.
 */

/**
 * The `Card` component now lives in `./sidebar-card.tsx` as the shared
 * raised-surface iskelet used by both the persistent cards (this file) and
 * the routed F-key panel twins (`sidebar-panel-frame.tsx` +
 * `sidebar-panels-{workspace,task}.tsx`). Imported at the top of this file
 * for the `MODEL CORE`, `PROMPT CACHE`, `SYSTEM`, `AGENT SWARM`, `MISSIONS`,
 * and `SESSIONS` cards — the migration keeps the persistent
 * call sites identical because the shared component preserves the same
 * `innerWidth` / `marginBottom` / `accent` / `children` contract.
 */

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
          color: theme.brandPrimary,
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

export interface MissionRow {
  id: string;
  status: TodoItem['status'];
  label: string;
}

/** Sort + cap the todo board for the mission queue, plus done/total stats. */
export function buildMissionRows(
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
  // A blocked row is still `pending`, so without the reason on the label it
  // is indistinguishable from ready work. Appended rather than given its own
  // line: the sidebar cards run on a fixed row budget.
  const rows = shown.map<MissionRow>((t) => {
    const base = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    const blocker = t.blockedBy?.[0];
    return {
      id: t.id,
      status: t.status,
      label: blocker ? `${base} — waiting on ${blocker}` : base,
    };
  });
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
export function DialRow({
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
  const sparkW = innerWidth - displayWidth(label) - displayWidth(value) - 3;
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
          <Text color={color}>{spark}</Text>
        </>
      ) : null}
    </Box>
  );
}
