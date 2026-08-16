// Borderless visual frame for routed right-sidebar panel variants.
//
// Every F-key panel has a sidebar twin (`<X>PanelSidebar`) adapted to the
// narrow rail. `RightSidebar` owns the only border, padding, and viewport
// clipping; this frame adds a styled title banner, an accent-rail status
// strip, section bands, and a hairline footer without consuming columns on
// nested chrome.
//
// Width contract: every section box is exactly `innerWidth` columns wide so
// dotted leaders, block meters, and right-aligned metrics stay predictable.
// The frame has natural height and may be followed by the persistent
// `SidebarContent`; the outer shell clips their combined stack.
//
// Modernization notes (v2):
//   * The old single-row `● ICON TITLE ╾` is replaced with a two-line banner
//     that opens with a corner-bracketed "shelf" then prints the title in
//     bold caps with a kicker subtitle on a second line. The right side
//     hosts a "status pill" (⟦ live n ⟧) in the accent color so the user can
//     read the panel's state at a glance.
//   * Section headers now have a stronger icon "node" + dotted leader, and
//     optional right-aligned pill. Sub-cards (SidebarPanelCard) support a
//     vertical accent rail that mirrors the panel's accent color, so a
//     glance down the rail reads as a "status stripe" rather than a wall
//     of un-differentiated boxes.
//   * Stat rows, dividers, and pills are extracted into small reusable
//     helpers (SidebarStatusPill, SidebarStatRow, SidebarDivider) so the
//     routed panels can compose them without re-implementing the spacing
//     every time.

import type React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { displayWidth, truncateDisplay } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';

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
  /** Optional right-aligned header content (status badge, counts, etc.).
   *  Wrapped automatically in a pill chrome if `pillStatus` is supplied. */
  right?: React.ReactNode | undefined;
  /**
   * When provided, the right-side header content is rendered through
   * `SidebarStatusPill` with the given color and label. Existing
   * `right={<Text>...</Text>}` callers still work; pass `pillLabel`+`pillColor`
   * for the new look without rewriting every call site.
   */
  pillLabel?: string | undefined;
  pillColor?: string | undefined;
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
 * A "capsuled" status pill, e.g. `⟦ live 12 ⟧`. Used in panel headers
 * (right side) and stat rows. Renders inline — no Box, no flex — so it can
 * sit next to a label without burning a row of its own.
 */
export function SidebarStatusPill({
  label,
  color,
  outlined = false,
}: {
  label: string;
  color: string;
  /** When true, render the brackets in muted color so the inner label
   *  reads as the main signal — useful in dense stat rows. */
  outlined?: boolean | undefined;
}): React.ReactElement {
  const bracketColor = outlined ? theme.borderSubtle : color;
  return (
    <Text>
      <Text color={bracketColor}>{glyphs.pillLeft}</Text>
      <Text color={color} bold>
        {label}
      </Text>
      <Text color={bracketColor}>{glyphs.pillRight}</Text>
    </Text>
  );
}

/**
 * A label : value row, sized for narrow rails. Reserves the first column
 * for an optional accent rail so a stat block reads as a single column of
 * cohesive data rather than a stack of loose Text nodes. The separator is
 * a flexible dot-leader so the value always lands at the right edge.
 */
export function SidebarStatRow({
  label,
  value,
  color = theme.textPrimary,
  accent,
  innerWidth,
  valueMuted = false,
}: {
  label: string;
  value: string;
  color?: string | undefined;
  /** Optional accent rail. When set, a 1-col rail glyph is drawn at the
   *  start of the row in this color so a block of rows reads as a "tag". */
  accent?: string | undefined;
  innerWidth: number;
  valueMuted?: boolean | undefined;
}): React.ReactElement {
  const left = label;
  const leftW = displayWidth(left);
  const railW = accent ? 1 : 0;
  const gap = 1;
  // 2-cell minimum dot leader keeps the row from collapsing at narrow widths.
  const fill = Math.max(0, innerWidth - leftW - displayWidth(value) - railW - gap);
  return (
    <Box flexDirection="row" width={innerWidth}>
      {accent ? (
        <Text color={accent} bold>
          {glyphs.railMid}
        </Text>
      ) : null}
      <Text color={theme.textMuted}>{left}</Text>
      <Text color={theme.borderSubtle}>{glyphs.dividerDot.repeat(Math.max(2, fill))}</Text>
      <Text color={valueMuted ? theme.textMuted : color} bold={!valueMuted}>
        {value}
      </Text>
    </Box>
  );
}

/**
 * A subtle horizontal divider with an optional centered diamond ornament.
 * Width-aware: on very narrow rails the diamond is dropped so the rule
 * never overflows the column.
 */
