// Pure statusline-picker model (no Ink/React), shared by the picker view and
// the panel reducer.
import {
  CHIP_DESCRIPTIONS,
  DEFAULT_LINES,
  effectiveLine,
  resolveStatuslineOrder,
  STATUSLINE_DENSITY_CYCLE,
  STATUSLINE_FIELD_COUNT,
  STATUSLINE_ITEMS,
  type StatuslineDensity,
  type StatuslineItem,
  type StatuslineLines,
  type StatuslineOrder,
} from '@wrongstack/core/statusline';
import type { ChipMeta } from '../ui-contracts.js';

export type { StatuslineItem };
// Chip identity, render order, line/density assignment and descriptions live
// in the framework-free core contract (`@wrongstack/core/statusline`) — the
// single source shared with the CLI's statusline.json persistence.
// Re-exported here under the picker's historical names for its consumers.
export {
  CHIP_DESCRIPTIONS,
  DEFAULT_LINES,
  DEFAULT_LINES as ITEM_LINE,
  STATUSLINE_FIELD_COUNT,
  STATUSLINE_ITEMS,
};

/**
 * Chips the composer's top rail already renders, so the status bar suppresses
 * them to avoid a double display. They stay in `STATUSLINE_ITEMS` (the mouse
 * hit-test indexes by position) and stay togglable — the picker just labels
 * them so their "on" state doesn't read as a lie.
 */
export const COMPOSER_OWNED_CHIPS: StatuslineItem[] = ['state'];

/**
 * Metadata for a temporarily-visible chip (one that appeared due to data,
 * not user toggle). Tracked so the chip can auto-expire.
 *
 * Declared in the `ui-contracts` leaf and re-exported here under the picker's
 * historical name: `status-bar-types.ts` needs the type, and owning it in a
 * `.tsx` view module put the contracts leaf and the view in one type cycle.
 */
export type { ChipMeta };

/** Default expiration for stream-triggered chips (5 minutes). */
export const STREAM_CHIP_EXPIRES_IN_MINUTES = 5;

/**
 * Returns true if a chip with the given metadata has expired.
 * Chips with no `expiresIn` never expire on their own.
 */
export function isChipExpired(meta: ChipMeta, now = Date.now()): boolean {
  if (meta.expiresIn == null || meta.expiresIn === 0) return false;
  if (meta.shownAt == null || meta.shownAt === 0) return false;
  return now >= meta.shownAt + meta.expiresIn * 60 * 1000;
}

/**
 * Returns a human-readable countdown label for a chip with expiration.
 * Returns null if the chip has no expiration or has already expired.
 */
export function getExpiresInLabel(meta: ChipMeta, now = Date.now()): string | null {
  if (meta.expiresIn == null || meta.expiresIn === 0 || meta.shownAt == null) return null;
  const remainingMs = meta.shownAt + meta.expiresIn * 60 * 1000 - now;
  if (remainingMs <= 0) return null;
  if (remainingMs < 60_000) return 'expires in <1 m';
  const remainingMin = Math.ceil(remainingMs / 60_000);
  return `expires in ${remainingMin} m`;
}

/** Stream-triggered chips — these auto-expire unless toggled on permanently. */
export const STREAM_CHIP_KEYS: StatuslineItem[] = ['brain', 'mailbox', 'enhance', 'debug_stream'];

/** Next density in the cycle: auto → full → short → micro → auto. */
export function nextDensity(current: StatuslineDensity, delta = 1): StatuslineDensity {
  const index = STATUSLINE_DENSITY_CYCLE.indexOf(current);
  const size = STATUSLINE_DENSITY_CYCLE.length;
  const at = Math.max(index, 0) + delta;
  return STATUSLINE_DENSITY_CYCLE[((at % size) + size) % size]!;
}

/**
 * Whether `item` survives the picker's text filter. Matches the chip key and
 * its description so "cost" finds `cost` and "cache" finds the cache chip by
 * either its name or its blurb.
 */
export function matchesFilter(item: StatuslineItem, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return item.includes(needle) || CHIP_DESCRIPTIONS[item].toLowerCase().includes(needle);
}

/** Shared visual/keyboard order: effective line groups, then saved order within each line. */
export function navigableFields(
  filter: string,
  order: StatuslineOrder = [],
  lines: StatuslineLines = {},
): number[] {
  // Stable sorting preserves the rail's saved order among same-line siblings.
  const grouped = resolveStatuslineOrder(order).sort(
    (a, b) => effectiveLine(a, lines) - effectiveLine(b, lines),
  );
  const fields = grouped
    .map((item) => (matchesFilter(item, filter) ? STATUSLINE_ITEMS.indexOf(item) : -1))
    .filter((index) => index >= 0);
  return fields.length > 0 ? fields : grouped.map((item) => STATUSLINE_ITEMS.indexOf(item));
}
