import type { SlashCommand } from '@wrongstack/contracts/types';
import type { LSPRegistry } from '../registry.js';

export function listCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'lsp-list',
    // Kept as a deprecated alias for one release so existing muscle memory
    // (`/list`) still resolves. The bare `/list` collides with no core
    // command today, but the LSP-specific name is more discoverable.
    aliases: ['list'],
    description: 'List configured LSP servers.',
    async run() {
      const rows = registry.list().map((s) => {
        const langs = s.config.languages.join(',');
        return `${s.name.padEnd(18)} ${s.state.padEnd(14)} ${langs} ${s.rootPath}`;
      });
      return { message: rows.length ? rows.join('\n') : 'No LSP servers configured.' };
    },
  };
}
