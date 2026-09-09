/**
 * Shared geometry for the committed tool card / tool group header.
 *
 * The header is rendered as a single `<Text>` run but hit-tested by column in
 * `copy-registry.ts`, so the two MUST agree on where the ▲ / ▼ view-mode
 * controls sit. They did not: the registry hard-coded columns 2 and 5 while
 * the glyphs render at 3 and 6 (the card lead is three cells), so a click on
 * either triangle landed one cell left of the glyph and did nothing. Both
 * sides now derive their columns from the strings below — the same
 * render/hit-test single-source pattern the status-bar chips use.
 */

import { displayWidth } from '../../terminal-width.js';

/** Card lead for a card that owns a body (`hasBody`), and for a closed one. */
export const CARD_LEAD_OPEN = '╭─ ';
export const CARD_LEAD_CLOSED = '└─ ';

/** "Show less" (▲) and "show more" (▼) controls: glyph plus two spaces. */
export const VIEW_CONTROL_LESS = '▲  ';
export const VIEW_CONTROL_MORE = '▼  ';
export const VIEW_CONTROL_PREFIX = `${VIEW_CONTROL_LESS}${VIEW_CONTROL_MORE}`;

/**
 * Clickable width of one control: the glyph plus one trailing space. A
 * one-cell-wide target in a one-row-tall header is unforgiving enough that a
 * correct column still feels broken. The SECOND trailing space is
 * deliberately excluded so a dead cell separates the two controls and a
 * slightly-right click on ▲ can never fire ▼.
 */
export const VIEW_CONTROL_HIT_WIDTH = 2;

/**
 * 0-based history-band columns of the two controls. Both card leads are the
 * same width, so the columns do not depend on `hasBody` or view mode.
 */
export function viewControlColumns(): { lessCol: number; moreCol: number } {
  const lessCol = displayWidth(CARD_LEAD_OPEN);
  return { lessCol, moreCol: lessCol + displayWidth(VIEW_CONTROL_LESS) };
}
