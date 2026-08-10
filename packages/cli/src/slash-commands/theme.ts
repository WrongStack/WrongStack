import type { InputReader, SlashCommand, ThemePresetId } from '@wrongstack/core/types';
import { color, writeOut } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

interface ThemeOption {
  id: string;
  name: string;
  desc: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  { id: 'catppuccin', name: 'Catppuccin Mocha', desc: 'Soft pastel dark theme (Default)' },
  { id: 'tokyo-night', name: 'Tokyo Night', desc: 'Deep violet, neon orange & cyan' },
  { id: 'nord', name: 'Nord', desc: 'Cool arctic blue & slate pastels' },
  { id: 'cyberpunk', name: 'Cyberpunk Neon', desc: 'High-contrast magenta, cyan & yellow' },
  { id: 'dracula', name: 'Dracula', desc: 'Vibrant purple, pink & green' },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', desc: 'Warm earthy retro — orange, olive & aqua' },
  { id: 'solarized-dark', name: 'Solarized Dark', desc: 'Base16 classic — teal & ochre precision' },
  { id: 'one-dark', name: 'One Dark', desc: "Atom's iconic palette — blue-led, warm accents" },
  { id: 'monokai', name: 'Monokai', desc: 'Sublime classic — vivid magenta, cyan & lime' },
  { id: 'rose-pine', name: 'Rosé Pine', desc: 'Aesthetic pine & foam — soft evening pastels' },
  { id: 'kanagawa', name: 'Kanagawa', desc: 'Hokusai-inspired waves — sumi ink on washi' },
  { id: 'ayu-dark', name: 'Ayu Dark', desc: 'Simple pleasant dark — warm orange + cool blue' },
  { id: 'everforest', name: 'Everforest', desc: 'Green-based comfort — forest greens & warm tans' },
  { id: 'night-owl', name: 'Night Owl', desc: "Sarah Drasner's night — deep navy + bold accents" },
  { id: 'synthwave', name: "Synthwave '84", desc: 'Hot pink + neon cyan on deep purple' },
];

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
      lines.push(`  ${prefix}${name.padEnd(18)} ${color.dim(p.desc)}${mark}`);
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
    argsHint:
      '[catppuccin | tokyo-night | nord | cyberpunk | dracula | gruvbox-dark | solarized-dark | one-dark | monokai | rose-pine | kanagawa | ayu-dark | everforest | night-owl | synthwave]',
    help: [
      'Usage:',
      '  /theme                  Interactive menu selection or view available theme presets',
      '  /theme <preset>         Switch directly to a theme preset',
      '',
      'Available presets:',
      '  catppuccin, tokyo-night, nord, cyberpunk, dracula,',
      '  gruvbox-dark, solarized-dark, one-dark, monokai, rose-pine,',
      '  kanagawa, ayu-dark, everforest, night-owl, synthwave',
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
          lines.push(`  • ${color.bold(t.id.padEnd(14))} ${t.desc}${mark}`);
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
