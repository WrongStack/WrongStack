/**
 * Shared UI theme preset identifiers.
 *
 * Lives in core so the Config schema, the CLI `/theme` slash command, and
 * the TUI runtime can all reference the same string union without
 * importing the TUI package (which would invert the dependency direction).
 *
 * This array is the CANONICAL list. The CLI `/theme` command and the boot
 * theme adapter both derive their valid-id sets from it, so adding an entry
 * here needs exactly ONE follow-up: a matching palette + `THEME_OPTIONS` row
 * in `packages/tui/src/theme.ts`. Both are compile-enforced — `themePresets`
 * is typed `Record<ThemePresetId, Theme>` (no cast) and the CLI's `THEME_META`
 * is a total record — so a missing preset fails `tsc`, not the runtime.
 */
export const THEME_PRESET_IDS = [
  'catppuccin',
  'tokyo-night',
  'nord',
  'cyberpunk',
  'dracula',
  'gruvbox-dark',
  'solarized-dark',
  'one-dark',
  'monokai',
  'rose-pine',
  'kanagawa',
  'ayu-dark',
  'everforest',
  'night-owl',
  'synthwave',
  'github-dark',
  'material-ocean',
  'nightfox',
  'oxocarbon',
  'catppuccin-macchiato',
  'catppuccin-frappe',
  'gruvbox-material',
  'tokyo-night-storm',
  'rose-pine-moon',
  'zenburn',
  'palenight',
  'horizon',
  'sonokai',
  'edge-dark',
  'moonfly',
  'melange',
  'poimandres',
  'vitesse-dark',
  'aura',
  'dark-plus',
  'monochrome',
  'matrix',
  'amber',
  'cyber-noir',
  'cobalt-mono',
  'blood-moon',
  'cobalt2',
  'shades-of-purple',
  'flexoki-dark',
  'laserwave',
  'andromeda',
  'github-dark-dimmed',
  'snazzy',
  'tokyo-night-moon',
  'gruvbox-dark-hard',
] as const;

export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];
