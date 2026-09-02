import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import React from 'react';
import type { FleetEntry } from '../app.js';
import { theme } from '../theme.js';

interface LiveActivityStripProps {
  /** Per-subagent state from the FleetEntry table. */
  entries: Record<string, FleetEntry>;
  /** Re-renders every tick so elapsed timers stay live; otherwise the
   *  bar freezes between FleetEntry updates (which can be 30s+ apart
   *  if a subagent is parked in one tool). */
  nowTick: number;
  /** Optional cap on rows so a 20-subagent fleet doesn't push the
   *  input off-screen. Default 4 — matches the status bar's 4th line. */
  maxRows?: number | undefined;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}

function fmtRecentTool(tool: FleetEntry['recentTools'][number]): string {
  const status = tool.ok === false ? 'fail' : 'ok';
  const name = tool.name.length > 18 ? `${tool.name.slice(0, 17)}...` : tool.name;
  const parts = [status, name];
  if (typeof tool.durationMs === 'number') parts.push(fmtElapsed(tool.durationMs));
  if (typeof tool.outputBytes === 'number' && tool.outputBytes > 0)
    parts.push(fmtBytes(tool.outputBytes));
  if (typeof tool.outputLines === 'number' && tool.outputLines > 0)
    parts.push(`${tool.outputLines}L`);
  return parts.join(' ');
}

/** Single-line, no-wrap truncation to `width` columns with an ellipsis. */
function truncToWidth(s: string, width: number): string {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  if (width === 1) return '…';
  return `${s.slice(0, width - 1)}…`;
}

function formatRow(e: FleetEntry, now: number): string {
  const toolElapsed = e.currentTool ? now - e.currentTool.startedAt : 0;
  const taskElapsed = now - e.startedAt;
  const toolSeg = e.currentTool ? `→ ${e.currentTool.name} (${fmtElapsed(toolElapsed)})` : '·';
  const recentTools = (e.recentTools ?? []).slice(-2).map(fmtRecentTool).join(' | ');
  const head = `${e.name.slice(0, 14).padEnd(14)} · ${toolSeg} · ${e.iterations}it ${e.toolCalls}tc · ${fmtElapsed(taskElapsed)}`;
  return recentTools ? `${head} | last: ${recentTools}` : head;
}

/**
 * Build the fixed-height set of strip rows. ALWAYS returns exactly
 * `maxRows` strings, each already truncated to `width` columns (no wrap).
 *
 * This is the inline-mode contract every bottom live region in the TUI
 * must honor (see live-tail-fixed-height.test.ts): a region whose height
 * or visual-row count changes between renders scrolls the screen on every
 * update, and in inline mode each scroll strands the changed rows into
 * native scrollback — the "● Security Scanner …" line re-stamped dozens of
 * times per second when a fleet is busy. Constant height + hard truncation
 * keeps Ink's log-update clear-and-rewrite in lockstep with what's drawn,
 * so nothing leaks. The leading "● " bullet is rendered by the component
 * (colored), so these strings exclude it and are truncated to `width - 2`.
 */
export function activityStripRows(
  entries: Record<string, FleetEntry>,
  now: number,
  maxRows: number,
  width: number,
): string[] {
  const bodyWidth = Math.max(0, width - 2); // account for the "● " bullet
  const running = Object.values(entries)
    .filter((e) => e.status === 'running')
    // Stable order: oldest-started first, so the strip doesn't shuffle
    // every time a tool starts/ends on one of the rows.
    .sort((a, b) => a.startedAt - b.startedAt);

  const rows: string[] = [];
  const overflow = running.length > maxRows;
  // When more subagents run than fit, reserve the last row for the count.
  const shown = overflow ? running.slice(0, maxRows - 1) : running.slice(0, maxRows);
  for (const e of shown) rows.push(truncToWidth(formatRow(e, now), bodyWidth));
  if (overflow)
    rows.push(truncToWidth(`…+${running.length - (maxRows - 1)} more running`, bodyWidth));
  // Pad to a constant height so the region never grows/shrinks between renders.
  while (rows.length < maxRows) rows.push('');
  return rows;
}

/**
 * Compact strip that sits directly above the input area, one line per
 * running subagent. Renders at a CONSTANT height (`maxRows`) with every
 * row hard-truncated to the terminal width, so it can never bleed into
 * native scrollback in inline mode (see `activityStripRows`).
 *
 * Renders nothing only when the fleet table is completely empty (e.g.
 * after /clear), so the input sits flush against history during solo work.
 */
export const LiveActivityStrip = React.memo(function LiveActivityStrip({
  entries,
  nowTick,
  maxRows = 4,
}: LiveActivityStripProps): React.ReactElement | null {
  // paddingX={1} on the container eats 2 columns.
  const { columns } = useTerminalSize({ fallbackColumns: 80 });
  const width = Math.max(10, columns - 2);

  // When the fleet table is empty there's nothing to show, but we must
  // still render `maxRows` blank rows to keep the bottom region at a
  // constant height. Returning null would shrink the live region, and
  // Ink's log-update would bleed the reclaimed rows into scrollback —
  // the same class of bug as the enhance/todos input-height shift.
  void nowTick;
  const hasEntries = Object.keys(entries).length > 0;
  const rows = hasEntries
    ? activityStripRows(entries, Date.now(), maxRows, width)
    : new Array<string>(maxRows).fill('');

  return (
    <Box flexDirection="column" paddingX={1}>
      {rows.map((text, slot) => (
        <Box key={`strip-${slot}`} height={1}>
          {text === '' ? (
            <Text> </Text>
          ) : (
            <>
              <Text color={theme.accent}>● </Text>
              <Text dimColor wrap="truncate">
                {text}
              </Text>
            </>
          )}
        </Box>
      ))}
    </Box>
  );
});
