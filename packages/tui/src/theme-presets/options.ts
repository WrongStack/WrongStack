import { THEME_PRESET_IDS, THEME_PRESET_META } from '@wrongstack/contracts/types';
import type { ThemePickerOption } from '../theme-types.js';

/**
 * Picker rows in canonical {@link THEME_PRESET_IDS} order.
 *
 * Name/description/family are NOT written here: they come from
 * `THEME_PRESET_META` in `@wrongstack/core/types`, the single table the CLI
 * `/theme` command reads too. This file used to hand-write a 64-row literal
 * that duplicated the CLI's own table, so a reworded or renamed preset could
 * drift between the two pickers with nothing failing to compile — only the
 * id set was ever linked.
 *
 * Deriving from the shared record also means the family grouping the picker
 * renders and the CLI's list are guaranteed to describe the same presets.
 */
export const THEME_OPTIONS: readonly ThemePickerOption[] = THEME_PRESET_IDS.map((id) => ({
  id,
  name: THEME_PRESET_META[id].name,
  description: THEME_PRESET_META[id].description,
  family: THEME_PRESET_META[id].family,
})).sort(
  // Group by family, keeping canonical order WITHIN each family.
  //
  // `THEME_PRESET_IDS` is not family-ordered — the Catppuccin variants sit
  // ~15 rows apart, and the three `misc-N` buckets scatter single palettes
  // across the whole list. Sorting here (rather than in the picker) is what
  // makes the grouping usable: the reducer, the Enter handler and the rendered
  // window all index into THIS array, so reordering it in one place keeps
  // `selected` meaning the same thing everywhere.
  //
  // `Array.prototype.sort` is stable, so sorting only on `family` preserves
  // canonical order inside each group without a second comparison.
  (a, b) => a.family.localeCompare(b.family),
);
