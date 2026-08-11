import type { InputReader, SlashCommand, ThemePresetId } from '@wrongstack/core/types';
import { THEME_PRESET_IDS } from '@wrongstack/core/types';
import { color, writeOut } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

interface ThemeOption {
  id: ThemePresetId;
  name: string;
  desc: string;
}

/**
 * Display metadata per preset. Typed as a total `Record<ThemePresetId, …>` so
 * adding an id to `THEME_PRESET_IDS` without a label here is a compile error
 * rather than a preset that silently renders as `undefined` in the picker.
 * The ORDER shown to the user comes from `THEME_PRESET_IDS`, not from this
 * object, so the CLI and TUI pickers always agree.
 */
const THEME_META: Record<ThemePresetId, { name: string; desc: string }> = {
  catppuccin: { name: 'Catppuccin Mocha', desc: 'Soft pastel dark theme (Default)' },
  'tokyo-night': { name: 'Tokyo Night', desc: 'Deep violet, neon orange & cyan' },
  nord: { name: 'Nord', desc: 'Cool arctic blue & slate pastels' },
  cyberpunk: { name: 'Cyberpunk Neon', desc: 'High-contrast magenta, cyan & yellow' },
  dracula: { name: 'Dracula', desc: 'Vibrant purple, pink & green' },
  'gruvbox-dark': { name: 'Gruvbox Dark', desc: 'Warm earthy retro — orange, olive & aqua' },
  'solarized-dark': { name: 'Solarized Dark', desc: 'Base16 classic — teal & ochre precision' },
  'one-dark': { name: 'One Dark', desc: "Atom's iconic palette — blue-led, warm accents" },
  monokai: { name: 'Monokai', desc: 'Sublime classic — vivid magenta, cyan & lime' },
  'rose-pine': { name: 'Rosé Pine', desc: 'Aesthetic pine & foam — soft evening pastels' },
  kanagawa: { name: 'Kanagawa', desc: 'Hokusai-inspired waves — sumi ink on washi' },
  'ayu-dark': { name: 'Ayu Dark', desc: 'Simple pleasant dark — warm orange + cool blue' },
  everforest: { name: 'Everforest', desc: 'Green-based comfort — forest greens & warm tans' },
  'night-owl': { name: 'Night Owl', desc: "Sarah Drasner's night — deep navy + bold accents" },
  synthwave: { name: "Synthwave '84", desc: 'Hot pink + neon cyan on deep purple' },
  'github-dark': { name: 'GitHub Dark', desc: "GitHub's default dark — crisp blue on near-black" },
  'material-ocean': {
    name: 'Material Ocean',
    desc: 'Deepest Material variant — ink blue with pastel accents',
  },
  nightfox: { name: 'Nightfox', desc: 'Balanced slate blue with muted sage and rose' },
  oxocarbon: {
    name: 'Oxocarbon',
    desc: 'IBM Carbon-derived — neutral greys, electric blue & pink',
  },
  'catppuccin-macchiato': {
    name: 'Catppuccin Macchiato',
    desc: 'Warmer, one shade lighter than Mocha',
  },
  'catppuccin-frappe': {
    name: 'Catppuccin Frappé',
    desc: 'The lightest Catppuccin dark — gentle midday contrast',
  },
  'gruvbox-material': {
    name: 'Gruvbox Material',
    desc: 'Softened Gruvbox — same warmth, lower eye strain',
  },
  'tokyo-night-storm': {
    name: 'Tokyo Night Storm',
    desc: 'Tokyo Night on a lifted blue-grey base',
  },
  'rose-pine-moon': {
    name: 'Rosé Pine Moon',
    desc: 'Rosé Pine at dusk — deeper base, same soft accents',
  },
  zenburn: { name: 'Zenburn', desc: 'The classic low-contrast grey — desaturated and calm' },
  palenight: { name: 'Palenight', desc: 'Material Palenight — indigo base, candy accents' },
  horizon: { name: 'Horizon', desc: 'Warm coral and mint on charcoal — sunset gradient' },
  sonokai: { name: 'Sonokai', desc: 'Monokai Pro descendant — punchy on warm graphite' },
  'edge-dark': { name: 'Edge Dark', desc: 'Clean, evenly-weighted palette on desaturated navy' },
  moonfly: { name: 'Moonfly', desc: 'Near-black base with high-chroma accents — max contrast' },
  melange: { name: 'Melange', desc: 'Warm sepia and clay — the least blue dark theme here' },
  poimandres: { name: 'Poimandres', desc: 'Teal-forward, low-saturation — mint on deep indigo' },
  'vitesse-dark': {
    name: 'Vitesse Dark',
    desc: "Anthony Fu's minimal palette — muted, print-like",
  },
  aura: { name: 'Aura Dark', desc: 'Vivid purple and spring green on near-black violet' },
  'dark-plus': { name: 'VS Code Dark+', desc: "VS Code's default — familiar blue/orange/teal" },
};

const THEME_OPTIONS: ThemeOption[] = THEME_PRESET_IDS.map((id) => ({ id, ...THEME_META[id] }));

