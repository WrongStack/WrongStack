import type { SlashCommand } from '@wrongstack/contracts/types';
import type { LSPRegistry } from '../registry.js';

export function stopCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'lsp-stop',
    // Kept as a deprecated alias for one release so existing muscle memory
    // (`/stop <name>`) still resolves. The bare `/stop` collides with the
    // core `/interrupt` command (which uses `/stop` as an alias), so the
    // namespaced form has always been the only way to reach LSP-stop without
    // ambiguity; renaming to `lsp-stop` makes that intent explicit at the
    // bare name as well. NOTE: the registry's alias-reservation invariant
    // refuses the `stop` alias write at runtime (`isCoreOwnedAlias` /
    // `isAliasReservedKey` in slash-command-registry.ts), so bare `/stop`
    // still routes to `/interrupt`; the namespace form
    // `/@wrongstack/plug-lsp:lsp-stop` (and the new bare `/lsp-stop`) are
    // the only paths to this command. The alias is left in source so the
    // declaration is honest about the intent — if a future core refactor
    // frees `stop`, the alias will register and old scripts come back.
    aliases: ['stop'],
    description: 'Stop an LSP server.',
    async run(args) {
      const name = args.trim();
      if (!name) return { message: 'Usage: /@wrongstack/plug-lsp:lsp-stop <name>' };
      await registry.stop(name);
      return { message: `Stopped LSP server "${name}".` };
    },
  };
}
