import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildHelpCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'help',
    category: 'App',
    description: 'Show available slash commands. Pass a name for detailed help.',
    help: [
      'Usage:',
      '  /help            List every command with its one-line description.',
      '  /help <name>     Show detailed help for one command (falls back to the description).',
      '',
      'Examples:',
      '  /help',
      '  /help context',
      '  /help setmodel',
    ].join('\n'),
    async run(args) {
      const query = args.trim();

      // TUI mode: bare /help opens the interactive help panel.
      if (!query && opts.onPanelOpen?.current) {
        opts.onPanelOpen.current('helpOpen');
        return { message: '' };
      }

      if (query) {
        const needle = query.startsWith('/') ? query.slice(1) : query;
        let match: { cmd: SlashCommand; owner: string; fullName: string } | undefined;
        for (const entry of opts.registry.listWithOwner()) {
          const aliases = entry.cmd.aliases ?? [];
          const candidates = [
            entry.cmd.name,
            entry.fullName,
            ...aliases,
            ...aliases.map((a) => (entry.owner === 'core' ? a : `${entry.owner}:${a}`)),
          ];
          if (candidates.includes(needle)) {
            match = entry;
            break;
          }
        }
        if (!match) return { message: `Unknown command: /${needle}. Run /help to list commands.` };
        const prefix = match.owner === 'core' ? '' : `${match.owner}:`;
        const header = `/${prefix}${match.cmd.name}`;
        const aliasLine = match.cmd.aliases?.length
          ? `Aliases: ${match.cmd.aliases.map((a) => `/${prefix}${a}`).join(', ')}\n`
          : '';
        const body = match.cmd.help ?? match.cmd.description;
        return {
          message: [
            header,
            '─'.repeat(header.length),
            aliasLine + (match.cmd.help ? '' : `${match.cmd.description}\n`),
            body,
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }
      const lines = ['Available slash commands:'];
      for (const { cmd, owner } of opts.registry.listWithOwner()) {
        const prefix = owner === 'core' ? '' : `${owner}:`;
        const aliases = cmd.aliases ? cmd.aliases.map((a) => `/${prefix}${a}`).join(', ') : '';
        const aliasStr = aliases ? ` (${aliases})` : '';
        lines.push(`  /${prefix}${cmd.name}${aliasStr} — ${cmd.description}`);
      }
      lines.push('', 'Run `/help <name>` for detailed help on a specific command.');
      return { message: lines.join('\n') };
    },
  };
}
