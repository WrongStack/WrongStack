// Small vertical scrollbar for the right sidebar rail.
//
// One column wide, flush with the rail's right edge (RightSidebar renders
// it in what was the right padding column, so no content column is ever
// taken from the routed twins or the persistent cards). The rail is
// persistent: when the sidebar's estimated content does not overflow the
// viewport it renders a dimmed, thumb-less track instead of disappearing,
// so the bottom-right thumb never flickers the whole rail in and out.
//
// Math contract (shared with the reducer clamp — do NOT re-derive):
//   * `maxScroll` is `estimateSidebarMaxScroll(...)` from
//     `reducers/workspace-panels.ts` — the same number the `sidebarScroll`
//     / `sidebarScrollSet` clamps use, so the thumb always reflects the
//     real reachable range (over-estimates leave a little blank tail, the
//     established sidebar convention).
//   * Thumb sizing mirrors the history rail idiom:
//       content = viewport + maxScroll
//       size    = round(viewport² / content), clamped to [1, viewport]
//       top     = round((offset / maxScroll) × (viewport − size))
//   * `sidebarOffsetForCell` is the exact inverse used by press/drag
//     scrubbing in `app-key-handler.ts` — both directions live here so a
//     future tweak can never desynchronize the thumb from the mapping.
//
// Interaction: wheel anywhere over the sidebar scrolls it (see
// `app-key-handler.ts`); press/drag on this rail scrubs to an absolute
// offset via `sidebarScrollSet`.

import type React from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';

/** Thumb geometry for a given scroll state. Pure — unit-tested. */
export function sidebarScrollbarThumb(
  viewportRows: number,
  maxScroll: number,
  offset: number,
): { size: number; top: number } {
  const viewport = Math.max(1, viewportRows);
  const overflow = Math.max(0, maxScroll);
  if (overflow === 0) return { size: viewport, top: 0 };
  const content = viewport + overflow;
  const size = Math.min(viewport, Math.max(1, Math.round((viewport * viewport) / content)));
  const safeOffset = Math.min(overflow, Math.max(0, offset));
  const top = Math.min(
    viewport - size,
    Math.max(0, Math.round((safeOffset / overflow) * (viewport - size))),
  );
  return { size, top };
}

/**
 * Inverse mapping: a 0-based track cell (mouse row − 1 over the rail)
 * becomes the absolute scroll offset at that track position — top of track
 * = 0, bottom of track = maxScroll. Pure — unit-tested and shared with the
 * press/drag dispatcher in `app-key-handler.ts` so click-scrubbing reaches
 * the exact extremes the wheel can reach.
 */
export function sidebarOffsetForCell(
  cell: number,
  viewportRows: number,
  maxScroll: number,
): number {
  const viewport = Math.max(1, viewportRows);
  const overflow = Math.max(0, maxScroll);
  if (overflow === 0) return 0;
  const clamped = Math.min(Math.max(0, cell), viewport - 1);
  const span = Math.max(1, viewport - 1);
  return Math.round((clamped / span) * overflow);
}

export interface SidebarScrollbarProps {
  /** Visible content rows — the track height (RightSidebar's innerHeight). */
  viewportRows: number;
  /** Current scroll offset in rows. */
  offset: number;
  /**
   * Estimated overflow beyond the viewport; ≤ 0 renders a dimmed,
   * thumb-less track — the rail column itself stays visible.
   */
  maxScroll: number;
  /** When true the thumb reads in the accent color (keyboard focus). */
  focused?: boolean | undefined;
}

/**
 * The rail itself: one column of `░` track cells with a `▉` thumb segment.
 * Persistent by design: when there is nothing to scroll it renders a dimmed
 * thumb-less track (not null) so the rail never pops in and out of existence
 * as the content-height estimate fluctuates. Returns null only when there is
 * no room to draw a track at all (< 1 viewport row).
 */
export function SidebarScrollbar({
  viewportRows,
  offset,
  maxScroll,
  focused = false,
}: SidebarScrollbarProps): React.ReactElement | null {
  if (viewportRows < 1) return null;
  const scrollable = maxScroll > 0;
  const { size, top } = sidebarScrollbarThumb(viewportRows, maxScroll, offset);
  const rows: React.ReactElement[] = [];
  for (let row = 0; row < viewportRows; row++) {
    const inThumb = scrollable && row >= top && row < top + size;
    rows.push(
      <Box key={row} height={1} flexShrink={0}>
        <Text
          color={inThumb ? (focused ? theme.accent : theme.textMuted) : theme.borderSubtle}
          dimColor={!scrollable}
        >
          {inThumb ? glyphs.meter7 : glyphs.cellEmpty}
        </Text>
      </Box>,
    );
  }
  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {rows}
    </Box>
  );
}
