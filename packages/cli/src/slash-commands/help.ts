import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';
import { renderSlashDeepHelp, renderSlashFocusedHelp } from './slash-deep-help.js';

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
        // `/help <slash> <deep>` — e.g. `/help mcp add`. A slash command with
        // a top-level `wstack` mirror renders the SAME block `wstack mcp add
        // --help` writes, so the in-REPL and CLI help surfaces cannot drift.
        // Handled before the registry lookup because a two-token query never
        // matches a command name (it used to fall through to
        // "Unknown command: /mcp add").
        const queryParts = query.split(/\s+/).filter(Boolean);
        if (queryParts.length === 2) {
          const head = (queryParts[0] as string).replace(/^\//, '');
          const deepHelp = renderSlashDeepHelp(head, queryParts[1] as string);
          if (deepHelp) return { message: deepHelp };
        }

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
        // A slash command that mirrors a top-level subcommand APPENDS the
        // focused `wstack <sub> --help` block after its inline help. The two
        // are complementary, not redundant: the inline field teaches the
        // slash form the user actually types (`/plugin official`), while the
        // focused block is the full option reference and is the single
        // rendering shared with the CLI, so the surfaces cannot drift. A
        // slash with no top-level mirror keeps the inline field alone.
        const focused = renderSlashFocusedHelp(match.cmd.name);
        const body = [match.cmd.help ?? match.cmd.description, focused]
          .filter(Boolean)
          .join('\n\n');
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
