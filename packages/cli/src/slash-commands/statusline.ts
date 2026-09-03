import type { SlashCommand } from '@wrongstack/core/types';
import {
  CHIP_DESCRIPTIONS,
  clampLine,
  effectiveDensity,
  effectiveLine,
  LINE_TITLES,
  STATUSLINE_DENSITY_LEVELS,
  type StatuslineDensity,
  type StatuslineLine,
} from '@wrongstack/core/statusline';
import {
  DEFAULTS,
  STATUSLINE_CONFIG_KEYS,
  type StatuslineConfig,
  type StatuslineConfigKey,
  type StatuslineDocument,
} from '../services/statusline-config.js';

export {
  DEFAULTS,
  ensureStatuslineConfig,
  loadStatuslineConfig,
  loadStatuslineDensities,
  loadStatuslineLines,
  STATUSLINE_CONFIG_KEYS,
  STATUSLINE_CONFIG_VERSION,
  type StatuslineConfig,
  type StatuslineConfigKey,
  type StatuslineDocument,
  saveStatuslineConfig,
  saveStatuslineLayout,
  saveStatuslineLines,
} from '../services/statusline-config.js';

export interface StatuslineCommandDeps {
  cwd: string;
  /** Current hidden items list. Written by the command when toggling. */
  hiddenItems: Array<StatuslineConfigKey>;
  setHiddenItems: (items: Array<StatuslineConfigKey>) => void;
  getConfig: () => Promise<StatuslineDocument>;
  setConfig: (cfg: StatuslineDocument) => Promise<void>;
  /**
   * Atomically updates hidden items in memory AND persists to disk.
   * Used by the TUI statusline picker.
   */
  saveStatuslineHiddenItems?: (items: Array<StatuslineConfigKey>) => Promise<void>;
  /**
   * Slash-command → TUI panel bridge. When present (TUI mounted), a bare
   * `/statusline` opens the interactive picker instead of printing the
   * chip list; the text output remains the REPL/args fallback.
   */
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
}

const ALL_CONFIG_KEYS = STATUSLINE_CONFIG_KEYS;

function isConfigKey(value: string | undefined): value is StatuslineConfigKey {
  return value != null && (ALL_CONFIG_KEYS as readonly string[]).includes(value);
}

function isDensity(value: string | undefined): value is StatuslineDensity {
  return (
    value === 'auto' ||
    (value != null && (STATUSLINE_DENSITY_LEVELS as readonly string[]).includes(value))
  );
}

/** Render the current layout as four grouped lines — the text-mode preview. */
function renderLayout(cfg: StatuslineDocument): string[] {
  const out: string[] = [];
  for (const line of [1, 2, 3, 4] as StatuslineLine[]) {
    const items = ALL_CONFIG_KEYS.filter(
      (key) => effectiveLine(key, cfg.lines) === line && cfg.chips[key] !== false,
    );
    out.push(`Line ${line} — ${LINE_TITLES[line]}`);
    out.push(
      items.length === 0
        ? '  (empty)'
        : `  ${items
            .map((key) => {
              const density = effectiveDensity(key, cfg.densities);
              return density === 'auto' ? key : `${key}:${density}`;
            })
            .join('  ')}`,
    );
  }
  const off = ALL_CONFIG_KEYS.filter((key) => cfg.chips[key] === false);
  if (off.length > 0) out.push(`Off — ${off.join(' ')}`);
  return out;
}