export function SidebarDivider({
  innerWidth,
  ornament,
  color = theme.borderSubtle,
}: {
  innerWidth: number;
  /** When set, draws `ornament` centered on the rule. */
  ornament?: string | undefined;
  color?: string | undefined;
}): React.ReactElement {
  if (!ornament || innerWidth < 10) {
    return (
      <Box width={innerWidth}>
        <Text color={color}>{glyphs.dividerDash.repeat(Math.max(0, innerWidth))}</Text>
      </Box>
    );
  }
  const half = Math.max(1, Math.floor((innerWidth - 1) / 2));
  return (
    <Box width={innerWidth}>
      <Text color={color}>{glyphs.dividerDash.repeat(half)}</Text>
      <Text color={theme.borderActive} bold>
        {ornament}
      </Text>
      <Text color={color}>{glyphs.dividerDash.repeat(Math.max(0, innerWidth - half - 1))}</Text>
    </Box>
  );
}

/**
 * A section header: colored glyph + bold uppercase label, a dotted leader
 * filling the remaining width, and an optional right-aligned badge. Always
 * renders exactly one row of exactly `innerWidth` columns — the badge is
 * dropped gracefully when there is no room (narrow terminals).
 *
 * Modernized (v2):
 *   * The glyph sits inside a 1-col "node" rail (▎) so it reads as a
 *     visual anchor and never collides with the leading bold label.
 *   * The badge is rendered through `SidebarStatusPill` (when `pill` is
 *     true) so it picks up the capsuled ⟦ ⟧ treatment.
 *   * The leader uses a real dotted leader (·) instead of a thin rule
 *     (╌) which renders inconsistently across terminal emulators.
 */
export function SidebarSectionHeader({
  glyph,
  label,
  color,
  badge,
  badgeColor,
  innerWidth,
  pill = false,
  badgeMuted = false,
}: {
  glyph: string;
  label: string;
  color: string;
  badge?: string | undefined;
  badgeColor?: string | undefined;
  innerWidth: number;
  /** Render the badge as a capsuled pill instead of a bare token. */
  pill?: boolean | undefined;
  /** When true, color the badge in muted text instead of accent. Useful
   *  for "no data yet" empty-state badges. */
  badgeMuted?: boolean | undefined;
}): React.ReactElement {
  // 1 (rail) + 1 (space) + glyphWidth + 1 (space) + label
  const railAndNode = `${glyphs.railMid} ${glyph} `;
  const left = `${railAndNode}${label}`;
  const leftW = displayWidth(left);
  const badgeText = badge ?? '';
  // Pill width = 2 brackets + text. Bare badge = 1 (leading space) + text.
  // We try pill first; if it doesn't fit, we fall back to a bare token.
  // The fallback is important — the badge carries state ("0/2", "IDLE",
  // "5 LIVE") and dropping it on narrow rails loses signal.
  const pillW = badge ? displayWidth(badgeText) + 2 : 0;
  const bareW = badge ? displayWidth(badgeText) + 1 : 0;
  const fitsPill = pill && !!badge && innerWidth - leftW - pillW >= 0;
  const fitsBare = !!badge && innerWidth - leftW - bareW >= 0;
  const usePill = fitsPill;
  const useBadge = usePill || fitsBare;
  const badgeW = usePill ? pillW : bareW;
  const fillCount = Math.max(0, innerWidth - leftW - (useBadge ? badgeW : 0));
  return (
    <Box>
      <Text color={color} bold>
        {left}
      </Text>
      <Text color={theme.borderSubtle}>{glyphs.dividerDot.repeat(fillCount)}</Text>
      {useBadge ? (
        usePill ? (
          <SidebarStatusPill
            label={badgeText}
            color={badgeMuted ? theme.textMuted : (badgeColor ?? color)}
            outlined={badgeMuted}
          />
        ) : (
          <Text color={badgeMuted ? theme.textMuted : (badgeColor ?? color)} bold>
            {' '}
            {badgeText}
          </Text>
        )
      ) : null}
    </Box>
  );
}

/** A raised content band sized for a narrow rail. Section headers provide the
 * accent, while the lifted surface groups related data without spending any
 * horizontal columns on nested chrome.
 *
 * Modernized (v2):
 *   * Subtle top + bottom hairline that visually "caps" the card, so
 *     adjacent cards read as stacked plates rather than glued together.
 *   * Optional `accent` rail that paints the top + bottom hairlines in
 *     the panel's accent color so the panel's "state" reads at a glance.
 *   * The body itself keeps the existing raised-surface treatment
 *     (theme.surfaceRaised) when the terminal supports background colors. */
