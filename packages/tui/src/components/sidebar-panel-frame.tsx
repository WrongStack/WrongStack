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
// Modernization notes (v3):
//   * The chrome (corners + sides + body chrome) is now the shared
//     `Card` iskelet from `./sidebar-card.tsx`, so the routed F twins
//     and the persistent cards render the same family of frame. The
//     `SidebarPanelFrame` wrapper composes the title row, status row,
//     optional kicker, body, and footer on top of that shared `Card`.
//   * The `SidebarPanelCard` export is preserved as an alias for the
//     shared `Card` (with `capped` defaulted) so existing test fixtures
//     and direct callers (e.g. `card-frame-integrity.test.tsx`) keep
//     working without changes.
//   * Title chrome by rail width:
//       wide  (>=18) → `╭─ ICON TITLE ── ... ── ⟦pill⟧ ╮`
//       mid   (>=10) → `▎ ICON TITLE ── ... ──⟦pill⟧`
//       narrow(<10)  → `▎ICON TITLE···⟦pill⟧` (pill is truncated; if there
//                      really is no room, the pill is dropped and the
//                      full title is preserved).
//     The pill is the panel's "live state" signal — when there is no room
//     for both, the title is preserved and the pill is rendered (or the
//     status is bumped to a second line) rather than truncating the title.

import type { ReactNode } from 'react';
import React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { displayWidth, truncateDisplay } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { Card, type CardProps } from './sidebar-card.js';

