import { accessiblePresets } from './theme-presets/accessible.js';
import { atomPresets } from './theme-presets/atom.js';
import { ayuPresets } from './theme-presets/ayu.js';
import { baseTheme } from './theme-presets/base.js';
import { catppuccinPresets } from './theme-presets/catppuccin.js';
import { everforestPresets } from './theme-presets/everforest.js';
import { flexokiPresets } from './theme-presets/flexoki.js';
import { githubPresets } from './theme-presets/github.js';
import { gruvboxPresets } from './theme-presets/gruvbox.js';
import { japanesePresets } from './theme-presets/japanese.js';
import { materialPresets } from './theme-presets/material.js';
import { misc1Presets } from './theme-presets/misc-1.js';
import { misc2Presets } from './theme-presets/misc-2.js';
import { misc3Presets } from './theme-presets/misc-3.js';
import { monoPresets } from './theme-presets/mono.js';
import { monoCrtPresets } from './theme-presets/mono-crt.js';
import { monokaiPresets } from './theme-presets/monokai.js';
import { nightfoxPresets } from './theme-presets/nightfox.js';
import { THEME_OPTIONS } from './theme-presets/options.js';
import { rosePinePresets } from './theme-presets/rose-pine.js';
import { synthwavePresets } from './theme-presets/synthwave.js';
import { tokyoNightPresets } from './theme-presets/tokyo-night.js';
import { vitessePresets } from './theme-presets/vitesse.js';
import type { Theme, ThemeName } from './theme-types.js';

export { baseTheme, THEME_OPTIONS };

/**
 * The canonical preset registry. The palette data itself lives in
 * `theme-presets/<family>.ts` modules — this file only composes them, per
 * the architecture hotspot guardrail on this path.
 *
 * Every colour key is written out explicitly in each preset rather than
 * inherited from `baseTheme`: fourteen presets once shipped Catppuccin body
 * text on their own palettes because they spread `...baseTheme` and forgot
 * to override the text tokens. `satisfies Record<string, Theme>` in the data
 * modules keeps each entry type-checked, and the annotation below keeps a
 * missing preset a compile error.
 */
export const themePresets: Record<ThemeName, Theme> = Object.freeze({
  ...accessiblePresets,
  ...atomPresets,
  ...ayuPresets,
  ...catppuccinPresets,
  ...everforestPresets,
  ...flexokiPresets,
  ...githubPresets,
  ...gruvboxPresets,
  ...japanesePresets,
  ...materialPresets,
  ...misc1Presets,
  ...misc2Presets,
  ...misc3Presets,
  ...monoPresets,
  ...monoCrtPresets,
  ...monokaiPresets,
  ...nightfoxPresets,
  ...rosePinePresets,
  ...synthwavePresets,
  ...tokyoNightPresets,
  ...vitessePresets,
});

/**
 * Spread composition drops TypeScript's duplicate-literal-key check (TS1117),
 * which is the one mistake a 21-module registry invites: two families both
 * declaring `nord` would last-win with no compile error, silently dropping a
 * theme. Comparing the summed group key count against the composed registry
 * restores that check, and names the offender at import time instead of
 * leaving it as a theme that quietly disappears from `/theme`.
 */
const presetGroups = [
  accessiblePresets,
  atomPresets,
  ayuPresets,
  catppuccinPresets,
  everforestPresets,
  flexokiPresets,
  githubPresets,
  gruvboxPresets,
  japanesePresets,
  materialPresets,
  misc1Presets,
  misc2Presets,
  misc3Presets,
  monoPresets,
  monoCrtPresets,
  monokaiPresets,
  nightfoxPresets,
  rosePinePresets,
  synthwavePresets,
  tokyoNightPresets,
  vitessePresets,
];

// Scan the PRE-collapse group keys: by the time two groups declare the same id,
// the spread has already merged them and `themePresets` cannot reveal which one
// collided. Iterating the groups is what makes naming the offender possible.
const declaredIds = presetGroups.flatMap((group) => Object.keys(group));
const registryIds = Object.keys(themePresets);
if (declaredIds.length !== registryIds.length) {
  const seen = new Set<string>();
  const dupes = declaredIds.filter((id) => seen.size === seen.add(id).size);
  throw new Error(
    dupes.length > 0
      ? `Duplicate theme preset id across theme-presets/ modules: ${dupes.map((d) => `"${d}"`).join(', ')}`
      : `theme-presets/ modules declare ${declaredIds.length} presets but the registry holds ${registryIds.length}`,
  );
}

export const themePickerOptions = THEME_OPTIONS;
