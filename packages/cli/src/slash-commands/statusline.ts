import type { SlashCommand } from '@wrongstack/core/types';
import {
  DEFAULTS,
  STATUSLINE_CONFIG_KEYS,
  type StatuslineConfig,
  type StatuslineConfigKey,
} from '../services/statusline-config.js';

export {
  DEFAULTS,
  ensureStatuslineConfig,
  loadStatuslineConfig,
  STATUSLINE_CONFIG_KEYS,
  type StatuslineConfig,
  type StatuslineConfigKey,
  saveStatuslineConfig,
} from '../services/statusline-config.js';

export interface StatuslineCommandDeps {
  cwd: string;
  /** Current hidden items list. Written by the command when toggling. */
  hiddenItems: Array<StatuslineConfigKey>;
  setHiddenItems: (items: Array<StatuslineConfigKey>) => void;
  getConfig: () => Promise<StatuslineConfig>;
  setConfig: (cfg: StatuslineConfig) => Promise<void>;
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

/** Item descriptions for help display */
const ITEM_DESCRIPTIONS: Record<keyof StatuslineConfig, string> = {
  state: 'Agent run state / thinking spinner',
  model: 'Current provider/model id',
  todos: 'Todo items (pending/in-progress/done counts)',
  plan: 'Plan board items (open/in-progress/done)',
  tasks: 'Task board items (structured work with type/priority)',
  fleet: 'Fleet agent status (running/idle/pending/completed)',
  fleet_agents: 'Per-agent live detail row',
  git: 'Git branch name',
  elapsed: 'Session elapsed time',
  context: 'Context window usage (input tokens)',
  tokens: 'Input/output token counters',
  cache: 'Prompt cache hit ratio',
  cost: 'Token cost estimate (input/output/total)',
  queue: 'Queued prompt count',
  hint: 'Transient status hint text',
  index: 'Codebase indexing status',
  breaker: 'Process breaker countdown',
  working_dir: 'Current working directory',
  project: 'Project name',
  yolo: 'YOLO permission mode',
  autonomy: 'Autonomy mode',
  eternal_stage: 'Autonomy stage',
  goal: 'Active goal summary',
  mode: 'Active agent mode label',
  auto_proceed: 'Auto-proceed countdown',
  sessions: 'Live session count',
  tools: 'Registered tool count',
  theme: 'Active color theme preset',
  token_saving: 'Token-saving mode indicator',
  memory: 'Current CLI process RAM and V8 heap usage',
  cpu: 'CPU usage percentage',
  side_effects: 'Side-effect / audit event count',
  brain: 'Brain arbiter decisions',
  mailbox: 'Mailbox unread messages and peers',
  enhance: 'Prompt-enhance countdown',
  debug_stream: 'Stream debug telemetry',
  next_steps: 'Next-step auto-submit countdown',
  memory_context: 'Memory context detail (total records + active-in-context)',
};

const ALL_CONFIG_KEYS = STATUSLINE_CONFIG_KEYS;

export function buildStatuslineCommand(deps: StatuslineCommandDeps): SlashCommand {
  return {
    name: 'statusline',
    category: 'Config',
    aliases: ['sl'],
    description: 'Customize status bar chips: /statusline [item] [on|off|reset]',
    help: [
      'Usage: /statusline [item] [on|off|reset]',
      '       /statusline              — show current config',
      '       /statusline <item>      — toggle item on/off',
      '       /statusline <item> on   — enable a chip',
      '       /statusline <item> off  — disable a chip',
      '       /statusline all on      — enable all chips',
      '       /statusline all off     — disable all chips',
      '       /statusline reset       — restore defaults',
      '',
      'Available items:',
      ...ALL_CONFIG_KEYS.map((k) => `  ${k.padEnd(12)} ${ITEM_DESCRIPTIONS[k]}`),
      '',
      'Density mode (minimum/detailed/no-color) is a separate setting — see /settings.',
      'These toggles set chip eligibility in any mode; some chips only render in detailed mode.',
      '',
      'Persistent across sessions (saved to ~/.wrongstack/profiles/<active>/statusline.json).',
    ].join('\n'),
    async run(args: string) {
      const cfg = await deps.getConfig();
      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/);
      const [item, action] = parts;

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
          const val = cfg[k];
          if (val === undefined) continue;
          lines.push(`  ${val ? '●' : '○'} ${k.padEnd(12)} ${ITEM_DESCRIPTIONS[k]}`);
        }
        return { message: lines.join('\n') };
      }

      // Reset
      if (item === 'reset') {
        await deps.setConfig({ ...DEFAULTS });
        deps.setHiddenItems([]);
        return { message: 'StatusBar config reset to defaults.' };
      }

      // Group operation: all on / all off
      if (item === 'all') {
        const onOff = action?.toLowerCase();
        if (!onOff || (onOff !== 'on' && onOff !== 'off')) {
          return { message: 'Usage: /statusline all on|off' };
        }
        const next: StatuslineConfig = {};
        for (const k of ALL_CONFIG_KEYS) {
          next[k] = onOff === 'on';
        }
        await deps.setConfig(next);
        deps.setHiddenItems(onOff === 'off' ? [...ALL_CONFIG_KEYS] : []);
        return {
          message: `statusline all: ${onOff === 'on' ? 'showing all chips' : 'hiding all chips'}`,
        };
      }

      // Single item toggle (no on/off specified)
      const validItems = ALL_CONFIG_KEYS;
      if (!validItems.includes(item as keyof StatuslineConfig)) {
        return {
          message: `Unknown item "${item}". Run /statusline to see available items.`,
        };
      }

      // If no action specified, toggle the item
      const onOff = action?.toLowerCase();
      if (!onOff) {
        const currentValue = cfg[item as keyof StatuslineConfig] ?? true;
        const newValue = !currentValue;
        const next = { ...cfg, [item]: newValue };
        await deps.setConfig(next);
        if (newValue) {
          deps.setHiddenItems(deps.hiddenItems.filter((i) => i !== item));
        } else {
          deps.setHiddenItems([...deps.hiddenItems, item as (typeof deps.hiddenItems)[number]]);
        }
        return { message: `statusline ${item}: ${newValue ? 'on' : 'off'}` };
      }

      if (onOff !== 'on' && onOff !== 'off') {
        return { message: `Usage: /statusline ${item} on|off` };
      }

      const next = { ...cfg, [item]: onOff === 'on' };
      await deps.setConfig(next);

      // Sync hiddenItems list with TUI
      if (onOff === 'off') {
        deps.setHiddenItems([...deps.hiddenItems, item as (typeof deps.hiddenItems)[number]]);
      } else {
        deps.setHiddenItems(deps.hiddenItems.filter((i) => i !== item));
      }

      return { message: `statusline ${item}: ${onOff}` };
    },
  };
}
