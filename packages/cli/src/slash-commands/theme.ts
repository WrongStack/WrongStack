import type { InputReader, SlashCommand, ThemePresetId } from '@wrongstack/contracts/types';
import { THEME_PRESET_IDS, THEME_PRESET_META } from '@wrongstack/contracts/types';
import { color, writeOut } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

interface ThemeOption {
  id: ThemePresetId;
  name: string;
  desc: string;
}

/**
 * Picker rows in canonical `THEME_PRESET_IDS` order.
 *
 * Name/description come from `THEME_PRESET_META` in `@wrongstack/core/types` —
 * the same record the TUI's `theme-presets/options.ts` derives from. This
 * module used to carry its own hand-written `THEME_META` table duplicating all
 * 64 entries: the id set was compile-linked, but a reworded or renamed preset
 * drifted silently between the CLI and TUI pickers. Both surfaces now read one
 * record, so a mismatch is not expressible.
 */
const THEME_OPTIONS: ThemeOption[] = THEME_PRESET_IDS.map((id) => ({
  id,
  name: THEME_PRESET_META[id].name,
  desc: THEME_PRESET_META[id].description,
}));

/**
 * The CLI's picker rows, exported for the TUI↔CLI agreement test
 * (`packages/cli/tests/theme-metadata-agreement.test.ts`). The TUI derives its
 * own rows from the same `THEME_PRESET_META` record, so this export is the
 * second side of that comparison — it must stay in step with `THEME_OPTIONS`
 * above.
 */
export const cliThemePickerOptions: readonly ThemeOption[] = THEME_OPTIONS;

/** Wrap the preset ids into short comma-separated lines for `/theme --help`. */
function presetHelpLines(perLine = 4): string[] {
  const lines: string[] = [];
  for (let i = 0; i < THEME_PRESET_IDS.length; i += perLine) {
    const chunk = THEME_PRESET_IDS.slice(i, i + perLine).join(', ');
    lines.push(`  ${chunk}${i + perLine < THEME_PRESET_IDS.length ? ',' : ''}`);
  }
  return lines;
}

/**
 * Windowed slice of the theme list for the raw-terminal picker — mirrors the
 * math in the TUI's `useWindowedPicker` (same centering + marker rules) so
 * both pickers agree on how many presets fit and which rows are visible.
 * `rows` is the raw terminal height; the picker reserves its chrome (header,
 * hint, blanks) plus worst-case marker rows up front, so a 24-row terminal
 * never renders all 40 presets.
 *
 * Exported for direct unit testing (packages/cli/tests/slash-theme.test.ts);
 * the picker itself treats it as private.
 */
export function computeWindow(
  total: number,
  selected: number,
  rows: number,
): {
  start: number;
  end: number;
  hasAbove: boolean;
  hasBelow: boolean;
} {
  const chromeRows = 5; // blank, title, hint, blank, trailing blank
  const markerRows = 2; // worst case: one `… more above` + one `… more below`
  const minVisible = 3;
  if (total <= 0) return { start: 0, end: 0, hasAbove: false, hasBelow: false };
  const available = Math.max(1, rows - chromeRows - markerRows);
  const visible = Math.max(minVisible, Math.min(total, Math.floor(available)));
  const safeSelected = selected >= 0 && selected < total ? selected : 0;

  let start: number;
  if (safeSelected < visible) {
    // Top-aligned on the first page so the user sees the list start.
    start = 0;
  } else {
    // Center the focused row, then clamp so the window never bleeds past
    // the end. Mirrors useWindowedPicker.
    const halfWindow = Math.floor(visible / 2);
    start = safeSelected - halfWindow;
    start = Math.max(0, Math.min(total - visible, start));
  }
  const end = Math.min(total, start + visible);
  return { start, end, hasAbove: start > 0, hasBelow: end < total };
}

/**
 * Truncate an option's description so the rendered row never wraps on a
 * narrow terminal. `computeWindow` budgets ONE terminal row per option; a
 * description that wrapped onto a second physical line would silently break
 * that budget and re-introduce the vertical overflow this picker was fixed
 * to avoid. The description is plain text here (color-wrapped by the caller
 * AFTER truncation), so measuring its length is ANSI-safe.
 *
 * Fixed chrome per row: 2 indent + 2 cursor + 21 name + 1 gap = 26 columns,
 * plus the ` [active]` mark (9 columns) when the option is the active preset.
 *
 * Exported for direct unit testing (packages/cli/tests/slash-theme.test.ts);
 * the picker itself treats it as private.
 */
export function truncateDesc(desc: string, columns: number, active: boolean): string {
  const markWidth = active ? 9 : 0;
  const budget = Math.max(0, columns - 26 - markWidth);
  if (desc.length <= budget) return desc;
  if (budget <= 1) return '…';
  return `${desc.slice(0, budget - 1)}…`;
}

/** Interactive terminal picker using arrow keys (↑↓) and Enter to select a theme. */
async function runThemePicker(reader: InputReader, activeId?: string): Promise<string | undefined> {
  let cursor = THEME_OPTIONS.findIndex((p) => p.id === activeId);
  if (cursor < 0) cursor = 0;

  const render = (currentCursor: number) => {
    const rows = process.stdout.rows ?? 24;
    const columns = process.stdout.columns ?? 80;
    const { start, end, hasAbove, hasBelow } = computeWindow(
      THEME_OPTIONS.length,
      currentCursor,
      rows,
    );
    const lines: string[] = [];
    lines.push('');
    lines.push(`${color.bold(color.amber('WrongStack') + color.dim(' — TUI Theme Selection'))}`);
    lines.push(color.dim('  ↑↓ navigate   Enter select   q quit'));
    lines.push('');
    if (hasAbove) lines.push(color.dim(`  … ${start} more above`));
    for (let i = start; i < end; i++) {
      const p = THEME_OPTIONS[i]!;
      const mark = p.id === activeId ? color.green(' [active]') : '';
      const prefix = i === currentCursor ? color.bold('❯ ') : '  ';
      const name = i === currentCursor ? color.bold(p.name) : p.name;
      const desc = truncateDesc(p.desc, columns, p.id === activeId);
      lines.push(`  ${prefix}${name.padEnd(21)} ${color.dim(desc)}${mark}`);
    }
    if (hasBelow) lines.push(color.dim(`  … ${THEME_OPTIONS.length - end} more below`));
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
