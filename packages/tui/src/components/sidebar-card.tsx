// Shared "card" iskelet for both the persistent sidebar content and the
// routed F-key panel sidebar twins.
//
// This file is the single source of truth for the sidebar's raised surface
// chrome. The persistent cards (MODEL CORE, PROMPT CACHE, SYSTEM, AGENT
// SWARM, MISSIONS, SESSIONS — see `sidebar-content.tsx`) and the routed
// F-key panel twins (see `sidebar-panel-frame.tsx` and
// `sidebar-panels-{workspace,task}.tsx`) both compose this `Card` so a
// glance down the right rail reads as one visual family.
//
// Visual contract:
//   * `╭─…─╮ / ╰─…─╯` corner frame at the top and bottom of the card.
//   * Optional `│ … │` side bars on rails wide enough to afford them
//     (innerWidth >= 18). On narrower rails the body drops the sides so
//     the content never overflows the frame.
//   * Optional `accent` color paints the corners + sides so a green frame
//     reads as "healthy", red as "alerting", etc.
//   * `capped=false` drops the corner frame and falls back to a hairline
//     divider — used by the F-twin title rows where the parent frame
//     already owns the chrome.
//   * The body is rendered through a **render prop** `(bodyWidth) =>
//     ReactNode` so callers always size their content to the *insetted*
//     width, not the outer card width. This avoids the Ink pitfall where
//     a child `Box` with an explicit `width={innerWidth}` would overflow
//     the parent's `paddingX` and get clipped on the right.
//
// Width thresholds (corners at >= 10, sides at >= 18, padding at >= 18):
//   * < 10 cols → no corners, no sides (would collide with each other).
//   * 10–17 cols → corners only, body padding 0, no sides.
//   * >= 18 cols → corners + sides + body padding 1, full chrome.

import type React from 'react';
import { Box, Text } from '../ink.js';
import { truncateTextChildren } from '../react-wrap-truncate.js';
import { sidebarCardHairline, sidebarCardSurface, theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';

export interface CardProps {
  /** Outer content width in cols (already inside the parent frame's
   *  border + padding — i.e. the available width the card must fill). */
  innerWidth: number;
  /** Optional bottom margin (defaults to 0). Persistent cards chain with
   *  no margin; the F-twin frame usually adds its own spacing. */
  marginBottom?: number | undefined;
  /** Optional accent color for the top + bottom cap hairlines. When set,
   *  paints the frame in the panel's state color (green = healthy,
   *  red = alerting, etc.). */
  accent?: string | undefined;
  /** Draw the top + bottom hairline around the card body. When false, the
   *  Card renders only the body (no corners, no bottom rule) so it can be
   *  nested inside an outer frame without double-chroming. The F-twin
   *  SidebarPanelFrame uses this for the title row. */
  capped?: boolean | undefined;
  /**
   * Render-prop body. The Card walks the returned tree, flattens Fragments +
   * column Boxes, and wraps every top-level child in a `│ ... │` row so the
   * frame stays intact on every body line. `bodyWidth` is the inner content
   * width (already accounting for side bars + padding) so callers don't
   * have to recompute it.
   */
  children: (bodyWidth: number) => React.ReactNode;
}

/**
 * A raised "card" wrapper for the persistent sidebar content. The accent
 * top edge and hairlines stay at the card's full width to visually "frame"
 * it; the body content is inset by 1 column on each side so text never
 * touches the colored surface directly.
 */
export function Card({
  innerWidth,
  marginBottom = 0,
  accent,
  capped = true,
  children,
}: CardProps): React.ReactElement {
  const surface = sidebarCardSurface();
  // Frame color: the panel's `accent` (per-card state) when supplied,
  // else the default hairline tint. The accent paints the top + bottom
  // edge so a green frame = healthy, red = alerting, etc.
  const frameColor = accent ?? sidebarCardHairline();
  // Body padding by rail width: 0 cols on the narrowest rails (where
  // 2 cols of padding would force every text row to wrap), 1 col on
  // anything wider. The card is wrapped in a proper `╭───╮ / ╰───╯`
  // frame on rails wide enough to afford the 2 corner cols; the very
  // narrowest rails (where corners would collide) drop to a plain
  // hairline so we never truncate the body.
  const bodyPadX = innerWidth < 18 ? 0 : 1;
  const useCorners = innerWidth >= 10;
  // Side bars `│` cost 2 cols. Only show them on rails wide enough to
  // afford the side chrome (>= 18 cols) AND when the card is already
  // using corners — otherwise the box looks like a half-baked wireframe.
  // The 18-col threshold matches the body-padding gate: narrower rails
  // already drop the body padding to 0, so adding 2 more cols for sides
  // would push already-tight content past the wrap point.
  const useSides = useCorners && innerWidth >= 18;
  const sideWidth = useSides ? 1 : 0;
  // Inner body width accounts for the optional side bars + padding.
  const bodyContentWidth = Math.max(2, innerWidth - sideWidth * 2 - bodyPadX * 2);
  const bodyContent = children(bodyContentWidth);
  const safeBodyContent = truncateTextChildren(bodyContent);
  return (
    <Box
      flexDirection="column"
      width={innerWidth}
      marginBottom={marginBottom}
      {...(theme.supportsBackground ? { backgroundColor: surface } : {})}
    >
      {capped && useCorners ? (
        <Box width={innerWidth}>
          <Text
            color={frameColor}
          >{`╭${glyphs.dividerDash.repeat(Math.max(0, innerWidth - 2))}╮`}</Text>
        </Box>
      ) : null}
      {/* Sides on wide rails: one bordered Box paints `│` on EVERY visual
          line of the body — including soft-wrapped continuation lines and
          flex-wrap stacks — which the previous per-row `│ … │` Text wrapper
          could not do (its Text side bars only covered each row's first
          line). Round border side char is `│`, so the look is unchanged;
          content width math is identical (innerWidth − 2 for the two border
          cols). The old flattenChildren-based per-row mapping is retired. */}
      {useSides ? (
        <Box
          flexDirection="column"
          width={innerWidth}
          borderStyle="round"
          borderLeft
          borderRight
          borderTop={false}
          borderBottom={false}
          borderLeftColor={frameColor}
          borderRightColor={frameColor}
          paddingX={bodyPadX}
          overflowX="hidden"
          overflowY="hidden"
        >
          {safeBodyContent}
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={bodyPadX}>
          {/* Raw (un-truncated) body: narrow rails must keep full labels
              via soft-wrap — the worklist-wrap contract forbids `…` here. */}
          {bodyContent}
        </Box>
      )}
      {capped ? (
        useCorners ? (
          <Box width={innerWidth}>
            <Text
              color={frameColor}
            >{`╰${glyphs.dividerDash.repeat(Math.max(0, innerWidth - 2))}╯`}</Text>
          </Box>
        ) : (
          <Box width={innerWidth}>
            <Text color={frameColor}>{glyphs.dividerDash.repeat(Math.max(0, innerWidth))}</Text>
          </Box>
        )
      ) : null}
    </Box>
  );
}
