import type { SlashCommand } from '@wrongstack/contracts/types';

interface ConnectionsSlashDeps {
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
}

/**
 * Bare `/connections` opens the panel; `restart` runs the same daemon actions
 * directly and reports each result in chat.
 */
export function createConnectionsSlashCommand(deps: ConnectionsSlashDeps): SlashCommand {
  let restarting = false;
  return {
    name: 'connections',
    aliases: ['conn', 'conns'],
    description:
      'Show service connection health and restart daemons — Session Catalog, Chronicle, Codebase Index, SAGE, Kanban, Mailbox, Governance.',
    argsHint: '[open|restart]',
    category: 'Inspect',
    help:
      'Usage:\n' +
      '  /connections         — open the interactive service health and restart panel\n' +
      '  /connections open    — same as above\n' +
      '  /connections restart — restart all six supported project daemons without opening the panel\n' +
      'Governance is read-only and is excluded from restart.\n',
    async run(args: string, ctx) {
      const trimmed = args.trim().toLowerCase();
      if (trimmed === 'restart') {
        if (!ctx?.projectRoot) return { message: 'No active project; cannot restart daemons.' };
        if (restarting) return { message: 'Connection daemon restart is already in progress.' };
        restarting = true;
        try {
          const { executeConnectionAction, RESTARTABLE_SERVICES } = await import(
            './connection-actions.js'
          );
          const projectRoot = ctx.projectRoot;
          const lines: string[] = [];
          let succeeded = 0;
          for (const serviceId of RESTARTABLE_SERVICES) {
            try {
              const result = await executeConnectionAction(serviceId, 'restart', projectRoot);
              if (result.success) succeeded++;
              lines.push(`${result.success ? 'OK' : 'FAILED'} ${serviceId}: ${result.message}`);
            } catch (error) {
              lines.push(
                `FAILED ${serviceId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          return {
            message: [
              `Restarted ${succeeded}/${RESTARTABLE_SERVICES.length} project daemons.`,
              ...lines,
              'Governance skipped: read-only service.',
            ].join('\n'),
          };
        } finally {
          restarting = false;
        }
      }
      const panelRequest = trimmed === '' || trimmed === 'open' || trimmed === '--open';

      if (!panelRequest) {
        return { message: 'Usage: /connections [open|restart]' };
      }

      const opened = deps.onPanelOpen?.current?.('toggleConnectionsPanel') ?? false;
      if (opened) return { message: '' };

      return { message: 'Interactive connections panel is unavailable in this TUI instance.' };
    },
  };
}
