/**
 * Wrap-geometry module tests.
 *
 * The module now only single-sources the inline render-chrome constants
 * (`USER_LABEL`, `INFO_PREFIX`) that entry.tsx renders inline before user/
 * info card text. The row-map machinery (buildBodyRowMap / hasWrapMap /
 * resolveRowCol) was removed on 2026-08-29 when drag-select copy became
 * block-based (selection-helpers.ts): whole-block copies need the entry's
 * source text, not per-row geometry.
 *
 * What remains load-bearing is the cells === code-units assumption: any
 * column math built on these prefixes is exact only while each prefix
 * character occupies exactly one terminal cell per UTF-16 code unit
 * (👤 is a surrogate pair: 2 units AND 2 cells; a flag emoji would be
 * 4 units but 2 cells). This pin fails loudly if a future prefix edit
 * breaks that coincidence.
 */

import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { INFO_PREFIX, USER_LABEL } from '../src/components/history/wrap-geometry.js';

describe('inline render-chrome constants (user label / info icon)', () => {
  it('pins the cells === code-units assumption both prefixes rely on', () => {
    // The former row-map machinery subtracted prefixChars (UTF-16 code
    // units) while column clamps subtracted prefixWidth (terminal cells);
    // the two models coincide ONLY while each prefix char is 1 code unit
    // per cell. A prefix that breaks this (a flag emoji is 4 units but
    // 2 cells) would desynchronize any span-vs-clamp math silently —
    // this pin fails loudly instead.
    expect(stringWidth(USER_LABEL)).toBe(USER_LABEL.length);
    expect(stringWidth(INFO_PREFIX)).toBe(INFO_PREFIX.length);
  });
});
