// Borderless visual frame for routed right-sidebar panel variants.
//
// Every F-key panel has a sidebar twin (`<X>PanelSidebar`) adapted to the
// narrow rail. `RightSidebar` owns the only border, padding, and viewport
// clipping; this frame adds an accent-led title, optional telemetry, section
// bands, and a footer without consuming columns on nested chrome.
//
// Width contract: every section box is exactly `innerWidth` columns wide so
// dotted leaders, block meters, and right-aligned metrics stay predictable.
// The frame has natural height and may be followed by the persistent
// `SidebarContent`; the outer shell clips their combined stack.

import type React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { displayWidth, truncateDisplay } from '../terminal-width.js';
import { theme } from '../theme.js';

export interface SidebarPanelFrameProps {
  /** Accent color for the rail, title, and separator. */
  accent: string;
  /** Header glyph, e.g. `glyphs.fleet` or `glyphs.sessions`. */
  icon: string;
  /** Uppercase title (e.g. "FLEET", "PLAN", "AGENTS"). */
  title: string;
  /**
   * Width allocated to this routed panel inside RightSidebar. The outer shell
   * owns the border and padding; this frame spends the full content width on
   * hierarchy and data.
   */
  width: number;
  /** Optional quiet subtitle hidden on narrow terminals. */
  kicker?: string | undefined;
  /** Optional right-aligned header content (status badge, counts, etc.). */
  right?: React.ReactNode | undefined;
  /** Footer content (key hints, footer note). Renders under the body. */
  footer?: React.ReactNode | undefined;
  /** Body content. The outer RightSidebar owns viewport clipping. */
  children?: React.ReactNode | undefined;
}

/**
 * Truncate a string to fit within `max` display columns, adding an ellipsis.
 * Exported so sibling sidebar panel files can use the same string-fitting
 * helper without pulling in sidebar-content.tsx's full implementation.
 */
export function trunc(s: string, max: number): string {
  return truncateDisplay(s, max);
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

/** A raised content band sized for a narrow rail. Section headers provide the
 * accent, while the lifted surface groups related data without spending any
 * horizontal columns on nested chrome. */
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
 * panel variant. It renders an accent-led title and telemetry strip inside the
 * existing RightSidebar shell, followed by a natural-height body and optional
 * footer. Avoiding a second border preserves scarce horizontal space; the
 * outer shell clips the combined routed-panel and persistent-content stack.
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
}: SidebarPanelFrameProps): React.ReactElement {
  // RightSidebar already owns the rail border and padding. This routed frame is
  // deliberately borderless so a 16-column slot keeps all 16 columns for data.
  const innerWidth = Math.max(8, width);
  const showKicker = !!kicker && innerWidth >= 24;
  const stageTitle = innerWidth >= 24 ? ` ${icon} ${title}` : ` ${title}`;

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {/* Signal-stage header: twin rails frame every routed panel as a live feed. */}
      <Box height={1} width={innerWidth}>
        <Text color={accent}>●</Text>
        <Text color={accent} bold wrap="truncate">
          {trunc(stageTitle, Math.max(1, innerWidth - 1))}
        </Text>
        <Box flexGrow={1} />
        {innerWidth >= 24 ? (
          <Text color={accent} bold>
            ╾
          </Text>
        ) : null}
      </Box>
      {showKicker || right ? (
        <Box height={1} width={innerWidth}>
          {showKicker ? (
            <Text color={theme.textMuted} dimColor wrap="truncate">
              {trunc(kicker, Math.max(1, right ? Math.floor(innerWidth * 0.55) : innerWidth))}
            </Text>
          ) : null}
          <Box flexGrow={1} />
          {right ? <Text wrap="truncate">{right}</Text> : null}
        </Box>
      ) : null}
      <Text color={accent} wrap="truncate">
        {'─'.repeat(innerWidth)}
      </Text>

      <Box flexDirection="column">{children}</Box>

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
  // Wider fallbacks than the other panels on purpose: the sidebar frame is
  // only meaningful at a size where a sidebar fits at all.
  const size = useTerminalSize({ fallbackColumns: 100, fallbackRows: 32 });
  return { width: size.columns, height: size.rows };
}
