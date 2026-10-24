import type { SlashCommand } from '@wrongstack/contracts/types';
import type { LSPRegistry } from '../registry.js';

export function restartCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'lsp-restart',
    // Kept as a deprecated alias for one release so existing muscle memory
    // (`/restart <name>`) still resolves.
    aliases: ['restart'],
    description: 'Restart an LSP server.',
    async run(args) {
      const name = args.trim();
      if (!name) return { message: 'Usage: /@wrongstack/plug-lsp:lsp-restart <name>' };
      await registry.restart(name);
      return { message: `Restarted LSP server "${name}".` };
    },
  };
}
