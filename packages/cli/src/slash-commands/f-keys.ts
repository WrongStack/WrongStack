import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';

/**
 * F-key panels mapped by number (1-12).
 * Each entry: [TUI dispatch action type, human-readable label].
 * The TUI dispatches these actions; in the REPL we show a message.
 */
const F_PANELS: Record<string, { action: string; label: string }> = {
  '1': { action: 'projectPickerOpen', label: 'project switcher' },
  '2': { action: 'toggleMonitor', label: 'fleet orchestration monitor' },
  '3': { action: 'toggleAgentsMonitor', label: 'agents live monitor' },
  '4': { action: 'toggleWorktreeMonitor', label: 'worktree monitor' },
  '5': { action: 'togglePlanPanel', label: 'autonomy settings' },
  '6': { action: 'toggleTodosMonitor', label: 'todos monitor overlay' },
  '7': { action: 'toggleQueuePanel', label: 'queue panel' },
  '8': { action: 'toggleProcessList', label: 'process list overlay' },
  '9': { action: 'toggleGoalPanel', label: 'goal panel' },
  '10': { action: 'toggleSessionsPanel', label: 'live sessions panel' },
  '11': { action: 'toggleCoordinatorMonitor', label: 'coordinator monitor' },
  '12': { action: 'statuslineOpen', label: 'status line picker' },
};

/**
 * Build the `/f` slash command and its hidden `/f1`–`/f12` aliases.
 *
 * - `/f` (no args) — list numbered F-key options
 * - `/f 1` … `/f 12` — open the corresponding panel
 * - `/f1` … `/f12` — same as above (hidden aliases, not shown in the picker)
 *
 * The TUI handles panel opening via `onPanelOpen`; the REPL shows a message.
 */
export function buildFKeysCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'f',
    description: 'Open F-key panels (F1–F12). Type /f for numbered options.',
    hidden: false,
    async run(args) {
      const n = args.trim();

      // No args → show the numbered list
      if (!n) {
        const lines = ['F-key panels:'];
        for (const [num, { label }] of Object.entries(F_PANELS)) {
          lines.push(`  /f ${num} — ${label}`);
        }
        lines.push('', 'Or use /f1 … /f12 directly (hidden from the picker).');
        return { message: lines.join('\n') };
      }

      // Numeric arg → open the panel
      const entry = F_PANELS[n];
      if (!entry) {
        return { message: `Unknown F-key: ${n}. Use /f to list available panels (1–12).` };
      }

      // Try the TUI panel-open callback first; fall back to a message.
      if (opts.onPanelOpen.current) {
        const ok = opts.onPanelOpen.current(entry.action);
        if (ok) return {};
      }

      return {
        message: `Opening ${entry.label}… (REPL/headless mode — panel may not be available)`,
      };
    },
  };
}

/**
 * Build hidden `/f1`–`/f12` alias commands.
 * These are registered individually so typing `/f1` (no space) also works.
 */
export function buildFKeyAliasCommands(opts: SlashCommandContext): SlashCommand[] {
  return Object.entries(F_PANELS).map(([num, { action, label }]): SlashCommand => {
    const cmd: SlashCommand = {
      name: `f${num}`,
      description: `Open ${label} (same as F${num})`,
      hidden: true, // not shown in the main slash picker
      async run() {
        if (opts.onPanelOpen.current) {
          const ok = opts.onPanelOpen.current(action);
          if (ok) return {};
        }
        return { message: `Opening ${label}…` };
      },
    };
    return cmd;
  });
}
