import type { ThemePickerOption } from '../theme-types.js';

/** Picker rows in canonical THEME_PRESET_IDS order. */
export const THEME_OPTIONS: readonly ThemePickerOption[] = [
  {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    description: 'Warm pastel — the original WrongStack default',
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Cool blue-purple, calm low-contrast coding palette',
  },
  { id: 'nord', name: 'Nord', description: 'Arctic, muted blues and greens — easy on the eyes' },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    description: 'Hot pink + neon cyan, high-contrast night mode',
  },
  { id: 'dracula', name: 'Dracula', description: 'Classic purple-on-black, vivid accents' },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    description: 'Warm earthy retro palette — orange, olive and muted aqua',
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: 'Precision contrast, base16 classic with teal undertones',
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    description: "Atom's iconic dark palette — blue-led with warm accents",
  },
  {
    id: 'monokai',
    name: 'Monokai',
    description: 'Sublime Text classic — vivid magenta, cyan and lime',
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    description: 'Aesthetic pine & foam — soft pastel evening tones',
  },
  { id: 'kanagawa', name: 'Kanagawa', description: 'Hokusai-inspired waves — sumi ink on washi' },
  {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    description: 'Simple, pleasant dark — warm orange + cool blue mix',
  },
  {
    id: 'everforest',
    name: 'Everforest',
    description: 'Green-based comfort palette — forest greens and warm tans',
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    description: "Sarah Drasner's night theme — deep navy with bold accents",
  },
  {
    id: 'synthwave',
    name: "Synthwave '84",
    description: 'Hot pink + neon cyan on deep purple — 80s retro glow',
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    description: "GitHub's default dark — crisp blue on near-black",
  },
  {
    id: 'material-ocean',
    name: 'Material Ocean',
    description: 'Deepest Material variant — ink blue with pastel accents',
  },
  { id: 'nightfox', name: 'Nightfox', description: 'Balanced slate blue with muted sage and rose' },
  {
    id: 'oxocarbon',
    name: 'Oxocarbon',
    description: 'IBM Carbon-derived — neutral greys, electric blue & pink',
  },
  {
    id: 'catppuccin-macchiato',
    name: 'Catppuccin Macchiato',
    description: 'Warmer, one shade lighter than Mocha',
  },
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappé',
    description: 'The lightest Catppuccin dark — gentle midday contrast',
  },
  {
    id: 'gruvbox-material',
    name: 'Gruvbox Material',
    description: 'Softened Gruvbox — same warmth, lower eye strain',
  },
  {
    id: 'tokyo-night-storm',
    name: 'Tokyo Night Storm',
    description: 'Tokyo Night on a lifted blue-grey base',
  },
  {
    id: 'rose-pine-moon',
    name: 'Rosé Pine Moon',
    description: 'Rosé Pine at dusk — deeper base, same soft accents',
  },
  {
    id: 'zenburn',
    name: 'Zenburn',
    description: 'The classic low-contrast grey — desaturated and calm',
  },
  {
    id: 'palenight',
    name: 'Palenight',
    description: 'Material Palenight — indigo base, candy accents',
  },
  {
    id: 'horizon',
    name: 'Horizon',
    description: 'Warm coral and mint on charcoal — sunset gradient',
  },
  {
    id: 'sonokai',
    name: 'Sonokai',
    description: 'Monokai Pro descendant — punchy on warm graphite',
  },
  {
    id: 'edge-dark',
    name: 'Edge Dark',
    description: 'Clean, evenly-weighted palette on desaturated navy',
  },
  {
    id: 'moonfly',
    name: 'Moonfly',
    description: 'Near-black base with high-chroma accents — maximum contrast',
  },
  {
    id: 'melange',
    name: 'Melange',
    description: 'Warm sepia and clay — the least blue dark theme here',
  },
  {
    id: 'poimandres',
    name: 'Poimandres',
    description: 'Teal-forward, low-saturation — mint on deep indigo',
  },
  {
    id: 'vitesse-dark',
    name: 'Vitesse Dark',
    description: "Anthony Fu's minimal palette — muted, print-like",
  },
  {
    id: 'aura',
    name: 'Aura Dark',
    description: 'Vivid purple and spring green on near-black violet',
  },
  {
    id: 'dark-plus',
    name: 'VS Code Dark+',
    description: "Visual Studio Code's default — familiar blue/orange/teal",
  },
  { id: 'monochrome', name: 'Monochrome', description: 'Pure grayscale — no hue, only luminance' },
  {
    id: 'matrix',
    name: 'Matrix Green',
    description: 'Phosphor green CRT terminal — digital rain aesthetic',
  },
  {
    id: 'amber',
    name: 'Amber CRT',
    description: 'Warm phosphor CRT terminal — glowing vintage amber',
  },
  {
    id: 'cyber-noir',
    name: 'Cyber Noir',
    description: 'Stark white and slate on jet black — minimalist high contrast',
  },
  {
    id: 'cobalt-mono',
    name: 'Cobalt Monochrome',
    description: 'Luminous cyan on deep abyss blue — oceanic blueprint',
  },
  {
    id: 'blood-moon',
    name: 'Blood Moon',
    description: 'Crimson & scarlet on obsidian — brooding dark mode',
  },
  {
    id: 'cobalt2',
    name: 'Cobalt2',
    description: "Wes Bos' signature theme — deep navy with golden yellow & cyan",
  },
  {
    id: 'shades-of-purple',
    name: 'Shades of Purple',
    description: "Ahmad Awais' bold purple palette with neon yellow & magenta",
  },
  {
    id: 'flexoki-dark',
    name: 'Flexoki Dark',
    description: "Steph Ango's inky warm paper palette — natural earthy accents",
  },
  {
    id: 'laserwave',
    name: 'LaserWave',
    description: '80s retrowave — neon flamingo and turquoise on violet',
  },
  {
    id: 'andromeda',
    name: 'Andromeda',
    description: 'Deep interstellar dark with vibrant neon teal and pink',
  },
  {
    id: 'github-dark-dimmed',
    name: 'GitHub Dark Dimmed',
    description: "GitHub's softer slate dark theme — gentle blues and pastels",
  },
  {
    id: 'snazzy',
    name: 'Hyper Snazzy',
    description: "Sindre Sorhus' elegant saturated terminal palette",
  },
  {
    id: 'tokyo-night-moon',
    name: 'Tokyo Night Moon',
    description: 'Tokyo Night on balanced deep indigo — vibrant accents',
  },
  {
    id: 'gruvbox-dark-hard',
    name: 'Gruvbox Dark Hard',
    description: 'Maximum contrast Gruvbox on deep pitch charcoal',
  },
  {
    id: 'oceanic-next',
    name: 'Oceanic Next',
    description: 'Teal-and-slate classic — calm blue, warm coral',
  },
  {
    id: 'one-half-dark',
    name: 'One Half Dark',
    description: "Atom's One Half — One Dark with cleaner contrast",
  },
  { id: 'ayu-mirage', name: 'Ayu Mirage', description: 'Dusk-slate Ayu, between Dark and Light' },
  { id: 'seti', name: 'Seti', description: 'Long-running VS Code classic — charcoal, gold, cyan' },
  { id: 'paraiso-dark', name: 'Paraiso Dark', description: 'Base16 plum — warm, muted, low-glare' },
  {
    id: 'darcula',
    name: 'Darcula',
    description: "JetBrains' default dark — grey-green with amber",
  },
  {
    id: 'slack-dark',
    name: 'Slack Aubergine',
    description: 'Deep aubergine with sky blue and lime',
  },
  {
    id: 'vitesse-black',
    name: 'Vitesse Black',
    description: 'Vitesse on true black — least glare here',
  },
  {
    id: 'atom-dark',
    name: 'Atom Dark',
    description: 'The original Atom grey — neutral, low-chroma',
  },
  {
    id: 'github-dark-high-contrast',
    name: 'GitHub Dark High Contrast',
    description: 'Accessible GitHub — boosted text and borders',
  },
  {
    id: 'contrast-max',
    name: 'Maximum Contrast',
    description: 'Original — pure black, AAA-targeted text and borders',
  },
  {
    id: 'colorblind-safe',
    name: 'Colorblind Safe',
    description: 'Original — blue/orange coding, no red-vs-green reliance',
  },
  {
    id: 'sandstone',
    name: 'Sandstone',
    description: 'Original — warm stone neutrals with sage and clay',
  },
  {
    id: 'everforest-hard',
    name: 'Everforest Hard',
    description: 'Everforest on its deepest base — more depth, same greens',
  },
];
