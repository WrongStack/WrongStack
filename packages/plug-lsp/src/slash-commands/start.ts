import type { SlashCommand } from '@wrongstack/contracts/types';
import type { LSPRegistry } from '../registry.js';

export function startCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'lsp-start',
    // Kept as a deprecated alias for one release so existing muscle memory
    // (`/start <name>`) still resolves. The bare `/start` collides with no
    // core command today, but the LSP-specific name is more discoverable.
    aliases: ['start'],
    description: 'Start an LSP server.',
    async run(args) {
      const name = args.trim();
      if (!name) return { message: 'Usage: /@wrongstack/plug-lsp:lsp-start <name>' };
      await registry.start(name);
      return { message: `Started LSP server "${name}".` };
    },
  };
}
