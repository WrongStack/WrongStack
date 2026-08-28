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

export interface RailSpanEntry {
  /** Stable identifier used by the mouse hit-test ('model', 'todos', …). */
  id: string;
  node: React.ReactElement;
}

export interface RailSpan {
  id: string;
  /** 0-based start column within the rail's row. */
  start: number;
  /** Rendered width in columns. */
  len: number;
}

/**
 * 0-based column spans of the segments PowerlineRail will actually keep,
 * mirroring its keep/drop and right-anchor trim math exactly. The status-bar
 * mouse hit-test consumes this so click targets are derived from the SAME
 * nodes the renderer draws — dead-reckoned column constants drifted every
 * time a chip changed width or moved lines. Keep this in lockstep with
 * PowerlineRail's layout loop above.
 */
export function computeRailSpans(
  entries: readonly RailSpanEntry[],
  budget: number,
  rightAnchor?: React.ReactElement | null,
): RailSpan[] {
  const widths = entries.map((entry) => displayWidth(visibleNodeText(entry.node)));
  let used = 0;
  let keep = 0;
  for (let i = 0; i < entries.length; i++) {
    const sep = keep > 0 ? 2 : 0;
    const w = widths[i]!;
    const wouldDrop = entries.length - (i + 1);
    const markerWidth = wouldDrop > 0 ? 2 + String(wouldDrop).length : 0;
    if (keep > 0 && used + sep + w + markerWidth > budget) break;
    used += sep + w;
    keep += 1;
  }
  if (entries.length > 0) keep = Math.max(1, keep);
  let dropped = entries.length - keep;
  if (rightAnchor && keep > 0) {
    const reservedRight = displayWidth(visibleNodeText(rightAnchor));
    while (keep > 1) {
      const markerWidth = dropped > 0 ? 2 + String(dropped + 1).length : 0;
      if (used + 2 + reservedRight + markerWidth <= budget) break;
      used -= 2 + widths[keep - 1]!;
      keep -= 1;
      dropped += 1;
    }
  }
  const spans: RailSpan[] = [];
  let col = 0;
  for (let i = 0; i < keep; i++) {
    if (i > 0) col += 2;
    spans.push({ id: entries[i]!.id, start: col, len: widths[i]! });
    col += widths[i]!;
  }
  return spans;
}

interface PowerlineRailProps {
  segments: React.ReactElement[];
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

  const widths = segments.map((segment) => displayWidth(visibleNodeText(segment)));

  let used = 0;
  let keep = 0;
  for (let i = 0; i < segments.length; i++) {
    const sep = keep > 0 ? 2 : 0;
    const w = widths[i]!;
    const wouldDrop = segments.length - (i + 1);
    const markerWidth = wouldDrop > 0 ? 2 + String(wouldDrop).length : 0;
    if (keep > 0 && used + sep + w + markerWidth > budget) break;
    used += sep + w;
    keep += 1;
  }
  if (segments.length > 0) keep = Math.max(1, keep);
  const visible = segments.slice(0, keep);
  let dropped = segments.length - keep;

  // Right-anchor reservation: when the anchor + left segments would
  // overflow, trim trailing left segments until it fits. The omission
  // marker (`+N`) must also fit within the budget.
  if (rightAnchor && visible.length > 0) {
    const rightTextWidth = displayWidth(visibleNodeText(rightAnchor));
    const reservedRight = rightTextWidth;
    while (visible.length > 1) {
      const markerWidth = dropped > 0 ? 2 + String(dropped + 1).length : 0;
      if (used + 2 + reservedRight + markerWidth <= budget) break;
      const droppedSegWidth = widths[visible.length - 1]!;
      used -= 2 + droppedSegWidth;
      visible.pop();
      dropped += 1;
    }
  }

  let rightSegment: React.ReactElement | null = null;
  let gapWidth = 0;
  if (rightAnchor) {
    const rightTextWidth = displayWidth(visibleNodeText(rightAnchor));
    const reservedRight = rightTextWidth;
    const trailingSep = visible.length > 0 ? 2 : 0;
    const markerWidth = dropped > 0 ? 2 + String(dropped).length : 0;
    const leftUsed = segments.length > 0 ? used + trailingSep + markerWidth : 0;
    if (leftUsed + reservedRight <= budget) {
      rightSegment = rightAnchor;
      gapWidth = Math.max(0, budget - leftUsed - reservedRight);
    } else {
      rightSegment = null;
    }
  }

  const fillBackground = fillBg ?? theme.surface;

  const content = (
    <Text>
      {visible.map((segment, index) => (
        <Text key={index}>
          {index > 0 ? '  ' : null}
          {segment}
        </Text>
      ))}
      {rightSegment ? (
        <Text>
          {visible.length > 0 ? '  ' : null}
          {gapWidth > 0 ? ' '.repeat(gapWidth) : null}
          {rightSegment}
        </Text>
      ) : null}
      {dropped > 0 ? <Text color={theme.textMuted}>{` +${dropped}`}</Text> : null}
    </Text>
  );

  if (monochrome) return content;

  return <Box backgroundColor={fillBackground}>{content}</Box>;
}
