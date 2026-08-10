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
// The component is intentionally a shell right now — its children are a
// placeholder. Callers pass `children` when they have real content.

import type React from 'react';
import { Box, Text, useStdout } from '../ink.js';
import { theme } from '../theme.js';

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

export interface RightSidebarProps {
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
   * Content to render inside the sidebar. When omitted, a dimmed placeholder
   * label is shown so the reserved region is visually self-documenting.
   */
  children?: React.ReactNode | undefined;
}

export function RightSidebar({ width, maxHeight, focused = false, children }: RightSidebarProps): React.ReactElement | null {
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const resolvedWidth = width ?? computeSidebarWidth(termCols);

  // Hide entirely on narrow terminals.
  if (resolvedWidth === 0) return null;

  return (
    <Box
      flexDirection="column"
      width={resolvedWidth}
      height={maxHeight}
      overflowY="hidden"
      flexShrink={0}
      borderStyle={focused ? 'double' : 'round'}
      borderColor={focused ? theme.borderActive : theme.borderSubtle}
      paddingX={1}
    >
      {children ?? (
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.textMuted} wrap="truncate">
            ◧ SIDEBAR
          </Text>
          {focused ? (
            <Text color={theme.borderActive} bold>
              [FOCUS]
            </Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
