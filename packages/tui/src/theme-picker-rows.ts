/**
 * Pure selection/windowing logic behind the `/theme` picker.
 *
 * The picker used to window a flat list of 64 rows. Three additions made that
 * arithmetic wrong on its own:
 *
 *   - **Filtering.** Type-to-filter narrows the list, so the focused index is
 *     an index into the FILTERED list, not the full catalogue.
 *   - **Family grouping.** Headers are real rows now, and they differ in cost
 *     from option rows — a uniform `rowSpan` can no longer describe the list.
 *   - **The row budget.** `maxRows` is a hard contract the existing tests
 *     assert; adding header rows must not silently overflow it.
 *
 * So the picker now operates on a *row model* (headers + options interleaved)
 * and windows over rows rather than over option indices. Everything here is a
 * pure function of its arguments — no React, no Ink, no `useTerminalSize` — so
 * the budget and windowing rules are unit-testable without rendering a frame.
 */

import type { ThemePickerOption } from './theme-types.js';

/** One rendered line: either a family header or a selectable preset row. */
export type ThemeRow =
  | { kind: 'header'; family: string }
  | { kind: 'option'; option: ThemePickerOption; index: number };

/**
 * Narrow presets by a free-text query, matching name, id, and description.
 *
 * An empty or whitespace-only query returns the input unchanged so the common
 * "filter cleared" case is free and the caller keeps a stable array identity.
 * Matching is case-insensitive and substring-based; every whitespace-separated
 * term must match somewhere (AND), so `tokyo storm` narrows to the Storm
 * variant rather than the union of both words.
 */
export function filterThemeOptions(
  options: readonly ThemePickerOption[],
  query: string,
): readonly ThemePickerOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return options;
  return options.filter((opt) => {
    const haystack = `${opt.name} ${opt.id} ${opt.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Interleave family headers with option rows.
 *
 * A header is emitted before the first row of each family, so contiguous
 * same-family presets share one header. `index` is each option's position in
 * the *filtered* list, which is what `selected` refers to.
 */
export function buildThemeRows(options: readonly ThemePickerOption[]): ThemeRow[] {
  const rows: ThemeRow[] = [];
  let lastFamily: string | undefined;
  for (const [index, option] of options.entries()) {
    if (option.family !== lastFamily) {
      rows.push({ kind: 'header', family: option.family });
      lastFamily = option.family;
    }
    rows.push({ kind: 'option', option, index });
  }
  return rows;
}

export interface ThemeWindow {
  /** Rows to render, header rows included. */
  rows: ThemeRow[];
  hasAbove: boolean;
  hasBelow: boolean;
}

/**
 * Window the row model so it fits `budget` terminal rows.
 *
 * `budget` is the number of rows available for headers + options combined
 * (the caller subtracts its own chrome). Two rules the flat list did not need:
 *
 *   - A family header is pulled in whenever its first option is in the window,
 *     even if that header sits above the window's nominal start — otherwise the
 *     top visible option would appear to belong to the family above it.
 *   - Expansion alternates downward first, then upward, so a long family does
 *     not push every visible row below the focused one off the screen.
 *
 * The focused row is always included, even when `budget` is smaller than the
 * two rows a focused option plus its header need — the caller's own
 * lower-bound guarantee wins over a strict budget.
 */
export function windowThemeRows(
  rows: readonly ThemeRow[],
  selected: number,
  budget: number,
): ThemeWindow {
  if (rows.length === 0) return { rows: [], hasAbove: false, hasBelow: false };

  const focusPos = Math.max(
    0,
    rows.findIndex((r) => r.kind === 'option' && r.index === selected),
  );

  // Row position of the header that governs the focused option, so a window
  // starting mid-family still shows the family it belongs to.
  let headerPos = focusPos;
  for (let i = focusPos; i >= 0; i -= 1) {
    if (rows[i]!.kind === 'header') {
      headerPos = i;
      break;
    }
  }

  const safeBudget = Number.isFinite(budget) ? Math.floor(budget) : 2;
  const capacity = Math.max(2, safeBudget);
  // Deep inside a family the governing header can sit many rows above the
  // focused option, so header..focus can already exceed the budget on its own.
  // The budget is a hard contract (`maxRows` is what keeps the box inside a
  // 24-row terminal), so when the two conflict the header loses: show the
  // focused row on its own rather than overflow.
  let start = focusPos + 1 - headerPos <= capacity ? headerPos : focusPos;
  let end = focusPos + 1;
  let used = end - start;

  // Grow downward. A header is only pulled in when the row being added IS a
  // header, or when it is an option whose own family header sits immediately
  // above the current end (i.e. the window is about to cut into a new family
  // without its label).
  while (used < capacity && end < rows.length) {
    const cost = needsHeaderAbove(rows, end) ? 2 : 1;
    if (used + cost > capacity) break;
    end += cost;
    used += cost;
  }

  // Grow upward.
  while (used < capacity && start > 0) {
    start -= 1;
    used += 1;
  }

  return {
    rows: rows.slice(start, end),
    hasAbove: start > 0,
    hasBelow: end < rows.length,
  };
}

/**
 * True when rendering the option at `pos` also requires the header row that
 * precedes it to be visible — either because `rows[pos]` is itself a header,
 * or because `rows[pos - 1]` is a header (the new family starts right here).
 * A header never "needs" the row above a cut when the option directly follows
 * another option of the same family, so the window stays tight.
 */
function needsHeaderAbove(rows: readonly ThemeRow[], pos: number): boolean {
  const row = rows[pos];
  if (row === undefined) return false;
  return row.kind === 'header' || rows[pos - 1]?.kind === 'header';
}
