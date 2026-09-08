import type { Tool } from '@wrongstack/core/types';
import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol';
import { LSP_CONSTANTS } from '../constants.js';
import { supportsDocumentSymbol } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import { requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

interface Input {
  path: string;
}

export function createSymbolsTool(deps: ToolDeps): Tool<Input, string> {
  return {
    name: 'lsp_symbols',
    category: 'Code intelligence',
    description: 'List the semantic symbol tree of a source file.',
    usageHint:
      'Use to understand classes, functions, methods, and nesting in one file without reading the entire file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'auto',
    mutating: false,
    timeoutMs: LSP_CONSTANTS.TOOL_TIMEOUT_MS,
    async execute(input, ctx, opts) {
      try {
        const signal = opts?.signal ?? ctx.signal;
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, signal);
        if (server.capabilities && !supportsDocumentSymbol(server.capabilities))
          throw new LSPError(
            LSPErrorCode.CapabilityMissing,
            `Server "${server.name}" does not support document symbols`,
          );
        await deps.tracker.open(file);
        return formatSymbols(
          await server.documentSymbol(
            { textDocument: { uri: pathToUri(file) } },
            LSP_CONSTANTS.TOOL_TIMEOUT_MS,
            signal,
          ),
        );
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}

function formatSymbols(symbols: DocumentSymbol[] | SymbolInformation[] | null): string {
  if (!symbols?.length) return 'No document symbols.';
  const lines: string[] = [];
  const visit = (symbol: DocumentSymbol, depth: number) => {
    lines.push(
      `${'  '.repeat(depth)}${symbol.name} [${symbol.kind}] line ${symbol.selectionRange.start.line + 1}`,
    );
    for (const child of symbol.children ?? []) visit(child, depth + 1);
  };
  for (const symbol of symbols) {
    if ('selectionRange' in symbol) visit(symbol, 0);
    else lines.push(`${symbol.name} [${symbol.kind}] line ${symbol.location.range.start.line + 1}`);
  }
  return lines.join('\n');
}

export const symbolsCoverage = { formatSymbols };
