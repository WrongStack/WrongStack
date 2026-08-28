/**
 * tool-group — Consecutive same-tool entries grouped under a single header.
 *
 * Instead of rendering N separate tool cards for N consecutive `read` (or
 * `bash`, `grep`, …) calls, this module collapses them into one visual group:
 *
 *     ╭─ ◆ read ×5  ·  0.5s
 *     │ [1] path/to/a.ts  …
 *     │ [2] path/to/b.tsx …
 *     │ …
 *     ╰──────────────────────────────────────────
 *
 * The group header carries a count badge and aggregated stats; each sub-entry
 * keeps its own arg preview, output, diff, and timing. Non-tool entries and
 * isolated tool entries pass through unchanged.
 */

import type React from 'react';
import { memo } from 'react';
import { Box, Text } from '../../ink.js';
import {
  displayWidth,
  sanitizeTerminalText,
  truncateDisplay,
  truncateDisplayStart,
} from '../../terminal-width.js';
import { theme } from '../../theme.js';
import { getToolVisual } from '../../tool-glyph.js';
import { glyphs } from '../../ui-glyphs.js';
import { DIFF_MAX_LINES, MULTI_DIFF_MAX_ROWS } from './code-block.js';
import type { HistoryEntry } from './types.js';
import { formatToolArgs, parseSageMemoryLine, resolveEntrySage } from './utils.js';

// ── Types ──

export interface ToolGroupData {
  /** Shared tool name (e.g. "read", "bash", "grep"). */
  name: string;
  /** Consecutive tool entries with the same name. */
  entries: HistoryEntry[];
  /** Aggregate duration across the group. */
  totalDurationMs: number;
  /** Count of successful calls. */
  okCount: number;
  /** Count of failed calls. */
  failCount: number;
}

export type RenderGroup =
  | { type: 'single'; entry: HistoryEntry }
  | { type: 'tool-group'; data: ToolGroupData };

// ── Grouping utility ──

/**
 * Hard ceiling for one rendered tool group. A group is a virtualization unit,
 * so allowing an arbitrarily long same-tool run (for example 400 consecutive
 * reads) would mount the whole run on every streaming redraw and defeat the
 * bounded history window.
 */
const MAX_TOOL_GROUP_ENTRIES = 12;

/**
 * These tools render structured, potentially multi-row diff output through
 * `Entry` (e.g. `● Update(path)` / `● Write(path)` + stats + diff body).
 * Compacting them would discard that output and its configured multi-file
 * summary threshold — keep each call as its own history entry.
 */
const STRUCTURED_DIFF_TOOLS = new Set(['edit', 'write', 'replace', 'diff', 'patch']);

function hasInjectedMemory(entry: HistoryEntry & { kind: 'tool' }): boolean {
  return resolveEntrySage(entry.output, entry.sageLines).sageLines.length > 0;
}

/** Stable id used by the height cache and React keys for a render group. */
export function renderGroupId(group: RenderGroup): number {
  return group.type === 'tool-group' ? (group.data.entries[0]?.id ?? 0) : group.entry.id;
}

const MAX_TEXT_ESTIMATE_ROWS = 200;

/**
 * Estimate wrapped terminal rows without allocating `text.split('\n')` for a
 * potentially large retained entry. Scanning stops once the caller's cap is
 * reached, so estimation work and the resulting virtual extent stay bounded.
 */
function estimateTextRows(text: string, contentWidth: number, maxRows: number): number {
  if (!text) return 1;
  const safeText = sanitizeTerminalText(text);
  const width = Math.max(1, contentWidth);
  let rows = 0;
  let lineStart = 0;
  for (let index = 0; index < safeText.length; index++) {
    if (safeText[index] === '\n') {
      rows += Math.max(1, Math.ceil(displayWidth(safeText.slice(lineStart, index)) / width));
      if (rows >= maxRows) return maxRows;
      lineStart = index + 1;
    }
  }
  rows += Math.max(1, Math.ceil(displayWidth(safeText.slice(lineStart)) / width));
  return Math.min(maxRows, Math.max(1, rows));
}

