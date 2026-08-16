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

import type React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';

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

/**
 * Build the rail's top accent ribbon — a two-line banner that sits above the
 * bordered shell. The ribbon is composed as:
 *
 *   <pulse> SIDE RAIL · mission control ───────────
 *   ╰── content area begins here ────────────────╯
 *
 * The width-1 subtraction matches the bordered shell's own width so the
 * ribbon, frame and panels stay column-aligned down the rail. The ribbon is
 * drawn OUTSIDE the bordered Box so the frame stays border-only — panels
 * below can use box-drawing characters in their own headers without any
 * glyph collision.
 */
function SidebarRibbon({
  width,
  focused,
}: {
  width: number;
  focused: boolean;
}): React.ReactElement {
  // Inside the frame we lose 2 cols to left+right borders, then 2 more to the
  // internal padding. The ribbon renders BEFORE the frame so it should match
  // the frame's outer width exactly (no chrome subtracted).
  const title = 'SIDE RAIL';
  const dot = focused ? glyphs.pulseHigh : glyphs.pulseMid;
  const dotColor = focused ? theme.success : theme.textMuted;
  // Line 1: `● SIDE RAIL · mission control ───────`
  const line1Left = `${dot} ${title} ${glyphs.dividerDiamond} mission control`;
  const line1LeftW = line1Left.length;
  const line1Fill = Math.max(0, width - line1LeftW);
  // Line 2: a hairline ruler with a kink on the right (subtle "shelf" the
  // panel content rests on). We split into two halves so the kink is centered.
  const half = Math.max(0, Math.floor((width - 1) / 2));
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box width={width}>
        <Text color={dotColor} bold>
          {line1Left}
        </Text>
        <Text color={theme.borderActive}>{glyphs.dividerDash.repeat(line1Fill)}</Text>
      </Box>
      <Box width={width}>
        <Text color={theme.borderSubtle}>{glyphs.dividerDash.repeat(half)}</Text>
        <Text color={theme.borderActive} bold>
          {glyphs.dividerDiamond}
        </Text>
        <Text color={theme.borderSubtle}>
          {glyphs.dividerDash.repeat(Math.max(0, width - half - 1))}
        </Text>
      </Box>
    </Box>
  );
}

/** Hairline + key hint that anchors the bottom of the rail on focus. */
function SidebarFooter({
  width,
  focused,
}: {
  width: number;
  focused: boolean;
}): React.ReactElement {
  if (!focused) {
    return (
      <Box width={width} flexShrink={0}>
        <Text color={theme.borderSubtle}>{glyphs.dividerDash.repeat(Math.max(0, width))}</Text>
      </Box>
    );
  }
  const hint = '↑↓ scroll · Shift+Tab exits';
  const fill = Math.max(0, width - hint.length);
  return (
    <Box width={width} flexShrink={0}>
      <Text color={theme.borderSubtle}>{glyphs.dividerDash.repeat(fill)}</Text>
      <Text color={theme.borderActive}>{hint}</Text>
    </Box>
  );
}

export function RightSidebar({
  width,
  maxHeight,
  focused = false,
  children,
}: RightSidebarProps): React.ReactElement | null {
  const { columns: termCols } = useTerminalSize({ fallbackColumns: 80 });
  const resolvedWidth = width ?? computeSidebarWidth(termCols);

  // Hide entirely on narrow terminals.
  if (resolvedWidth === 0) return null;

  // Subtract the rail chrome (ribbon = 2 rows, footer = 1 row) from the
  // requested max height so the inner bordered shell + its contents fit.
  const innerHeight = maxHeight === undefined ? undefined : Math.max(0, maxHeight - 3);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <SidebarRibbon width={resolvedWidth} focused={focused} />
      <Box
        flexDirection="column"
        width={resolvedWidth}
        height={innerHeight}
        overflowY="hidden"
        flexShrink={0}
        borderStyle={focused ? 'double' : 'round'}
        borderColor={focused ? theme.borderActive : theme.borderSubtle}
        paddingX={1}
      >
        {children ?? (
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={theme.textMuted} wrap="truncate">
              {glyphs.cornerTL} SIDEBAR
            </Text>
            {focused ? (
              <Text color={theme.borderActive} bold>
                [FOCUS]
              </Text>
            ) : null}
          </Box>
        )}
      </Box>
      <SidebarFooter width={resolvedWidth} focused={focused} />
    </Box>
  );
}