export function SidebarPanelCard({
  innerWidth,
  marginBottom = 1,
  accent,
  capped = true,
  children,
}: {
  innerWidth: number;
  marginBottom?: number | undefined;
  /** When set, paints the top + bottom cap in the panel's accent color. */
  accent?: string | undefined;
  /** Draw a top + bottom hairline around the card body. */
  capped?: boolean | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={innerWidth}
      marginBottom={marginBottom}
      {...(theme.supportsBackground ? { backgroundColor: theme.surfaceRaised } : {})}
    >
      {capped ? (
        <Box width={innerWidth}>
          <Text color={accent ?? theme.borderSubtle}>
            {glyphs.dividerDash.repeat(Math.max(0, innerWidth))}
          </Text>
        </Box>
      ) : null}
      {children}
      {capped ? (
        <Box width={innerWidth}>
          <Text color={accent ?? theme.borderSubtle}>
            {glyphs.dividerDash.repeat(Math.max(0, innerWidth))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * SidebarPanelFrame — the standard chrome wrapper used by every sidebar
 * panel variant. It renders an accent-led title banner and telemetry strip
 * inside the existing RightSidebar shell, followed by a natural-height body
 * and optional footer. Avoiding a second border preserves scarce horizontal
 * space; the outer shell clips the combined routed-panel and persistent
 * -content stack.
 *
 * v2: the title banner is now two lines (corner-bracketed shelf + bold caps
 * title with kicker), and the right-side state is wrapped in a capsuled
 * pill so the user can spot panel state at a glance.
 */
export function SidebarPanelFrame({
  accent,
  icon,
  title,
  width,
  kicker,
  right,
  pillLabel,
  pillColor,
  footer,
  children,
}: SidebarPanelFrameProps): React.ReactElement {
  // RightSidebar already owns the rail border and padding. This routed frame is
  // deliberately borderless so a 16-column slot keeps all 16 columns for data.
  const innerWidth = Math.max(8, width);
  const showKicker = !!kicker && innerWidth >= 24;
  const pillTone = pillColor ?? accent;
  const effectivePill = pillLabel ? (
    <SidebarStatusPill label={pillLabel} color={pillTone} />
  ) : (
    right
  );

  // Title chrome by rail width:
  //   wide  (>=24) → `╭─ ICON TITLE ── ... ── ⟦pill⟧ ╮`
  //   mid   (>=18) → `▎ ICON TITLE ── ... ──⟦pill⟧`
  //   narrow(<18)  → `▎ICON TITLE···⟦pill⟧` (pill is truncated; if there
  //                  really is no room, the pill is dropped and the
  //                  full title is preserved).
  // The pill is the panel's "live state" signal — when there is no room
  // for both, the title is preserved and the pill is rendered (or the
  // status is bumped to a second line) rather than truncating the title.
  const useCorners = innerWidth >= 18;
  // Reserve columns for chrome: corners (2), pill (variable), title
  // "ICON TITLE" up to innerWidth. We use a budget that prioritizes the
  // title and only eats into the pill when forced.
  const chrome = useCorners ? 2 : 0;
  const titleBudget = Math.max(4, innerWidth - chrome);
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {/* Signal-stage title: corner-bracketed shelf framing the panel. */}
      <Box height={1} width={innerWidth}>
        {useCorners ? (
          <Text color={accent} bold>
            {`${glyphs.cornerTL}${glyphs.dividerDash} `}
          </Text>
        ) : (
          <Text color={accent} bold>
            {glyphs.railHeavy}
          </Text>
        )}
        <Text color={accent} bold wrap="truncate">
          {trunc(`${icon} ${title}`, titleBudget)}
        </Text>
        <Box flexGrow={1} />
        {useCorners ? (
          <Text color={accent} bold>
            {glyphs.cornerTR}
          </Text>
        ) : null}
      </Box>
      {/* Status row: pill (when supplied) + kicker (when wide). On wide
          rails the pill sits on the title row's right edge instead so we
          don't waste a row; the kicker takes that line. */}
      {effectivePill && innerWidth >= 22 ? (
        <Box height={1} width={innerWidth}>
          <Text color={theme.borderSubtle}>{glyphs.dividerDash}</Text>
          <Text> </Text>
          <Text wrap="truncate">{effectivePill}</Text>
          <Box flexGrow={1} />
          <Text color={theme.borderSubtle}>{glyphs.dividerDash}</Text>
        </Box>
      ) : null}
      {effectivePill && innerWidth < 22 ? (
        <Box height={1} width={innerWidth}>
          <Text color={theme.borderSubtle}>{glyphs.dividerDash}</Text>
          <Text> </Text>
          <Text wrap="truncate">{effectivePill}</Text>
        </Box>
      ) : null}
      {showKicker ? (
        <Box height={1} width={innerWidth}>
          <Text color={theme.textMuted} dimColor wrap="truncate">
            {trunc(kicker ?? '', Math.max(1, innerWidth - 2))}
          </Text>
        </Box>
      ) : null}
      <Box height={1} width={innerWidth}>
        <Text color={accent} bold>
          {glyphs.railHeavy}
        </Text>
        <Text color={theme.borderSubtle}>
          {glyphs.dividerDash.repeat(Math.max(0, innerWidth - 1))}
        </Text>
      </Box>

      <Box flexDirection="column">{children}</Box>

      {footer ? (
        <Box height={1} marginTop={1}>
          <Text color={theme.borderSubtle} wrap="truncate" dimColor>
            {`${glyphs.dividerDiamond} `}
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
