import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand } from './helpers.js';
import { executeSettingsSubcommand } from './settings-mutations.js';
import {
  formatCurrentSettingsView,
  formatSettingsDefaults,
  SETTINGS_HELP,
} from './settings-view.js';

/**
 * `/settings` — view or change persisted settings.
 *
 * Deliberately argument-driven and non-blocking: it never calls `reader.readLine`.
 * A blocking readline menu cannot run under the Ink TUI (Ink owns stdin in raw
 * mode), where it would hang invisibly and the renderer would fight Ink's frame.
 * Returning a single `{ message }` works identically in the plain REPL and the TUI.
 */
export function buildSettingsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'settings',
    category: 'Config',
    description:
      'View or change settings (auto-proceed, autonomy, context, features, token-saving).',
    help: SETTINGS_HELP,
    async run(args) {
      const { cmd, rest } = parseSubcommand(args);
      const sub = cmd;

      if (sub === 'help' || sub === '--help') {
        return { message: this.help ?? '' };
      }

      if (!opts.configStore || !opts.paths) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      // No args → show current settings (works in REPL and TUI).
      if (!sub) {
        return { message: formatCurrentSettingsView(opts) };
      }

      if (sub === 'defaults') {
        return {
          message: formatSettingsDefaults(),
        };
      }

      return executeSettingsSubcommand(sub, rest, opts);
    },
  };
}
