// Shared chrome + scroll primitive for sidebar panel variants.
//
// Every F-key panel has a sidebar twin (`<X>PanelSidebar`) that renders the
// same content as its bottom-region sibling but adapted to a narrow column.
// The two shells share this component so visual language stays identical
// (round border in the panel's accent color, glyph + title header, optional
// kicker + right-aligned badge, scrollable body that handles overflow
// internally).
//
// Width contract: every section box is exactly `innerWidth` columns wide so
// dotted-leader fills and block meters line up. Row counts deliberately
// mirror `computeMaxSidebarScroll()` in `reducers/workspace-panels.ts` —
// keep the two in sync when adding/removing sections.

import type React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text, useStdout } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';

export interface SidebarPanelFrameProps {
  /** Accent color for border + title (mirrors `theme.monitor.*` on bottom panels). */
  accent: string;
  /** Header glyph, e.g. `glyphs.fleet` or `glyphs.sessions`. */
  icon: string;
  /** Uppercase title (e.g. "FLEET", "PLAN", "AGENTS"). */
  title: string;
  /**
   * Width allocated to this panel frame, including the frame's own border and
   * padding. When nested in RightSidebar, pass that shell's content width —
   * not the outer sidebar width — so both chrome layers remain in bounds.
   */
  width: number;
  /** Optional quiet subtitle hidden on narrow terminals. */
  kicker?: string | undefined;
  /** Optional right-aligned header content (status badge, counts, etc.). */
  right?: React.ReactNode | undefined;
  /** Footer content (key hints, footer note). Renders under the body. */
  footer?: React.ReactNode | undefined;
  /** Body content. Renders inside the scrollable region. */
  children?: React.ReactNode | undefined;
  /**
   * Body scroll offset (in rows). When the body exceeds the visible window,
   * older rows are clipped from the top and a "↑ N earlier" marker is shown.
   * Pass `0` when no scrolling is needed (single panel fits in viewport).
   */
  bodyScrollOffset?: number | undefined;
}

/**
 * Truncate a string to fit within `max` display columns, adding an ellipsis.
 * Exported so sibling sidebar panel files can use the same string-fitting
 * helper without pulling in sidebar-content.tsx's full implementation.
 */
export function trunc(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * A section header: colored glyph + bold uppercase label, a dotted leader
 * filling the remaining width, and an optional right-aligned badge. Always
 * renders exactly one row of exactly `innerWidth` columns — the badge is
 * dropped gracefully when there is no room (narrow terminals).
 */
export function SidebarSectionHeader({
  glyph,
  label,
  color,
  badge,
  badgeColor,
  innerWidth,
}: {
  glyph: string;
  label: string;
  color: string;
  badge?: string | undefined;
  badgeColor?: string | undefined;
  innerWidth: number;
}): React.ReactElement {
  const left = `${glyph} ${label}`;
  const leftW = displayWidth(left);
  const badgeW = badge ? displayWidth(badge) + 1 : 0;
  const fitsBadge = !!badge && innerWidth - leftW - badgeW >= 0;
  const fillCount = Math.max(0, innerWidth - leftW - (fitsBadge ? badgeW : 0));
  return (
    <Box>
      <Text color={color} bold>
        {left}
      </Text>
      <Text color={theme.borderSubtle}>{'·'.repeat(fillCount)}</Text>
      {fitsBadge ? (
        <Text color={badgeColor ?? color} bold>
          {' '}
          {badge}
        </Text>
      ) : null}
    </Box>
  );
}

/** A raised "card" wrapper. On truecolor terminals it gets a subtle lifted
 *  surface so sections read as stacked panels; otherwise it is a plain box. */
export function SidebarPanelCard({
  innerWidth,
  marginBottom = 1,
  children,
}: {
  innerWidth: number;
  marginBottom?: number | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={innerWidth}
      marginBottom={marginBottom}
      {...(theme.supportsBackground ? { backgroundColor: theme.surfaceRaised } : {})}
    >
      {children}
    </Box>
  );
}

/**
 * SidebarPanelFrame — the standard chrome wrapper used by every sidebar
 * panel variant. Renders a round border in the panel's accent color with a
 * glyph + title header, optional kicker + right-aligned badge, a scrollable
 * body region, and an optional footer.
 *
 * Scrolling: the body itself doesn't scroll. The host (app-view / SidebarContent)
 * computes scroll offsets from the focused panel index. We accept a
 * `bodyScrollOffset` and a fixed body height so panels that exceed their
 * viewport can be paged with Shift+Tab + ↑↓ while focused. When the body
 * scrolls, a "↑ N earlier" indicator is shown at the top of the body region.
 */
export function SidebarPanelFrame({
  accent,
  icon,
  title,
  width,
  kicker,
  right,
  footer,
  children,
  bodyScrollOffset = 0,
}: SidebarPanelFrameProps): React.ReactElement {
  // Reserve room for border (2) + padding (2) = 4 cols of chrome.
  const innerWidth = Math.max(8, width - 4);

  // Height of the body region. Cap to the visible sidebar height when the
  // host knows it, otherwise fall back to a generous default that lets
  // panels render fully when they're the only one shown.
  const { stdout } = useStdout();
  // The frame is mounted inside RightSidebar, whose top/bottom border consumes
  // two rows. Claiming the full terminal height here makes the nested frame
  // overflow its parent and shifts/clips the terminal row layout.
  const sidebarHeight = Math.max(1, (stdout?.rows ?? 32) - 2);
  // Header (1) + footer (1) + chrome (2) — leaves most of the viewport for the body.
  const bodyHeight = Math.max(1, sidebarHeight - 4);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={sidebarHeight}
      overflowY="hidden"
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      flexShrink={0}
    >
      {/* Header row: glyph + title + optional kicker + right-aligned badge */}
      <Box height={1}>
        <Text color={accent} bold wrap="truncate">
          {trunc(`${icon} ${title}${kicker ? ` / ${kicker}` : ''}`, innerWidth)}
        </Text>
      </Box>
      {right ? (
        <Box height={1}>
          <Text wrap="truncate">{right}</Text>
        </Box>
      ) : null}

      {/* Body region — fixed height, scrolls internally when content overflows. */}
      <Box flexDirection="column" height={bodyHeight} overflowY="hidden" flexShrink={0}>
        {bodyScrollOffset > 0 ? (
          <Box>
            <Text color={theme.textMuted} dimColor>
              ↑ {bodyScrollOffset} earlier
            </Text>
          </Box>
        ) : null}
        <Box
          flexDirection="column"
          {...(bodyScrollOffset > 0 ? { marginTop: -bodyScrollOffset } : {})}
        >
          {children}
        </Box>
      </Box>

      {footer ? (
        <Box height={1} marginTop={1}>
          <Text wrap="truncate" dimColor>
            {footer}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * useSidebarPanelSize — returns a sensible default width / height for a
 * sidebar panel given the terminal dimensions. Width mirrors
 * `computeSidebarWidth` from `sidebar.tsx`; height is the full terminal
 * minus a small safety margin for the focus indicator row.
 */
export function useSidebarPanelSize(): { width: number; height: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 32,
  });
  useEffect(() => {
    const update = () => setSize({ columns: stdout?.columns ?? 100, rows: stdout?.rows ?? 32 });
    update();
    process.stdout.on('resize', update);
    return () => {
      process.stdout.off('resize', update);
    };
  }, [stdout]);
  return { width: size.columns, height: size.rows };
}