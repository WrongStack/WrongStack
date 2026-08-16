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
import { flattenChildren } from '../react-children-flatten.js';
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
  // Wrap each top-level child of the body in a `│ ... │` row when
  // sides are enabled. The child's internal rows will inherit the
  // indentation from `bodyPadX` so they read as "inside the frame".
  // We use a recursive Fragment flattener instead of React.Children.toArray
  // because the latter does NOT unwrap Fragments — a `<>…</>` block with
  // three children is reported as a single element, which would collapse
  // the per-row side bars onto the first row only.
  //
  // Before flattening, walk the body and force every <Text> descendant to
  // use `wrap="truncate"`. Without this, a long un-truncated string would
  // soft-wrap into the next terminal line, push past the right `│` bar,
  // and visually break the card frame. The wrapper is purely defensive —
  // callers that already pass `wrap="truncate"` are no-ops.
  //
  // The middle Box uses an explicit `width` rather than `flexGrow={1}`
  // because Yoga was returning the box at its content's intrinsic width
  // when the inner child was short, leaving the right `│` bar stranded
  // off-frame. An explicit width pins the Box to `innerWidth - 2` cols
  // (the space between the two side bars) and `overflowX="hidden"` clips
  // any horizontally-overflowing content.
  const middleWidth = innerWidth - 2; // 2 cols for the two side bars
  const bodyContent = children(bodyContentWidth);
  const safeBodyContent = truncateTextChildren(bodyContent);
  const bodyRows = useSides
    ? flattenChildren(safeBodyContent).map((row, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <Box key={i} flexDirection="row" width={innerWidth}>
          <Text color={frameColor}>│</Text>
          <Box
            flexDirection="column"
            width={middleWidth}
            paddingX={bodyPadX}
            overflowX="hidden"
            overflowY="hidden"
          >
            {row}
          </Box>
          <Text color={frameColor}>│</Text>
        </Box>
      ))
    : bodyContent;
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
      <Box flexDirection="column" paddingX={useSides ? 0 : bodyPadX}>
        {bodyRows}
      </Box>
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
