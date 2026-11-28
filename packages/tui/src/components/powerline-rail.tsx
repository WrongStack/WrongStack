import type React from 'react';
import { isValidElement } from 'react';
import { Text } from '../ink.js';
import { statuslineBackgrounds } from '../statusline-palette.js';
import { displayWidth, truncateDisplay } from '../terminal-width.js';
import { type Theme, theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';

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

/**
 * Columns between adjacent chip payloads: one transition glyph plus one
 * padding cell on each side of the incoming payload.
 */
export const RAIL_SEP_COST = 3;

/** Start cap + left/right payload padding owned by the first chip. */
const RAIL_FIRST_CHROME_COST = 3;
/** End cap after the final chip (and optional omission marker). */
const RAIL_END_CAP_COST = 1;

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
  /** Omission count painted after the last left-hand chip. */
  omissionCount: number;
  /** Whether the reserved priority-tail chip fits and will be drawn. */
  rightVisible: boolean;
  /** Reserved for layout consumers; connected tails use no filler gap. */
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
 * Both {@link PowerlineRail} and the status bar's click-map builder consume
 * this layout, so the mouse hit-test can never drift from what is drawn.
 */
export function layoutRail(
  entries: readonly RailSpanEntry[],
  budget: number,
  rightAnchor?: React.ReactElement | null,
  showOmissions = true,
): RailLayout {
  const chips = entries.map(measure);
  const rightWidth = rightAnchor ? displayWidth(visibleNodeText(rightAnchor)) : 0;
  let rightVisible = rightAnchor != null;
  let keep = chips.length;

  const leftWidth = (): number => {
    let total = 0;
    for (let i = 0; i < keep; i++) total += chips[i]!.widths[chips[i]!.level]!;
    if (keep === 0) return 0;
    return (
      total + RAIL_FIRST_CHROME_COST + Math.max(0, keep - 1) * RAIL_SEP_COST + RAIL_END_CAP_COST
    );
  };
  const total = (): number => {
    const dropped = chips.length - keep;
    const anchor = rightVisible
      ? rightWidth + RAIL_SEP_COST + (keep === 0 ? RAIL_END_CAP_COST : 0)
      : 0;
    return leftWidth() + anchor + markerWidth(showOmissions && keep > 0 ? dropped : 0);
  };

  // 1. Degrade widest-first. Each pass concedes the single largest column
  //    saving available, which keeps the rail's information density even:
  //    no chip is squeezed to `micro` while a fatter neighbour stays `full`.
  while (total() > budget) {
    let best = -1;
    let bestGain = 0;
    let nextLevel = 0;
    for (let i = 0; i < keep; i++) {
      const chip = chips[i]!;
      let level = chip.level + 1;
      while (level <= chip.hi && chip.widths[level]! >= chip.widths[chip.level]!) level++;
      if (level > chip.hi) continue;
      const gain = chip.widths[chip.level]! - chip.widths[level]!;
      // `>=` so ties resolve to the later chip: the tail concedes first,
      // matching the drop order in step 2.
      if (gain > 0 && gain >= bestGain) {
        best = i;
        bestGain = gain;
        nextLevel = level;
      }
    }
    if (best === -1) break;
    chips[best]!.level = nextLevel;
  }

  // 2. Drop trailing chips. Leading chips are the ones the mouse spans and
  //    the reader's eye both assume, so the tail always goes first.
  while (keep > 1 && total() > budget) keep -= 1;

  // 3. Last resort: hide the right anchor rather than render a single
  //    orphaned left chip beside it.
  if (rightVisible && total() > budget) {
    rightVisible = false;
    keep = chips.length;
    while (keep > 1 && total() > budget) keep -= 1;
  }

  // 4. A chip still too wide at its narrowest level is cut to the room left.
  //    Ink would otherwise wrap its tail, the `+N` marker and the end cap onto
  //    a second row — in a narrow pane that pushes the composer up a line.
  if (keep > 0 && total() > budget) {
    const last = chips[keep - 1]!;
    const room = last.widths[last.level]! - (total() - budget);
    if (room >= 1) {
      const cut = truncateDisplay(visibleNodeText(last.nodes[last.level]!), room);
      last.nodes[last.level] = <Text>{cut}</Text>;
      last.widths[last.level] = displayWidth(cut);
    } else {
      keep = 0;
    }
  }

  const items: RailLayoutItem[] = [];
  let col = 0;
  for (let i = 0; i < keep; i++) {
    const chip = chips[i]!;
    const chrome = i === 0 ? RAIL_FIRST_CHROME_COST : RAIL_SEP_COST;
    items.push({
      id: chip.id,
      start: col,
      len: chrome + chip.widths[chip.level]!,
      level: chip.level,
      node: chip.nodes[chip.level]!,
    });
    col += chrome + chip.widths[chip.level]!;
  }

  const droppedIds = chips.slice(keep).map((chip) => chip.id);
  const used = total();
  const gap = 0;
  return {
    items,
    droppedIds,
    omissionCount: showOmissions && keep > 0 ? droppedIds.length : 0,
    rightVisible,
    gap,
    used,
  };
}

interface PowerlineRailProps {
  /** Chips in render order. Plain elements are treated as single-level chips. */
  segments: Array<React.ReactElement | RailSpanEntry>;
  budget: number;
  /**
   * Optional priority-tail segment. The fitter reserves it before dropping
   * ordinary chips, then the renderer joins it to the same connected rail.
   */
  rightAnchor?: React.ReactElement | null | undefined;
  /** Keep the segmented silhouette but emit no foreground/background colors. */
  monochrome?: boolean | undefined;
  /** Explicit candidate palette for the theme picker; never changes the active theme. */
  palette?: Theme | undefined;
}

function toEntries(segments: PowerlineRailProps['segments']): RailSpanEntry[] {
  return segments.map((segment, index) =>
    isValidElement(segment) ? { id: `seg-${index}`, node: segment } : (segment as RailSpanEntry),
  );
}

interface CapsuleProps {
  items: RailLayoutItem[];
  dropped?: number | undefined;
  droppedAfter?: number | undefined;
  monochrome: boolean;
  palette: Theme;
}

function RailCapsule({
  items,
  dropped = 0,
  droppedAfter = items.length - 1,
  monochrome,
  palette,
}: CapsuleProps): React.ReactElement {
  const painted = !monochrome && palette.supportsBackground;
  const tones = painted ? statuslineBackgrounds(palette) : [];
  const backgrounds = items.map((_, index) => tones[index % tones.length]);

  return (
    <Text>
      {items.map((item, index) => {
        const background = backgrounds[index]!;
        const previous = index > 0 ? backgrounds[index - 1]! : undefined;
        return (
          <Text key={item.id}>
            {index === 0 ? (
              <Text color={painted ? background : undefined}>{glyphs.segmentStart}</Text>
            ) : (
              <Text
                color={painted ? previous : undefined}
                backgroundColor={painted ? background : undefined}
              >
                {glyphs.segmentTransition}
              </Text>
            )}
            <Text
              color={painted ? palette.textPrimary : undefined}
              backgroundColor={painted ? background : undefined}
            >
              {' '}
              {visibleNodeText(item.node)}{' '}
              {index === droppedAfter && dropped > 0 ? `+${dropped} ` : null}
            </Text>
          </Text>
        );
      })}
      {items.length > 0 ? (
        <Text color={painted ? backgrounds.at(-1) : undefined}>{glyphs.segmentEnd}</Text>
      ) : null}
    </Text>
  );
}

/**
 * Theme-aware, Powerline-style status capsules. Chip payloads share a readable
 * foreground while five theme-derived surface tones provide the
 * connected silhouette. The renderer and layout fitter share the exact cap,
 * transition, padding and anchor costs, keeping overflow and pointer spans
 * aligned with the cells on screen.
 */
export function PowerlineRail({
  segments,
  budget,
  rightAnchor,
  monochrome = false,
  palette = theme,
}: PowerlineRailProps): React.ReactElement {
  return (
    <StatusRail
      layout={layoutRail(toEntries(segments), budget, rightAnchor)}
      rightAnchor={rightAnchor}
      monochrome={monochrome}
      palette={palette}
    />
  );
}

export function StatusRail({
  layout,
  rightAnchor,
  monochrome = false,
  palette = theme,
}: {
  layout: RailLayout;
  rightAnchor?: React.ReactElement | null | undefined;
  monochrome?: boolean | undefined;
  palette?: Theme | undefined;
}): React.ReactElement {
  const capsuleItems = [...layout.items];
  if (layout.rightVisible && rightAnchor) {
    capsuleItems.push({
      id: 'right-anchor',
      start: 0,
      len: displayWidth(visibleNodeText(rightAnchor)) + RAIL_SEP_COST,
      level: 0,
      node: rightAnchor,
    });
  }

  if (capsuleItems.length === 0) return <Text> </Text>;
  return (
    <RailCapsule
      items={capsuleItems}
      dropped={layout.omissionCount}
      droppedAfter={layout.items.length - 1}
      monochrome={monochrome}
      palette={palette}
    />
  );
}
