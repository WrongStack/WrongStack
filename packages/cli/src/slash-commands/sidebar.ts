import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand } from './helpers.js';

export function buildSidebarCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'sidebar',
    category: 'Config',
    description: 'Toggle or configure the TUI right sidebar visibility.',
    help: [
      'Usage:',
      '  /sidebar           Toggle the right sidebar on/off',
      '  /sidebar on        Show the right sidebar',
      '  /sidebar off       Hide the right sidebar (chat uses full terminal width)',
      '  /sidebar status    Show current sidebar visibility',
    ].join('\n'),
    async run(args) {
      const { cmd } = parseSubcommand(args);
      const sub = cmd.toLowerCase();

      if (sub === 'help' || sub === '--help') {
        return { message: this.help ?? '' };
      }

      if (!opts.configStore) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      const current = opts.configStore.get().autonomy?.showSidebar ?? true;

      let next: boolean;
      if (!sub || sub === 'toggle') {
        next = !current;
      } else if (sub === 'on' || sub === 'true' || sub === '1' || sub === 'show') {
        next = true;
      } else if (sub === 'off' || sub === 'false' || sub === '0' || sub === 'hide') {
        next = false;
      } else if (sub === 'status') {
        return {
          message: `Right sidebar is currently ${current ? color.green('on') : color.yellow('off')}.`,
        };
      } else {
        return {
          message: `Unknown argument "${sub}". Use \`/sidebar on\`, \`/sidebar off\`, or \`/sidebar\`.`,
        };
      }

      opts.configStore.update({
        autonomy: {
          ...(opts.configStore.get().autonomy ?? {}),
          showSidebar: next,
        },
      });

      return {
        message: `Right sidebar is now ${next ? color.green('on') : color.yellow('off')}.`,
      };
    },
  };
}
