import type React from 'react';
import { isValidElement } from 'react';
import { Box, Text } from '../ink.js';
import { displayWidth, padDisplayEnd } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';

const RAIL_BACKGROUNDS = [theme.surfaceRaised, theme.surface] as const;

export function visibleNodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleNodeText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode; text?: unknown };
    if (props.children !== undefined) return visibleNodeText(props.children);
    if (typeof props.text === 'string') return props.text;
    return '';
  }
  return '';
}

export interface PowerlineRailProps {
  segments: React.ReactElement[];
  budget: number;
  monochrome?: boolean | undefined;
  /** Override the filler background for per-line tonal layering. */
  fillBg?: string | undefined;
  /**
   * Optional right-anchored segment. When provided, the rail renders the
   * normal `segments` left-aligned, then a fixed-width gap, then this
   * segment pinned to the right edge of the budget. The right segment's
   * column position is therefore independent of how wide the left
   * `segments` are — preventing visual jitter when the left side updates
   * frequently (e.g. memory-context counters) while the right side
   * carries slow-changing operational telemetry (e.g. index-server pid).
   *
   * Hidden (`null` / `false`) is a no-op; the rail collapses to a normal
   * left-aligned layout. The right segment is also dropped (with the gap
   * closed) when the rail would otherwise overflow the budget.
   */
  rightAnchor?: React.ReactElement | null | undefined;
}

