import type { SlashCommand } from '@wrongstack/core/types';

interface ConnectionsSlashDeps {
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
}

/**
 * TUI `/connections` — panel-first. Bare `/connections` (and `open` / `--open`)
 * opens the interactive service health panel and emits nothing to chat history.
 */
export function createConnectionsSlashCommand(deps: ConnectionsSlashDeps): SlashCommand {
  return {
    name: 'connections',
    aliases: ['conn', 'conns'],
    description: 'Show service connection health — Chronicle, Codebase Index, SAGE Memory, Kanban IPC, Mailbox IPC.',
    argsHint: '[open]',
    category: 'Inspect',
    help:
      'Usage:\n' +
      '  /connections         — open the interactive service health panel\n' +
      '  /connections open    — same as above\n',
    async run(args: string) {
      const trimmed = args.trim().toLowerCase();
      const panelRequest = trimmed === '' || trimmed === 'open' || trimmed === '--open';

      if (!panelRequest) {
        return { message: 'Usage: /connections [open]' };
      }

      const opened = deps.onPanelOpen?.current?.('toggleConnectionsPanel') ?? false;
      if (opened) return { message: '' };

      return { message: 'Interactive connections panel is unavailable in this TUI instance.' };
    },
  };
}