/** Conservative, bounded row estimate used before a group is measured. */
export function estimateRenderGroupRows(
  group: RenderGroup,
  contentWidth: number,
  showSageMemoryInject?: boolean,
): number {
  if (group.type === 'tool-group') return group.data.entries.length + 2;

  const { entry } = group;
  if (entry.kind === 'tool') {
    const { cleanOutput, sageLines } = resolveEntrySage(entry.output, entry.sageLines);
    const memoryLines = sageLines.slice(1);
    // When sage inject is hidden, skip the panel entirely in height estimation.
    // The bordered panel renders one header row plus one row per memory with
    // the body wrapped to `panelContentWidth`. The compact chip path only
    // accounts for the single header row; we don't enter it from here.
    const panelContentWidth = Math.max(1, contentWidth - 4);
    // Bordered panel shape: top border (1) + header (1) + per-memory rows
    // [label (1) + body wrapped + kv wrapped (≥1)] + bottom border (1).
    // For a single memory at narrow widths this lands well above the
    // previous chip-only estimate; the actual Ink frame can additionally
    // inherit +1 row when a flex-wrap KV cell is the only one on its line,
    // which the height-cache absorbs within the test tolerance.
    const sagePanelRows =
      showSageMemoryInject === false || memoryLines.length === 0
        ? 0
        : 4 +
          memoryLines.reduce((sum, line) => {
            const parsed = parseSageMemoryLine(line);
            // `parseSageMemoryLine` returns null on malformed lines; the
            // renderer falls back to a single literal line in that case.
            // Here we wrap the raw line so the estimator matches.
            const bodySource = parsed ? parsed.text : line;
            const bodyWidth = displayWidth(sanitizeTerminalText(bodySource));
            const bodyRows = Math.max(1, Math.ceil(bodyWidth / panelContentWidth));
            // KV row is a flex-wrap of id/anchor/relation/tags; at
            // comfortable widths it fits on one line, at narrow widths it
            // wraps further. We model one row by default and add an extra
            // row whenever the panel is narrow enough that the labels
            // stack vertically with the body.
            const kvRows = panelContentWidth < 48 ? 2 : 1;
            return sum + 1 + bodyRows + kvRows;
          }, 0);
    if (entry.resultRenderMode === 'simple') return 3 + sagePanelRows;
    if (STRUCTURED_DIFF_TOOLS.has(entry.name)) {
      const previewCap =
        entry.name === 'replace' || entry.name === 'diff' || entry.name === 'patch'
          ? MULTI_DIFF_MAX_ROWS
          : DIFF_MAX_LINES;
      const previewRows = estimateTextRows(cleanOutput, contentWidth - 8, previewCap);
      // Tool header + stats/path chrome + a possible hidden-lines footer.
      return Math.min(previewCap + 3, previewRows + 3) + sagePanelRows;
    }
    return 3 + sagePanelRows;
  }

  let text = '';
  switch (entry.kind) {
    case 'user':
      text = `${entry.text}${entry.pasteContent ? `\n${entry.pasteContent}` : ''}`;
      break;
    case 'assistant':
    case 'thinking':
    case 'info':
    case 'warn':
    case 'error':
    case 'turn-summary':
    case 'subagent':
      text = entry.text;
      break;
    default:
      return entry.kind === 'banner' ? 12 : 4;
  }
  // marginBottom on the wrapper Box in scrollable-history.tsx adds 1 row
  // for turn-summary entries, so the estimate must match.
  const marginAdjustment = entry.kind === 'turn-summary' ? 1 : 0;
  return Math.min(
    MAX_TEXT_ESTIMATE_ROWS + 2 + marginAdjustment,
    estimateTextRows(text, contentWidth - 4, MAX_TEXT_ESTIMATE_ROWS) + 2 + marginAdjustment,
  );
}