interface SidebarPanelFrameProps {
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
  /**
   * Body content. Pass a function to receive the Card's *body content width*
   * (the inset width after the Card's optional `│` sides and body padding,
   * not the outer card width). This mirrors the `Card` render prop and lets
   * `SidebarSectionHeader` / `SidebarStatRow` / `SidebarWorklistRow` size
   * their dotted leaders and metric columns to the actual available width
   * instead of over-shooting into the Card's side bars.
   */
  children?: React.ReactNode | ((bodyWidth: number) => React.ReactNode) | undefined;
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
function SidebarStatusPill({
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
  // Note: we deliberately do NOT set `width={innerWidth}` on the Box here.
  // The Card's per-row wrapper already constrains the middle slot to
  // `innerWidth - 2` (the space between the two `│` bars). If we re-set
  // the full innerWidth, the Box would overflow the middle slot by 2
  // columns and visually cover the right `│` bar. Letting Yoga size the
  // Box to its content keeps it inside the middle slot.
  return (
    <Box flexDirection="row" width={innerWidth}>
      {accent ? (
        <Text color={accent} bold>
          {glyphs.railMid}
        </Text>
      ) : null}
      <Text color={theme.textMuted} wrap="truncate">
        {left}
      </Text>
      <Text color={theme.borderSubtle}>{glyphs.dividerDot.repeat(Math.max(2, fill))}</Text>
      <Text color={valueMuted ? theme.textMuted : color} bold={!valueMuted} wrap="truncate">
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

/**
 * A thin wrapper around the shared `Card` iskelet from
 * `./sidebar-card.tsx`. Preserved as a public export so existing test
 * fixtures and direct callers (e.g. `card-frame-integrity.test.tsx`) keep
 * working without changes. The new shared `Card` carries an extra `capped`
 * flag (defaulting to `true` for the legacy semantic of always drawing
 * the top + bottom cap); routed F-twin callers that want a hairline
 * divider instead of a corner frame should use the shared `Card` directly
 * with `capped={false}`.
 */
export function SidebarPanelCard(props: CardProps): React.ReactElement {
  return <Card {...props} />;
}

/**
 * SidebarPanelFrame — the standard chrome wrapper used by every sidebar
 * panel variant. It composes a title row + optional status row + optional
 * kicker + body on top of the shared `Card` iskelet from
 * `./sidebar-card.tsx` (the same family the persistent MODEL CORE /
 * PROMPT CACHE / SYSTEM / AGENT SWARM / MISSIONS / SESSIONS cards use),
 * followed by an optional footer rendered below the card. The outer
 * RightSidebar still owns the border + padding + viewport clipping so
 * the routed frame's corners sit flush with the persistent cards down
 * the rail.
 *
 * v3: the chrome is delegated to the shared `Card` so the routed F twins
 * and the persistent cards read as one family at a glance. The previous
 * hand-rolled "borderless" title chrome is gone — the Card corners are
 * the only top/bottom rule. The `▎` rail at the title row's left edge is
 * preserved as the panel's accent signal (matching the persistent cards'
 * stage banner style), and the `│` sides from the Card body supply the
 * "framed" look on rails wide enough to afford them.
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
  // RightSidebar already owns the rail border and padding. The routed frame
  // is full-width and relies on the shared Card for its corners / sides.
  const innerWidth = Math.max(8, width);
  const showKicker = !!kicker && innerWidth >= 24;
  const pillTone = pillColor ?? accent;
  const effectivePill = pillLabel ? (
    <SidebarStatusPill label={pillLabel} color={pillTone} />
  ) : (
    right
  );

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Card innerWidth={innerWidth} accent={accent}>
        {(bodyWidth) => (
          <Box flexDirection="column" width={innerWidth}>
            {/* Title row: rail glyph + icon + title (+ optional right pill).
                Wide rails (>= 22) absorb the pill on the title row's right
                edge so we don't waste a row; narrower rails bump the pill
                to a second status row beneath the title. */}
            <Box flexDirection="row" width={innerWidth}>
              <Text color={accent} bold>
                {glyphs.railHeavy}
              </Text>
              <Text> </Text>
              <Text color={accent} bold wrap="truncate">
                {icon}
              </Text>
              <Text> </Text>
              <Text color={accent} bold wrap="truncate">
                {trunc(
                  title,
                  Math.max(
                    2,
                    innerWidth -
                      4 -
                      (effectivePill && innerWidth >= 22
                        ? displayWidth(getPillLabel(effectivePill)) + 2
                        : 0),
                  ),
                )}
              </Text>
              {effectivePill && innerWidth >= 22 ? (
                <>
                  <Box flexGrow={1} />
                  {effectivePill}
                </>
              ) : null}
            </Box>
            {/* Status row: pill (when not on title) + kicker (when wide). */}
            {effectivePill && innerWidth < 22 ? (
              <Box flexDirection="row" width={innerWidth}>
                <Text color={theme.borderSubtle}>{glyphs.dividerDash}</Text>
                <Text> </Text>
                <Text wrap="truncate">{effectivePill}</Text>
                <Box flexGrow={1} />
                <Text color={theme.borderSubtle}>{glyphs.dividerDash}</Text>
              </Box>
            ) : null}
            {showKicker ? (
              <Box flexDirection="row" width={innerWidth}>
                <Text color={theme.textMuted} dimColor wrap="truncate">
                  {trunc(kicker ?? '', Math.max(1, innerWidth - 2))}
                </Text>
              </Box>
            ) : null}
            {/* Body: the panel's sectioned content (no nested cards). The
                bodyWidth comes from the Card's render prop so section
                headers, stat rows, and worklist rows size their dotted
                leaders to the *inset* content width (after the Card's
                optional `│` sides and body padding), not the outer
                Card width. */}
            <Box flexDirection="column" width={innerWidth}>
              {typeof children === 'function' ? children(bodyWidth) : children}
            </Box>
          </Box>
        )}
      </Card>
      {footer ? (
        <Box height={1} marginTop={1} width={innerWidth}>
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
 * Render the pill's inner label as a string for the title-row width budget.
 * The `effectivePill` is either a `SidebarStatusPill` element OR a custom
 * `right` node. We only need the label when the pill is the standard
 * `SidebarStatusPill`, which is the common case; for custom `right` nodes
 * we conservatively budget 0 cols (the title truncates to the available
 * width without the pill eating into it).
 */
function getPillLabel(pill: ReactNode): string {
  if (
    React.isValidElement(pill) &&
    (pill.type as { displayName?: string; name?: string })?.name === 'SidebarStatusPill'
  ) {
    const props = pill.props as { label?: string };
    return props.label ?? '';
  }
  return '';
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
