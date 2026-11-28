// Right sidebar — a reserved region beside the chat history area.
//
// The sidebar takes up a fixed fraction of the terminal width (clamped to a
// sane range) so the main chat column can narrow and wrap while this area is
// available for future task panels, agent monitors, or contextual widgets.
//
// Width policy:
//   - Below SIDEBAR_MIN_TERMINAL (≈64 cols) the sidebar is hidden entirely so
//     narrow terminals keep the full width for chat.
//   - Otherwise the width is 25% of terminal columns, clamped to
//     [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH].
//
// Visual treatment:
//   The shell is the only border in the rail — routed panels and content
//   cards spend the saved columns on data. To make the rail feel "designed"
//   we layer:
//     1. An accent-ribbon title strip at the top (drawn ABOVE the frame, so
//        it always reads as a branded rail and never collides with panels
//        whose own section headers use box-drawing glyphs).
//     2. A double border when focused (single when not), with a subtle
//        accent dot pulsing at the top-left to read as "live" telemetry.
//     3. A footer hairline + focus hint so the rail never feels amputated
//        at the bottom of a narrow terminal.
//
//   These are pure visual upgrades — the component contract (width, height,
//   children passthrough) is unchanged so existing routed panels and
//   SidebarContent keep working without modification.

import { type ReactElement, type ReactNode, useLayoutEffect, useRef } from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, type DOMElement, measureElement, Text } from '../ink.js';
import { displayWidth, truncateDisplay } from '../terminal-width.js';
import { sidebarCardSurface, theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { SidebarScrollbar } from './sidebar-scrollbar.js';

/** Terminal widths below this hide the sidebar entirely. */
export const SIDEBAR_MIN_TERMINAL = 64;
/** Smallest sidebar width (in columns) when visible. */
export const SIDEBAR_MIN_WIDTH = 20;
/** Largest sidebar width (in columns). */
export const SIDEBAR_MAX_WIDTH = 48;
/** Fraction of terminal width to allocate to the sidebar. */
export const SIDEBAR_FRACTION = 0.25;
/** Border (2) plus horizontal padding (2) consumed by RightSidebar. */
export const SIDEBAR_HORIZONTAL_CHROME = 4;

/**
 * Return the width available to children inside RightSidebar.
 *
 * Routed panel frames have their own border and padding, so they must receive
 * this content width rather than claiming the outer sidebar width again.
 */
export function computeSidebarContentWidth(sidebarWidth: number): number {
  return Math.max(0, sidebarWidth - SIDEBAR_HORIZONTAL_CHROME);
}

/**
 * Compute the sidebar width in columns for a given terminal width.
 * Returns 0 when the terminal is too narrow for a sidebar.
 *
 * Pure — no React, no Ink — so callers can use the same value for layout
 * math (e.g. narrowing the history column) without mounting the component.
 */
export function computeSidebarWidth(termCols: number): number {
  if (termCols < SIDEBAR_MIN_TERMINAL) return 0;
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.floor(termCols * SIDEBAR_FRACTION)),
  );
}

interface RightSidebarProps {
  /**
   * Optional explicit width override (in columns). When omitted, the width
   * is derived from the current terminal width via {@link computeSidebarWidth}.
   */
  width?: number | undefined;
  /**
   * Maximum height in rows. Content beyond this is clipped (scroll handled
   * by the caller via scrollOffset). When omitted, no height cap is applied.
   */
  maxHeight?: number | undefined;
  /**
   * When true, the sidebar border is highlighted to indicate keyboard focus.
   */
  focused?: boolean | undefined;
  /**
   * Current sidebar scroll offset in rows. Positions the scrollbar thumb.
   */
  scrollOffset?: number | undefined;
  /**
   * Estimated scrollable overflow in rows (from
   * `estimateSidebarMaxScroll`). > 0 draws a one-column scrollbar with a
   * thumb in the rail's right padding column; ≤ 0 keeps the rail visible
   * as a dimmed, thumb-less track (persistent rail — no bottom-right
   * flicker). Content columns are untouched either way.
   */
  maxScroll?: number | undefined;
  /**
   * Content to render inside the sidebar. When omitted, a dimmed placeholder
   * label is shown so the reserved region is visually self-documenting.
   */
  children?: ReactNode | undefined;
  /** Icon-only live connection strip, sharing the existing one-row footer. */
  statusIcons?: ReactNode | undefined;
  /** Publish the actual scroll range of all rendered cards. */
  onMeasureScroll?: ((maxScroll: number) => void) | undefined;
}

