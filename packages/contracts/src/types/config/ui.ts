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
  // Added by the 2026-09 theme rework: ports of palettes that were missing,
  // plus four original palettes aimed at gaps the ports could not fill
  // (AAA contrast, colour-vision deficiency, warm neutrals, deepest Everforest).
  'oceanic-next',
  'one-half-dark',
  'ayu-mirage',
  'seti',
  'paraiso-dark',
  'darcula',
  'slack-dark',
  'vitesse-black',
  'atom-dark',
  'github-dark-high-contrast',
  'contrast-max',
  'colorblind-safe',
  'sandstone',
  'everforest-hard',
] as const;

export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];

/**
 * Sentinel stored in `Config.themePreset` to mean "rotate the palette every
 * `RANDOM_THEME_ROTATION_MS` instead of pinning one".
 *
 * This exists so rotation is EXPLICIT rather than inferred from an absent
 * value. `useThemeState` historically treated any falsy `themePreset` (and an
 * absent ConfigStore) as random mode, which made "the user chose random" and
 * "nothing was ever configured" indistinguishable — so picking a palette in
 * `/theme` silently pinned it with no way back to rotation.
 */
export const THEME_RANDOM_ID = 'random';

export type ThemeName = ThemePresetId | typeof THEME_RANDOM_ID;

/** Display metadata for one preset, as shown by both the TUI and CLI pickers. */
export interface ThemePresetMeta {
  /** Human-readable picker label. */
  name: string;
  /** One-line palette description. */
  description: string;
  /**
   * Palette family, used to group related presets in the `/theme` picker
   * (Catppuccin ×4, Tokyo Night ×3, Gruvbox ×3, …). The family is the
   * `theme-presets/<family>.ts` module that defines the palette, so
   * grouping stays aligned with how the data is organised.
   */
  family: string;
}

/**
 * Display metadata for every preset — the single source of truth shared by
 * the TUI picker (`packages/tui/src/theme-presets/options.ts`) and the CLI
 * `/theme` command (`packages/cli/src/slash-commands/theme.ts`).
 *
 * This table used to be hand-written TWICE, once per surface, with only the
 * id set compile-linked: `themePresets` is typed `Record<ThemePresetId, Theme>`
 * and the CLI's table was a total `Record<ThemePresetId, …>`, so a *missing*
 * preset failed `tsc` but a *renamed* or *reworded* one silently drifted
 * between the two pickers. Deriving both surfaces from one record closes
 * that gap — a mismatch is no longer expressible.
 *
 * Keyed as a total `Record<ThemePresetId, ThemePresetMeta>` for the same
 * reason: adding an id to {@link THEME_PRESET_IDS} without display metadata
 * is a compile error rather than a picker row rendering `undefined`.
 */
