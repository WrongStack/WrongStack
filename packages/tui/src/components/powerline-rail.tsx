import type React from 'react';
import { isValidElement } from 'react';
import { Box, Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';

export function visibleNodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleNodeText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode; text?: unknown };
    if (props.children !== undefined) return visibleNodeText(props.children);
    if (typeof props.text === 'string') return props.text;
    // Function components carry neither `children` nor `text`, so they used
    // to measure as 0 columns — a BrainChip or EternalStageChip on the rail
    // made the frame overflow the budget by the chip's full rendered width
    // (row 3 wrapped, the measured bottom region grew a row, and the
    // viewport cropped the top history line one commit later). Chips in
    // status-bar-chips.tsx are hook-free pure functions by construction, so
    // invoking them yields the exact tree the renderer will produce.
    // Anything that does throw (a future hook-using chip) falls back to the
    // old 0-column measurement instead of crashing the rail — such a chip
    // should expose a `text` prop like ThinkingChip does.
    const type = node.type as unknown;
    if (
      typeof type === 'function' &&
      !(type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent
    ) {
      try {
        return visibleNodeText((type as (p: unknown) => React.ReactNode)(node.props));
      } catch {
        return '';
      }
    }
    return '';
  }
  return '';
}

/** Columns between two adjacent chips on a rail. */
export const RAIL_SEP_COST = 2;

export interface RailSpanEntry {
  /** Stable identifier used by the mouse hit-test ('model', 'todos', …). */
  id: string;
  /** Widest rendering of the chip (density level 0). */
  node: React.ReactElement;
  /**
   * Narrower renderings, widest → narrowest, EXCLUDING {@link node}. A chip
   * with `alt: [short, micro]` has three levels: 0 = node, 1 = short,
   * 2 = micro. The fitter degrades a chip through these before it will drop
   * any chip from the rail.
   */
  alt?: React.ReactElement[] | undefined;
  /** Widest level the fitter may use (density pin). Defaults to 0. */
  lo?: number | undefined;
  /** Narrowest level the fitter may use (density pin). Defaults to the last. */
  hi?: number | undefined;
}

export interface RailSpan {
  id: string;
  /** 0-based start column within the rail's row. */
  start: number;
  /** Rendered width in columns. */
  len: number;
  /** Density level actually rendered (0 = widest). */
  level: number;
}

export interface RailLayoutItem extends RailSpan {
  node: React.ReactElement;
}

export interface RailLayout {
  /** Chips that survive, in render order, with their resolved columns. */
  items: RailLayoutItem[];
  /** Ids the fitter had to drop entirely (rendered as the `+N` marker). */
  droppedIds: string[];
  /** Whether the right-anchored chip fits and will be drawn. */
  rightVisible: boolean;
  /** Filler columns between the last left chip and the right anchor. */
  gap: number;
  /** Columns the rail actually consumes (left chips + separators + anchor). */
  used: number;
}

function markerWidth(dropped: number): number {
  return dropped > 0 ? 2 + String(dropped).length : 0;
}

interface Measured {
  id: string;
  nodes: React.ReactElement[];
  widths: number[];
  lo: number;
  hi: number;
  level: number;
}

function measure(entry: RailSpanEntry): Measured {
  const nodes = [entry.node, ...(entry.alt ?? [])];
  const last = nodes.length - 1;
  const lo = Math.min(Math.max(0, entry.lo ?? 0), last);
  const hi = Math.min(Math.max(lo, entry.hi ?? last), last);
  return {
    id: entry.id,
    nodes,
    widths: nodes.map((node) => displayWidth(visibleNodeText(node))),
    lo,
    hi,
    level: lo,
  };
}

/**
 * Fit a rail into `budget` columns.
 *
 * The order of concessions is deliberate and is the whole point of the
 * density system: **shorten before you drop**. A rail first degrades chips
 * one level at a time — always the chip that gives back the most columns, so
 * a 92-column telemetry composite collapses long before a 5-column
 * `⚠ -7` disappears — and only starts dropping trailing chips once every
 * chip is already at its narrowest permitted level. A chip with a pinned
 * density (`lo === hi`) never degrades; it can only be dropped.
 *
 * Both {@link PowerlineRail} and {@link computeRailSpans} consume this, so
 * the mouse hit-test can never drift from what is drawn.
 */
