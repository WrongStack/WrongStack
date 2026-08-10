/**
 * Shared UI theme preset identifiers.
 *
 * Lives in core so the Config schema, the CLI `/theme` slash command, and
 * the TUI runtime can all reference the same string union without
 * importing the TUI package (which would invert the dependency direction).
 *
 * Keep in lockstep with `THEME_OPTIONS` in `packages/tui/src/theme.ts`.
 * Adding a preset here is intentional — it also requires updating the TUI
 * presets map AND the CLI `VALID_PRESETS` set in `tui-theme-adapter.ts`.
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
] as const;

export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];