/**
 * Walk entries and merge consecutive same-tool entries into bounded groups.
 * Non-tool entries and isolated tool entries (no consecutive sibling)
 * remain as individual items.
 */
export function groupEntries(entries: readonly HistoryEntry[]): RenderGroup[] {
  const result: RenderGroup[] = [];
  let buffer: HistoryEntry[] = [];
  let currentName = '';

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      result.push({ type: 'single', entry: buffer[0]! });
    } else {
      let totalDurationMs = 0;
      let okCount = 0;
      let failCount = 0;
      for (const e of buffer) {
        if (e.kind === 'tool') {
          totalDurationMs += e.durationMs ?? 0;
          if (e.ok) okCount++;
          else failCount++;
        }
      }
      result.push({
        type: 'tool-group',
        data: { name: currentName, entries: buffer, totalDurationMs, okCount, failCount },
      });
    }
    buffer = [];
    currentName = '';
  };

  for (const entry of entries) {
    const containsInjectedMemory = entry.kind === 'tool' && hasInjectedMemory(entry);
    if (
      entry.kind === 'tool' &&
      !STRUCTURED_DIFF_TOOLS.has(entry.name) &&
      !containsInjectedMemory
    ) {
      if (currentName !== entry.name) {
        flush();
        currentName = entry.name;
      }
      buffer.push(entry);
      if (buffer.length === MAX_TOOL_GROUP_ENTRIES) flush();
    } else {
      flush();
      result.push({ type: 'single', entry });
    }
  }
  flush();
  return result;
}

// ── Group renderer ──

/**
 * Compact group header rendered once for N consecutive same-tool calls.
 * Shows tool glyph, count badge, fail tally (when any), and total duration.
 * Per-call ok/fail lives on each sub-entry row — not as a leading status mark.
 */
function ToolGroupHeader({
  name,
  totalDurationMs,
  failCount,
  totalCount,
  termWidth,
}: {
  name: string;
  totalDurationMs: number;
  failCount: number;
  totalCount: number;
  termWidth: number;
}): React.ReactElement {
  const { glyph, color } = getToolVisual(name);
  const allOk = failCount === 0;
  const meta = `${totalDurationMs}ms`;
  const safeName = sanitizeTerminalText(name);
  const visibleName = truncateDisplay(safeName, Math.max(1, termWidth - 16));
  const fixedHeader = `${glyph} ${visibleName}`;
  const tailBudget = Math.max(0, termWidth - displayWidth(fixedHeader) - 10);
  const metaBudget = meta ? Math.min(displayWidth(meta), Math.floor(tailBudget * 0.36)) : 0;
  const railColor = allOk ? theme.borderSubtle : theme.error;
  const countLabel = `×${totalCount}`;

  return (
    <Box flexDirection="column" marginY={0}>
      <Text>
        <Text color={railColor}>╭─ </Text>
        <Text color={color}>{glyph}</Text>
        <Text> </Text>
        <Text bold color={theme.textPrimary}>
          {visibleName}
        </Text>
        <Text> </Text>
        <Text bold color={theme.textSecondary}>
          {countLabel}
        </Text>
        {metaBudget >= 2 ? <Text color={theme.textMuted}>{`  ·  ${meta}`}</Text> : null}
        {failCount > 0 ? <Text color={theme.error}>{`  ✗${failCount}`}</Text> : null}
      </Text>
    </Box>
  );
}

/**
 * Render a group of consecutive same-tool entries.
 *
 * Layout:
 *   ╭─ ◆ read ×5  ·  0.5s
 *   │ [1] path/to/a.ts  ·  12ms
 *   │     (output preview…)
 *   │ [2] path/to/b.tsx  ·  8ms
 *   │     (output preview…)
 *   ╰──────────────────────────────────────
 *
 * Each sub-entry is rendered as a compact list item with its index,
 * arg summary, timing, and a single-line output preview.
 */