export function layoutRail(
  entries: readonly RailSpanEntry[],
  budget: number,
  rightAnchor?: React.ReactElement | null,
): RailLayout {
  const chips = entries.map(measure);
  const rightWidth = rightAnchor ? displayWidth(visibleNodeText(rightAnchor)) : 0;
  let rightVisible = rightAnchor != null;
  let keep = chips.length;

  const leftWidth = (): number => {
    let total = 0;
    for (let i = 0; i < keep; i++) total += chips[i]!.widths[chips[i]!.level]!;
    return total + Math.max(0, keep - 1) * RAIL_SEP_COST;
  };
  const total = (): number => {
    const dropped = chips.length - keep;
    const anchor = rightVisible ? (keep > 0 ? RAIL_SEP_COST : 0) + rightWidth : 0;
    return leftWidth() + anchor + markerWidth(dropped);
  };

  // 1. Degrade widest-first. Each pass concedes the single largest column
  //    saving available, which keeps the rail's information density even:
  //    no chip is squeezed to `micro` while a fatter neighbour stays `full`.
  while (total() > budget) {
    let best = -1;
    let bestGain = 0;
    for (let i = 0; i < keep; i++) {
      const chip = chips[i]!;
      if (chip.level >= chip.hi) continue;
      const gain = chip.widths[chip.level]! - chip.widths[chip.level + 1]!;
      // `>=` so ties resolve to the later chip: the tail concedes first,
      // matching the drop order in step 2.
      if (gain > 0 && gain >= bestGain) {
        best = i;
        bestGain = gain;
      }
    }
    if (best === -1) break;
    chips[best]!.level += 1;
  }

  // 2. Drop trailing chips. Leading chips are the ones the mouse spans and
  //    the reader's eye both assume, so the tail always goes first.
  while (keep > 1 && total() > budget) keep -= 1;

  // 3. Last resort: hide the right anchor rather than render a single
  //    orphaned left chip beside it.
  if (rightVisible && total() > budget) {
    rightVisible = false;
    while (keep > 1 && total() > budget) keep -= 1;
  }

  const items: RailLayoutItem[] = [];
  let col = 0;
  for (let i = 0; i < keep; i++) {
    const chip = chips[i]!;
    if (i > 0) col += RAIL_SEP_COST;
    items.push({
      id: chip.id,
      start: col,
      len: chip.widths[chip.level]!,
      level: chip.level,
      node: chip.nodes[chip.level]!,
    });
    col += chip.widths[chip.level]!;
  }

  const droppedIds = chips.slice(keep).map((chip) => chip.id);
  const used = total();
  const gap = rightVisible ? Math.max(0, budget - used) : 0;
  return { items, droppedIds, rightVisible, gap, used };
}

/**
 * 0-based column spans of the segments PowerlineRail will actually keep.
 * A thin projection of {@link layoutRail} — the status-bar mouse hit-test
 * consumes this so click targets are derived from the SAME nodes the
 * renderer draws.
 */
export function computeRailSpans(
  entries: readonly RailSpanEntry[],
  budget: number,
  rightAnchor?: React.ReactElement | null,
): RailSpan[] {
  return layoutRail(entries, budget, rightAnchor).items.map(({ id, start, len, level }) => ({
    id,
    start,
    len,
    level,
  }));
}

interface PowerlineRailProps {
  /** Chips in render order. Plain elements are treated as single-level chips. */
  segments: Array<React.ReactElement | RailSpanEntry>;
  budget: number;
  monochrome?: boolean | undefined;
  /** Override the filler background for per-line tonal layering. */
  fillBg?: string | undefined;
  /**
   * Optional right-anchored segment. When provided, the rail reserves
   * space for this segment at the right edge of the budget so its
   * position is independent of how wide the left segments are —
   * preventing visual jitter when the left side updates frequently.
   */
  rightAnchor?: React.ReactElement | null | undefined;
}

function toEntries(segments: PowerlineRailProps['segments']): RailSpanEntry[] {
  return segments.map((segment, index) =>
    isValidElement(segment) ? { id: `seg-${index}`, node: segment } : (segment as RailSpanEntry),
  );
}

/**
 * Full-width status segments with a single uniform background.
 * No per-chip backgrounds, no transition glyphs, no segment caps —
 * just clean chips separated by a single space.
 */
export function PowerlineRail({
  segments,
  budget,
  monochrome = false,
  fillBg,
  rightAnchor,
}: PowerlineRailProps): React.ReactElement {
  // Empty line: render just the filler background so the row still has the
  // correct layered tone and keeps the layout height stable.
  if (segments.length === 0 && !rightAnchor) {
    if (monochrome || !fillBg) return <Text> </Text>;
    return (
      <Box backgroundColor={fillBg}>
        <Text> </Text>
      </Box>
    );
  }

  const layout = layoutRail(toEntries(segments), budget, rightAnchor);
  const dropped = layout.droppedIds.length;

  const content = (
    <Text>
      {layout.items.map((item, index) => (
        <Text key={item.id}>
          {index > 0 ? '  ' : null}
          {item.node}
        </Text>
      ))}
      {layout.rightVisible && rightAnchor ? (
        <Text>
          {layout.items.length > 0 ? '  ' : null}
          {layout.gap > 0 ? ' '.repeat(layout.gap) : null}
          {rightAnchor}
        </Text>
      ) : null}
      {dropped > 0 ? <Text color={theme.textMuted}>{` +${dropped}`}</Text> : null}
    </Text>
  );

  if (monochrome) return content;

  return <Box backgroundColor={fillBg ?? theme.surface}>{content}</Box>;
}