/** Wrap the preset ids into short comma-separated lines for `/theme --help`. */
function presetHelpLines(perLine = 4): string[] {
  const lines: string[] = [];
  for (let i = 0; i < THEME_PRESET_IDS.length; i += perLine) {
    const chunk = THEME_PRESET_IDS.slice(i, i + perLine).join(', ');
    lines.push(`  ${chunk}${i + perLine < THEME_PRESET_IDS.length ? ',' : ''}`);
  }
  return lines;
}

/** Interactive terminal picker using arrow keys (↑↓) and Enter to select a theme. */
async function runThemePicker(reader: InputReader, activeId?: string): Promise<string | undefined> {
  let cursor = THEME_OPTIONS.findIndex((p) => p.id === activeId);
  if (cursor < 0) cursor = 0;

  const render = (currentCursor: number) => {
    const lines: string[] = [];
    lines.push(`\n${color.bold(color.amber('WrongStack') + color.dim(' — TUI Theme Selection'))}\n`);
    lines.push(color.dim('  ↑↓ navigate   Enter select   q quit\n'));
    lines.push('');
    for (const [i, p] of THEME_OPTIONS.entries()) {
      const mark = p.id === activeId ? color.green(' [active]') : '';
      const prefix = i === currentCursor ? color.bold('❯ ') : '  ';
      const name = i === currentCursor ? color.bold(p.name) : p.name;
      lines.push(`  ${prefix}${name.padEnd(21)} ${color.dim(p.desc)}${mark}`);
    }
    lines.push('');
    return lines.join('\n');
  };

  writeOut(render(cursor));

  const options = [
    { key: '\x1b[A', label: '↑', value: 'up' },
    { key: '\x1b[B', label: '↓', value: 'down' },
    { key: '\r', label: 'Enter', value: 'enter' },
    { key: 'q', label: 'q', value: 'quit' },
  ];

  while (true) {
    const answer = await reader.readKey('', options);
    if (answer === 'quit') return undefined;
    if (answer === 'enter') return THEME_OPTIONS[cursor]?.id ?? THEME_OPTIONS[0]!.id;
    if (answer === 'up') {
      cursor = cursor > 0 ? cursor - 1 : THEME_OPTIONS.length - 1;
    } else if (answer === 'down') {
      cursor = cursor < THEME_OPTIONS.length - 1 ? cursor + 1 : 0;
    }
    writeOut('\x1b[J');
    writeOut(render(cursor));
  }
}

export function buildThemeCommand(
  opts: SlashCommandContext & { inputReader?: InputReader | undefined },
): SlashCommand {
  return {
    name: 'theme',
    category: 'Config',
    description: 'Switch or select the TUI color theme preset interactively',
    argsHint: `[<preset>]  (${THEME_PRESET_IDS.length} available — run /theme to pick)`,
    help: [
      'Usage:',
      '  /theme                  Interactive menu selection or view available theme presets',
      '  /theme <preset>         Switch directly to a theme preset',
      '',
      `Available presets (${THEME_PRESET_IDS.length}):`,
      ...presetHelpLines(),
    ].join('\n'),
    async run(args) {
      const validPresets = THEME_OPTIONS.map((t) => t.id);
      const currentConfig = opts.configStore?.get();
      const activePreset = (currentConfig?.themePreset ?? 'catppuccin') as ThemePresetId;

      // No args → launch interactive picker if reader is available, else list options
      if (!args.trim()) {
        if (opts.inputReader) {
          const selected = await runThemePicker(opts.inputReader, activePreset);
          if (!selected) {
            return { message: 'Theme selection cancelled.' };
          }
          if (opts.configStore) {
            try {
              opts.configStore.update({ themePreset: selected as ThemePresetId });
            } catch {
              /* best-effort */
            }
          }
          return {
            message: color.green(`Switched TUI theme preset to "${selected}" (saved to config).`),
            metadata: { themePreset: selected },
          };
        }

        const lines = [
          color.bold(`Current TUI theme: ${activePreset}`),
          '',
          color.bold('Available Theme Presets:'),
        ];
        for (const t of THEME_OPTIONS) {
          const mark = t.id === activePreset ? color.green(' [active]') : '';
          lines.push(`  • ${color.bold(t.id.padEnd(21))} ${t.desc}${mark}`);
        }
        lines.push('');
        lines.push(color.dim('Usage: /theme <preset>'));
        return { message: lines.join('\n') };
      }

      const preset = args.trim().toLowerCase();
      if (!validPresets.includes(preset as ThemePresetId)) {
        return {
          message: `Unknown theme preset "${preset}". Available options: ${validPresets.join(', ')}`,
        };
      }

      if (opts.configStore) {
        try {
          opts.configStore.update({ themePreset: preset as ThemePresetId });
        } catch {
          /* best-effort persistence */
        }
      }

      return {
        message: color.green(`Switched TUI theme preset to "${preset}" (saved to config).`),
        metadata: { themePreset: preset },
      };
    },
  };
}
