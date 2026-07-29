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
      {dropped > 0 ? (
        <Text color={theme.textMuted}>{` +${dropped}`}</Text>
      ) : null}
    </Text>
  );

  if (monochrome) return content;

  return <Box backgroundColor={fillBackground}>{content}</Box>;
}
