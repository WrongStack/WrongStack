import type { SlashCommand } from '@wrongstack/core/types';
import { formatDiagnostics } from '../formatters/diagnostics.js';
import type { LSPRegistry } from '../registry.js';

export function diagnosticsCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'diagnostics',
    description: 'Print buffered LSP diagnostics.',
    async run(_args, ctx) {
      const byFile = new Map<string, import('vscode-languageserver-protocol').Diagnostic[]>();
      for (const server of registry.list()) {
        for (const [filePath, diagnostics] of server.diagnostics.entries()) {
          // Keys are already `uriKey(uri)` — a normalized filesystem path, not
          // a URL — so they are used as-is. `uriToPath` (fileURLToPath) throws
          // ERR_INVALID_URL_SCHEME on them.
          // Merge, never overwrite: several servers can report the same
          // document, and `formatDiagnostics` expects one entry per file
          // holding every diagnostic. `/lsp diagnostics` merges the same way.
          const existing = byFile.get(filePath) ?? [];
          byFile.set(filePath, [...existing, ...diagnostics]);
        }
      }
      return {
        message: formatDiagnostics(byFile, {
          cwd: ctx?.cwd ?? process.cwd(),
          severityFilter: ['error', 'warning'],
          maxPerFile: 10,
          maxTotal: 100,
        }),
      };
    },
  };
}