export function buildStatuslineCommand(deps: StatuslineCommandDeps): SlashCommand {
  return {
    name: 'statusline',
    category: 'Config',
    aliases: ['sl'],
    description: 'Customize status bar chips: /statusline [item] [on|off|line N|density D]',
    help: [
      'Usage: /statusline                     — open the picker (TUI) or list the config',
      '       /statusline preview             — show the four lines as they are laid out',
      '       /statusline <item>              — toggle a chip on/off',
      '       /statusline <item> on|off       — enable/disable a chip',
      '       /statusline <item> line <1-4>   — move a chip to another line',
      '       /statusline <item> density <d>  — pin a chip to auto|full|short|micro',
      '       /statusline all on|off          — enable/disable every chip',
      '       /statusline layout reset        — restore default lines and densities',
      '       /statusline reset               — restore default chip visibility',
      '',
      'Lines are assigned by volatility:',
      '  1 IDENTITY       fixed for the session',
      '  2 VITALS         redraws every token',
      '  3 SAFETY & WORK  posture + work in flight',
      '  4 ASYNC          background activity & countdowns',
      '',
      'Density controls how much of a chip renders. With `auto` the rail',
      'shortens the widest chip first and only drops a chip once every chip',
      'on that line is already at `micro`.',
      '',
      'Available items:',
      ...ALL_CONFIG_KEYS.map((k) => `  ${k.padEnd(16)} ${CHIP_DESCRIPTIONS[k]}`),
      '',
      'Density mode (minimum/detailed/no-color) is a separate setting — see /settings.',
      'These toggles set chip eligibility in any mode; some chips only render in detailed mode.',
      '',
      'Persistent across sessions (saved to ~/.wrongstack/profiles/<active>/statusline.json).',
    ].join('\n'),
    async run(args: string) {
      const cfg = await deps.getConfig();
      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const [item, action, value] = parts;

      // No args → open the TUI picker when the bridge is live (same UX as
      // /plugin and /settings); fall back to the text listing in the REPL.
      if (!item && deps.onPanelOpen?.current) {
        const opened = deps.onPanelOpen.current('statuslineOpen');
        if (opened) return { message: 'Opened statusline picker.' };
      }

      // No args → show current config
      if (!item) {
        const lines = ['StatusBar chips:'];
        for (const k of ALL_CONFIG_KEYS) {
          const val = cfg.chips[k];
          if (val === undefined) continue;
          const line = effectiveLine(k, cfg.lines);
          const density = effectiveDensity(k, cfg.densities);
          lines.push(
            `  ${val ? '●' : '○'} ${k.padEnd(16)} L${line} ${density === 'auto' ? '    ' : density.padEnd(5)} ${CHIP_DESCRIPTIONS[k]}`,
          );
        }
        return { message: lines.join('\n') };
      }

      if (item === 'preview') {
        return { message: ['StatusBar layout:', ...renderLayout(cfg)].join('\n') };
      }

      // Reset
      if (item === 'reset') {
        // Chip visibility resets; the layout is a separate axis and is preserved.
        await deps.setConfig({ ...cfg, chips: { ...DEFAULTS } });
        deps.setHiddenItems(ALL_CONFIG_KEYS.filter((k) => DEFAULTS[k] === false));
        return { message: 'StatusBar chip visibility reset to defaults.' };
      }

      if (item === 'layout') {
        if (action !== 'reset') return { message: 'Usage: /statusline layout reset' };
        await deps.setConfig({ ...cfg, lines: {}, densities: {} });
        return { message: 'StatusBar layout reset: default lines and densities restored.' };
      }

      // Group operation: all on / all off
      if (item === 'all') {
        const onOff = action?.toLowerCase();
        if (!onOff || (onOff !== 'on' && onOff !== 'off')) {
          return { message: 'Usage: /statusline all on|off' };
        }
        const chips: StatuslineConfig = {};
        for (const k of ALL_CONFIG_KEYS) {
          chips[k] = onOff === 'on';
        }
        await deps.setConfig({ ...cfg, chips });
        deps.setHiddenItems(onOff === 'off' ? [...ALL_CONFIG_KEYS] : []);
        return {
          message: `statusline all: ${onOff === 'on' ? 'showing all chips' : 'hiding all chips'}`,
        };
      }

      if (!isConfigKey(item)) {
        return {
          message: `Unknown item "${item}". Run /statusline to see available items.`,
        };
      }

      const onOff = action?.toLowerCase();

      // Line assignment
      if (onOff === 'line') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
          return { message: `Usage: /statusline ${item} line 1|2|3|4` };
        }
        const line = clampLine(parsed);
        await deps.setConfig({ ...cfg, lines: { ...cfg.lines, [item]: line } });
        return { message: `statusline ${item}: line ${line} (${LINE_TITLES[line]})` };
      }

      // Density pin
      if (onOff === 'density') {
        if (!isDensity(value)) {
          return { message: `Usage: /statusline ${item} density auto|full|short|micro` };
        }
        const densities = { ...cfg.densities };
        if (value === 'auto') delete densities[item];
        else densities[item] = value;
        await deps.setConfig({ ...cfg, densities });
        return { message: `statusline ${item}: density ${value}` };
      }

      // If no action specified, toggle the item
      if (!onOff) {
        const currentValue = cfg.chips[item] ?? true;
        const newValue = !currentValue;
        await deps.setConfig({ ...cfg, chips: { ...cfg.chips, [item]: newValue } });
        if (newValue) {
          deps.setHiddenItems(deps.hiddenItems.filter((i) => i !== item));
        } else {
          deps.setHiddenItems([...deps.hiddenItems, item]);
        }
        return { message: `statusline ${item}: ${newValue ? 'on' : 'off'}` };
      }

      if (onOff !== 'on' && onOff !== 'off') {
        return { message: `Usage: /statusline ${item} on|off|line <1-4>|density <level>` };
      }

      await deps.setConfig({ ...cfg, chips: { ...cfg.chips, [item]: onOff === 'on' } });

      // Sync hiddenItems list with TUI
      if (onOff === 'off') {
        deps.setHiddenItems([...deps.hiddenItems, item]);
      } else {
        deps.setHiddenItems(deps.hiddenItems.filter((i) => i !== item));
      }

      return { message: `statusline ${item}: ${onOff}` };
    },
  };
}