export const THEME_PRESET_META: Record<ThemePresetId, ThemePresetMeta> = {
  catppuccin: {
    name: 'Catppuccin Mocha',
    description: 'Warm pastel — the original WrongStack default',
    family: 'Catppuccin',
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    description: 'Cool blue-purple, calm low-contrast coding palette',
    family: 'Tokyo Night',
  },
  nord: {
    name: 'Nord',
    description: 'Arctic, muted blues and greens — easy on the eyes',
    family: 'Miscellaneous I',
  },
  cyberpunk: {
    name: 'Cyberpunk',
    description: 'Hot pink + neon cyan, high-contrast night mode',
    family: 'Miscellaneous I',
  },
  dracula: {
    name: 'Dracula',
    description: 'Classic purple-on-black, vivid accents',
    family: 'Miscellaneous I',
  },
  'gruvbox-dark': {
    name: 'Gruvbox Dark',
    description: 'Warm earthy retro palette — orange, olive and muted aqua',
    family: 'Gruvbox',
  },
  'solarized-dark': {
    name: 'Solarized Dark',
    description: 'Precision contrast, base16 classic with teal undertones',
    family: 'Miscellaneous I',
  },
  'one-dark': {
    name: 'One Dark',
    description: "Atom's iconic dark palette — blue-led with warm accents",
    family: 'Atom',
  },
  monokai: {
    name: 'Monokai',
    description: 'Sublime Text classic — vivid magenta, cyan and lime',
    family: 'Monokai',
  },
  'rose-pine': {
    name: 'Rosé Pine',
    description: 'Aesthetic pine & foam — soft pastel evening tones',
    family: 'Rosé Pine',
  },
  kanagawa: {
    name: 'Kanagawa',
    description: 'Hokusai-inspired waves — sumi ink on washi',
    family: 'Japanese',
  },
  'ayu-dark': {
    name: 'Ayu Dark',
    description: 'Simple, pleasant dark — warm orange + cool blue mix',
    family: 'Ayu',
  },
  everforest: {
    name: 'Everforest',
    description: 'Green-based comfort palette — forest greens and warm tans',
    family: 'Everforest',
  },
  'night-owl': {
    name: 'Night Owl',
    description: "Sarah Drasner's night theme — deep navy with bold accents",
    family: 'Miscellaneous I',
  },
  synthwave: {
    name: "Synthwave '84",
    description: 'Hot pink + neon cyan on deep purple — 80s retro glow',
    family: 'Synthwave',
  },
  'github-dark': {
    name: 'GitHub Dark',
    description: "GitHub's default dark — crisp blue on near-black",
    family: 'GitHub',
  },
  'material-ocean': {
    name: 'Material Ocean',
    description: 'Deepest Material variant — ink blue with pastel accents',
    family: 'Material',
  },
  nightfox: {
    name: 'Nightfox',
    description: 'Balanced slate blue with muted sage and rose',
    family: 'Nightfox',
  },
  oxocarbon: {
    name: 'Oxocarbon',
    description: 'IBM Carbon-derived — neutral greys, electric blue & pink',
    family: 'Miscellaneous I',
  },
  'catppuccin-macchiato': {
    name: 'Catppuccin Macchiato',
    description: 'Warmer, one shade lighter than Mocha',
    family: 'Catppuccin',
  },
  'catppuccin-frappe': {
    name: 'Catppuccin Frappé',
    description: 'The lightest Catppuccin dark — gentle midday contrast',
    family: 'Catppuccin',
  },
  'gruvbox-material': {
    name: 'Gruvbox Material',
    description: 'Softened Gruvbox — same warmth, lower eye strain',
    family: 'Gruvbox',
  },
  'tokyo-night-storm': {
    name: 'Tokyo Night Storm',
    description: 'Tokyo Night on a lifted blue-grey base',
    family: 'Tokyo Night',
  },
  'rose-pine-moon': {
    name: 'Rosé Pine Moon',
    description: 'Rosé Pine at dusk — deeper base, same soft accents',
    family: 'Rosé Pine',
  },
  zenburn: {
    name: 'Zenburn',
    description: 'The classic low-contrast grey — desaturated and calm',
    family: 'Miscellaneous I',
  },
  palenight: {
    name: 'Palenight',
    description: 'Material Palenight — indigo base, candy accents',
    family: 'Material',
  },
  horizon: {
    name: 'Horizon',
    description: 'Warm coral and mint on charcoal — sunset gradient',
    family: 'Miscellaneous I',
  },
  sonokai: {
    name: 'Sonokai',
    description: 'Monokai Pro descendant — punchy on warm graphite',
    family: 'Monokai',
  },
  'edge-dark': {
    name: 'Edge Dark',
    description: 'Clean, evenly-weighted palette on desaturated navy',
    family: 'Miscellaneous II',
  },
  moonfly: {
    name: 'Moonfly',
    description: 'Near-black base with high-chroma accents — maximum contrast',
    family: 'Miscellaneous II',
  },
  melange: {
    name: 'Melange',
    description: 'Warm sepia and clay — the least blue dark theme here',
    family: 'Miscellaneous II',
  },
  poimandres: {
    name: 'Poimandres',
    description: 'Teal-forward, low-saturation — mint on deep indigo',
    family: 'Miscellaneous II',
  },
  'vitesse-dark': {
    name: 'Vitesse Dark',
    description: "Anthony Fu's minimal palette — muted, print-like",
    family: 'Vitesse',
  },
  aura: {
    name: 'Aura Dark',
    description: 'Vivid purple and spring green on near-black violet',
    family: 'Miscellaneous II',
  },
  'dark-plus': {
    name: 'VS Code Dark+',
    description: "Visual Studio Code's default — familiar blue/orange/teal",
    family: 'Miscellaneous II',
  },
  monochrome: {
    name: 'Monochrome',
    description: 'Pure grayscale — no hue, only luminance',
    family: 'Mono',
  },
  matrix: {
    name: 'Matrix Green',
    description: 'Phosphor green CRT terminal — digital rain aesthetic',
    family: 'Mono CRT',
  },
  amber: {
    name: 'Amber CRT',
    description: 'Warm phosphor CRT terminal — glowing vintage amber',
    family: 'Mono CRT',
  },
  'cyber-noir': {
    name: 'Cyber Noir',
    description: 'Stark white and slate on jet black — minimalist high contrast',
    family: 'Mono',
  },
  'cobalt-mono': {
    name: 'Cobalt Monochrome',
    description: 'Luminous cyan on deep abyss blue — oceanic blueprint',
    family: 'Mono',
  },
  'blood-moon': {
    name: 'Blood Moon',
    description: 'Crimson & scarlet on obsidian — brooding dark mode',
    family: 'Mono',
  },
  cobalt2: {
    name: 'Cobalt2',
    description: "Wes Bos' signature theme — deep navy with golden yellow & cyan",
    family: 'Miscellaneous II',
  },
  'shades-of-purple': {
    name: 'Shades of Purple',
    description: "Ahmad Awais' bold purple palette with neon yellow & magenta",
    family: 'Miscellaneous II',
  },
  'flexoki-dark': {
    name: 'Flexoki Dark',
    description: "Steph Ango's inky warm paper palette — natural earthy accents",
    family: 'Flexoki',
  },
  laserwave: {
    name: 'LaserWave',
    description: '80s retrowave — neon flamingo and turquoise on violet',
    family: 'Synthwave',
  },
  andromeda: {
    name: 'Andromeda',
    description: 'Deep interstellar dark with vibrant neon teal and pink',
    family: 'Miscellaneous III',
  },
  'github-dark-dimmed': {
    name: 'GitHub Dark Dimmed',
    description: "GitHub's softer slate dark theme — gentle blues and pastels",
    family: 'GitHub',
  },
  snazzy: {
    name: 'Hyper Snazzy',
    description: "Sindre Sorhus' elegant saturated terminal palette",
    family: 'Miscellaneous III',
  },
  'tokyo-night-moon': {
    name: 'Tokyo Night Moon',
    description: 'Tokyo Night on balanced deep indigo — vibrant accents',
    family: 'Tokyo Night',
  },
  'gruvbox-dark-hard': {
    name: 'Gruvbox Dark Hard',
    description: 'Maximum contrast Gruvbox on deep pitch charcoal',
    family: 'Gruvbox',
  },
  'oceanic-next': {
    name: 'Oceanic Next',
    description: 'Teal-and-slate classic — calm blue, warm coral',
    family: 'Miscellaneous III',
  },
  'one-half-dark': {
    name: 'One Half Dark',
    description: "Atom's One Half — One Dark with cleaner contrast",
    family: 'Atom',
  },
  'ayu-mirage': {
    name: 'Ayu Mirage',
    description: 'Dusk-slate Ayu, between Dark and Light',
    family: 'Ayu',
  },
  seti: {
    name: 'Seti',
    description: 'Long-running VS Code classic — charcoal, gold, cyan',
    family: 'Miscellaneous III',
  },
  'paraiso-dark': {
    name: 'Paraiso Dark',
    description: 'Base16 plum — warm, muted, low-glare',
    family: 'Miscellaneous III',
  },
  darcula: {
    name: 'Darcula',
    description: "JetBrains' default dark — grey-green with amber",
    family: 'Miscellaneous III',
  },
  'slack-dark': {
    name: 'Slack Aubergine',
    description: 'Deep aubergine with sky blue and lime',
    family: 'Miscellaneous III',
  },
  'vitesse-black': {
    name: 'Vitesse Black',
    description: 'Vitesse on true black — least glare here',
    family: 'Vitesse',
  },
  'atom-dark': {
    name: 'Atom Dark',
    description: 'The original Atom grey — neutral, low-chroma',
    family: 'Atom',
  },
  'github-dark-high-contrast': {
    name: 'GitHub Dark High Contrast',
    description: 'Accessible GitHub — boosted text and borders',
    family: 'GitHub',
  },
  'contrast-max': {
    name: 'Maximum Contrast',
    description: 'Original — pure black, AAA-targeted text and borders',
    family: 'Accessible',
  },
  'colorblind-safe': {
    name: 'Colorblind Safe',
    description: 'Original — blue/orange coding, no red-vs-green reliance',
    family: 'Accessible',
  },
  sandstone: {
    name: 'Sandstone',
    description: 'Original — warm stone neutrals with sage and clay',
    family: 'Miscellaneous III',
  },
  'everforest-hard': {
    name: 'Everforest Hard',
    description: 'Everforest on its deepest base — more depth, same greens',
    family: 'Everforest',
  },
};