function ToolGroupImpl({
  data,
  termWidth,
}: {
  data: ToolGroupData;
  termWidth: number;
}): React.ReactElement {
  const { name, entries, totalDurationMs, okCount: _okCount, failCount } = data;
  const railColor = failCount === 0 ? theme.borderSubtle : theme.error;
  const toolContentWidth = Math.max(1, termWidth - 2);

  return (
    <Box flexDirection="column" marginY={0}>
      <ToolGroupHeader
        name={name}
        totalDurationMs={totalDurationMs}
        failCount={failCount}
        totalCount={entries.length}
        termWidth={termWidth}
      />
      <Box
        flexDirection="column"
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={railColor}
        paddingLeft={1}
      >
        {entries.map((entry, idx) => {
          if (entry.kind !== 'tool') return null;
          return (
            <ToolGroupItem
              key={entry.id}
              entry={entry}
              index={idx + 1}
              contentWidth={toolContentWidth}
            />
          );
        })}
      </Box>
      <Text color={railColor}>{`╰${'─'.repeat(Math.max(2, termWidth - 1))}`}</Text>
    </Box>
  );
}

/**
 * One sub-entry inside a tool group.
 *
 * Rendered as a single, gapless row: ok/fail mark, numbered index, the arg
 * summary (typically the file path or target), and compact timing/size meta.
 * No per-tool glyph — the group header already carries the shared tool's
 * glyph. The arg is truncated so the whole entry stays on one line — no
 * separate output-preview row and no blank spacer between items.
 */
function ToolGroupItem({
  entry,
  index,
  contentWidth,
}: {
  entry: HistoryEntry & { kind: 'tool' };
  index: number;
  contentWidth: number;
}): React.ReactElement {
  const statusMark = entry.ok ? glyphs.success : glyphs.failure;
  const statusColor = entry.ok ? theme.success : theme.error;
  const metaParts: string[] = [];
  if (entry.durationMs != null) metaParts.push(`${entry.durationMs}ms`);
  if (entry.outputLines != null && entry.outputLines > 0) metaParts.push(`${entry.outputLines} L`);
  if (entry.outputBytes != null && entry.outputBytes > 0) {
    const bytes = entry.outputBytes;
    metaParts.push(bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);
  }
  const metaStr = metaParts.length > 0 ? metaParts.join(' · ') : '';

  // Reserve room for the fixed prefix (mark, "#NN ") and the trailing meta so
  // the arg never wraps the row onto a second line. The per-tool glyph is
  // omitted here — every row shares the group's tool, whose glyph is already in
  // the group header, so repeating it per row is redundant.
  const prefixWidth = 4 + String(index).length;
  const metaWidth = metaStr ? displayWidth(metaStr) + 5 : 0;
  const argBudget = Math.max(1, contentWidth - prefixWidth - metaWidth);
  const rawArg = sanitizeTerminalText(formatToolArgs(entry.name, entry.input));
  const argPreview = truncateDisplayStart(rawArg, argBudget);

  return (
    <Text>
      <Text bold color={statusColor}>
        {statusMark}
      </Text>
      <Text dimColor>{` #${index}`}</Text>
      {argPreview ? (
        <>
          <Text> </Text>
          <Text color={theme.textSecondary}>{argPreview}</Text>
        </>
      ) : null}
      {metaStr ? <Text dimColor>{`  ·  ${metaStr}`}</Text> : null}
    </Text>
  );
}

/**
 * One render group of compacted tool calls.
 *
 * Memoized: `data` comes from the `useMemo`d `groupEntries` result in
 * ScrollableHistory and `termWidth` is memoized beside it, so every group
 * except the one actually changing bails out of each streaming frame.
 */
export const ToolGroup = memo(ToolGroupImpl);
