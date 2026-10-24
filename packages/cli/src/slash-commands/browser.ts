import type { SlashCommand } from '@wrongstack/contracts/types';
import { BROWSER_POLICY_HELP, runBrowserPolicyCommand } from '@wrongstack/tools/browser';

export function buildBrowserCommand(): SlashCommand {
  return {
    name: 'browser',
    aliases: ['network'],
    category: 'Config',
    description:
      'Manage browser setup and project origins shared by browser, fetch and read_url_content.',
    argsHint: '[install|allow|remove] [origin|loopback]',
    help: BROWSER_POLICY_HELP,
    async run(args, ctx) {
      const root = ctx?.projectRoot ?? ctx?.cwd ?? process.cwd();
      return { message: await runBrowserPolicyCommand(root, args) };
    },
  };
}