/** Hairline + key hint that anchors the bottom of the rail on focus. */
function SidebarFooter({ width, focused }: { width: number; focused: boolean }): ReactElement {
  if (!focused) {
    return (
      <Box width={width} flexShrink={0}>
        <Text color={theme.borderSubtle}>{glyphs.dividerDash.repeat(Math.max(0, width))}</Text>
      </Box>
    );
  }
  const full = '↑↓ scroll · Shift+Tab exits';
  const hint = truncateDisplay(displayWidth(full) <= width ? full : '↑↓ · Shift+Tab', width);
  const fill = Math.max(0, width - displayWidth(hint));
  return (
    <Box width={width} height={1} flexShrink={0}>
      <Text color={theme.accent} bold wrap="truncate-end">
        {glyphs.dividerDash.repeat(fill)}
        {hint}
      </Text>
    </Box>
  );
}

export function RightSidebar({
  width,
  maxHeight,
  focused = false,
  scrollOffset = 0,
  maxScroll = 0,
  children,
  statusIcons,
  onMeasureScroll,
}: RightSidebarProps): ReactElement | null {
  const { columns: termCols } = useTerminalSize({ fallbackColumns: 80 });
  const resolvedWidth = width ?? computeSidebarWidth(termCols);
  const innerHeight = maxHeight === undefined ? undefined : Math.max(0, maxHeight - 1);
  const contentRef = useRef<DOMElement | null>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content && innerHeight !== undefined) {
      onMeasureScroll?.(Math.max(0, measureElement(content).height - innerHeight));
    }
  });
  if (resolvedWidth === 0) return null;
  const visibleOffset = Math.min(maxScroll, Math.max(0, scrollOffset));

  // Layout: [content area | 1-col scroll rail]. The rail occupies the
  // column that was previously the right padding, and the content area
  // keeps a full left padding with NO right padding — so the usable
  // content columns are byte-identical to the pre-scrollbar layout and
  // `computeSidebarContentWidth` stays the single width contract.
  const contentWidth = Math.max(1, resolvedWidth - 1);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box
        flexDirection="row"
        width={resolvedWidth}
        height={innerHeight}
        overflowY="hidden"
        overflowX="hidden"
        flexShrink={0}
        {...(theme.supportsBackground ? { backgroundColor: sidebarCardSurface() } : {})}
      >
        <Box
          flexDirection="column"
          width={contentWidth}
          paddingLeft={1}
          overflowY="hidden"
          overflowX="hidden"
          flexShrink={0}
        >
          <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-visibleOffset}>
            {children ?? (
              <Text color={theme.textMuted} wrap="truncate">
                SIDEBAR
              </Text>
            )}
          </Box>
        </Box>
        {/* Persistent scroll rail: dimmed, thumb-less track when the content
            fits, thumb when it overflows. The column is always reserved by
            the row layout, so the rail no longer pops in/out with the
            content-height estimate (no bottom-right flicker) and toggling
            never reflows the content beside it. */}
        <SidebarScrollbar
          viewportRows={innerHeight ?? 0}
          offset={visibleOffset}
          maxScroll={maxScroll}
          focused={focused}
        />
      </Box>
      {!focused && statusIcons ? (
        statusIcons
      ) : (
        <SidebarFooter width={resolvedWidth} focused={focused} />
      )}
    </Box>
  );
}