/**
 * Full-cell status segments with Powerline-style transitions. The default
 * Unicode profile uses font-safe half-circles/triangles; Nerd Font mode swaps
 * in the canonical Powerline private-use glyphs.
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
    // Box provides a block-level background that fills the full width —
    // Text backgrounds only cover the text content.
    return (
      <Box backgroundColor={fillBg}>
        <Text> </Text>
      </Box>
    );
  }

  // Width budget per transition cell: leading space + glyph width +
  // trailing space. The transition glyph (▶ in Unicode / Nerd Font mode)
  // measures 2 columns in this codebase's `displayWidth` table, so the
  // hardcoded 3 below would silently undercount by one column per
  // transition and let long lines overflow. Compute from the glyph
  // itself so the budget matches the rendered output exactly.
  const transitionCellWidth = 1 + displayWidth(glyphs.segmentTransition) + 1;
  // Right-anchor cell: leading transition glyph + space + text + space +
  // end cap.
  const rightAnchorOverhead = 1 + 1 + 1 + 1 + displayWidth(glyphs.segmentEnd);

  const widths = segments.map((segment) => displayWidth(visibleNodeText(segment)) + 2);
  let used = monochrome ? 2 : 1;
  let keep = 0;
  for (let i = 0; i < segments.length; i++) {
    const transition = keep > 0 ? transitionCellWidth : 0;
    const end = monochrome ? 0 : 1;
    const wouldDrop = segments.length - (i + 1);
    const markerWidth = wouldDrop > 0 ? (monochrome ? 4 : 2) + String(wouldDrop).length : 0;
    const w = widths[i]!;
    if (keep > 0 && used + transition + w + end + markerWidth > budget) break;
    used += transition + w;
    keep += 1;
  }
  keep = Math.max(1, keep);
  const visible = segments.slice(0, keep);
  let dropped = segments.length - keep;

  // When a right anchor is present and the kept left segments + anchor
  // would overflow the budget, trim the trailing left segments first
  // (preserving the leftmost ones) until the anchor fits. This keeps the
  // right anchor (e.g. the index-server `#pid` chip) stable on its
  // column at the cost of dropping the latest transient counter chips
  // — the opposite trade-off of the budget loop above, which would
  // drop the anchor. We always keep at least one left segment so the
  // rail has a visible body when both sides are configured.
  if (rightAnchor && visible.length > 0) {
    const rightTextWidth = displayWidth(visibleNodeText(rightAnchor));
    const reservedRight = rightTextWidth + rightAnchorOverhead;
    while (visible.length > 1) {
      const trailingTransition = transitionCellWidth;
      const leftUsed = used + trailingTransition;
      if (leftUsed + reservedRight <= budget) break;
      // Drop the last visible segment and update `used` by removing its
      // contribution: the trailing transition (if any) and its width.
      const droppedSegWidth = widths[visible.length - 1]!;
      used -= trailingTransition + droppedSegWidth;
      visible.pop();
      dropped += 1;
    }
  }

  // Right-anchor geometry: pin the right segment to a fixed column relative
  // to the budget's right edge so its position doesn't depend on the
  // variable widths of `segments` to its left.
  //
  //   layout: [start] [seg0] [trans] [seg1] [trans] [segK] [trans]
  //           [................gap (variable)...............]
  //           [rightAnchor, padded out to fixed columns]
  //
  // `used` only accumulates the inter-segment transitions, so the
  // trailing transition that bridges the last left segment to the right
  // anchor block is added here explicitly. The right block reserves:
  //   1 transition/start-cap glyph + 1 leading space
  // + displayWidth(rightText) (the text itself)
  // + 1 trailing space + 1 end-cap glyph
  // → total = displayWidth(rightText) + rightAnchorOverhead columns.
  let rightSegment: React.ReactElement | null = null;
  let rightWidth = 0;
  let gapWidth = 0;
  if (rightAnchor) {
    const rightTextWidth = displayWidth(visibleNodeText(rightAnchor));
    const reservedRight = rightTextWidth + rightAnchorOverhead;
    // Trailing transition after the last visible segment so the rail
    // reaches the right anchor cleanly. Only added when the rail will
    // actually render this transition (i.e. there are kept left
    // segments); otherwise the right anchor sits flush at the start.
    const trailingTransition = visible.length > 0 ? transitionCellWidth : 0;
    const leftUsed = segments.length > 0 ? used + trailingTransition : 0;
    if (leftUsed + reservedRight <= budget) {
      rightSegment = rightAnchor;
      rightWidth = reservedRight;
      gapWidth = Math.max(0, budget - leftUsed - rightWidth);
    } else {
      // Right anchor won't fit alongside the left segments; drop the right
      // anchor so the left side renders normally instead of being squashed.
      rightSegment = null;
      rightWidth = 0;
      gapWidth = 0;
    }
  }

  if (monochrome) {
    return (
      <Text>
        {visible.length > 0 ? <Text dimColor>{glyphs.segmentStart}</Text> : null}
        {visible.map((segment, index) => (
          <Text key={index}>
            {index > 0 ? <Text dimColor>{' › '}</Text> : null}
            <Text> {segment} </Text>
          </Text>
        ))}
        {dropped > 0 ? <Text dimColor>{` › +${dropped}`}</Text> : null}
        {rightSegment ? (
          <>
            {visible.length > 0 && gapWidth > 0 ? <Text>{' '.repeat(gapWidth)}</Text> : null}
            {visible.length > 0 ? <Text dimColor>{' › '}</Text> : null}
            <Text> {rightSegment} </Text>
          </>
        ) : null}
        <Text dimColor>{glyphs.segmentEnd}</Text>
      </Text>
    );
  }

  // Fill background used for the trailing-end gap. Computed once so segmentEnd
  // gets the same background as the Box filler that follows it.
  const fillBackground = fillBg ?? RAIL_BACKGROUNDS[(keep - 1) % RAIL_BACKGROUNDS.length]!;

  // Render the right-anchored segment with explicit padding so its right
  // edge sits at a fixed column. We pad with spaces (matching the rail's
  // background) rather than measuring inside Ink's layout because the
  // surface's column count must be deterministic per render — that's the
  // whole point of this anchor.
  // The right text itself occupies `rightTextWidth` columns; the
  // surrounding block adds `rightAnchorOverhead` columns (transition/start
  // cap + leading space + trailing space + end cap), so the inner padded
  // text node should be exactly `rightTextWidth` columns wide — i.e.
  // `rightWidth - rightAnchorOverhead`.
  const paddedRight = rightSegment
    ? padDisplayEnd(visibleNodeText(rightSegment), Math.max(0, rightWidth - rightAnchorOverhead))
    : null;

  const hasLeftSegments = visible.length > 0;

  return (
    <Box backgroundColor={fillBackground}>
      <Text>
        {hasLeftSegments ? (
          <Text color={RAIL_BACKGROUNDS[0]} backgroundColor={fillBackground}>
            {glyphs.segmentStart}
          </Text>
        ) : null}
        {visible.map((segment, index) => {
          const bg = RAIL_BACKGROUNDS[index % RAIL_BACKGROUNDS.length]!;
          const nextBg = RAIL_BACKGROUNDS[(index + 1) % RAIL_BACKGROUNDS.length]!;
          const isLast = index === visible.length - 1 && !rightSegment;
          return (
            <Text key={index}>
              <Text backgroundColor={bg} color={theme.textPrimary}>
                {' '}
                {segment}{' '}
              </Text>
              {isLast ? (
                <Text color={bg} backgroundColor={fillBackground}>
                  {glyphs.segmentEnd}
                </Text>
              ) : (
                <Text color={bg} backgroundColor={nextBg}>
                  {' '}
                  {glyphs.segmentTransition}{' '}
                </Text>
              )}
            </Text>
          );
        })}
        {rightSegment ? (
          <>
            {hasLeftSegments && gapWidth > 0 ? (
              <Text backgroundColor={fillBackground}>{' '.repeat(gapWidth)}</Text>
            ) : null}
            <Text backgroundColor={fillBackground}>
              {hasLeftSegments ? (
                <Text color={RAIL_BACKGROUNDS[0]} backgroundColor={fillBackground}>
                  {glyphs.segmentTransition}
                </Text>
              ) : (
                <Text color={RAIL_BACKGROUNDS[0]} backgroundColor={fillBackground}>
                  {glyphs.segmentStart}
                </Text>
              )}
              <Text backgroundColor={fillBackground} color={theme.textPrimary}>
                {' '}
                {paddedRight}{' '}
              </Text>
              <Text color={fillBackground} backgroundColor={fillBackground}>
                {glyphs.segmentEnd}
              </Text>
            </Text>
          </>
        ) : null}
        {dropped > 0 ? <Text color={theme.textMuted}>{` +${dropped}`}</Text> : null}
      </Text>
    </Box>
  );
}
