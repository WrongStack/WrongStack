import type { Tool } from '@wrongstack/core/types';
import { LSP_CONSTANTS } from '../constants.js';
import { formatLocations } from '../formatters/location.js';
import { humanToLSP } from '../position.js';
import { supportsReferences } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import {
  readDocumentContent,
  requireServer,
  resolveInputPath,
  stringifyToolError,
  type ToolDeps,
} from './shared.js';

interface Input {
  path: string;
  line: number;
  character: number;
  include_declaration?: boolean;
}

export function createReferencesTool(deps: ToolDeps): Tool<Input, string> {
  return {
    name: 'lsp_references',
    category: 'Code intelligence',
    description: 'Find semantic references to the symbol at a source position.',
    usageHint:
      'Use instead of text search when aliases, imports, overloads, or same-named symbols make textual matches ambiguous. Lines and columns are 1-based.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line: { type: 'integer' },
        character: { type: 'integer' },
        include_declaration: { type: 'boolean' },
      },
      required: ['path', 'line', 'character'],
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: LSP_CONSTANTS.TOOL_TIMEOUT_MS,
    async execute(input, ctx, opts) {
      try {
        const signal = opts?.signal ?? ctx.signal;
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, signal);
        if (server.capabilities && !supportsReferences(server.capabilities))
          throw new LSPError(
            LSPErrorCode.CapabilityMissing,
            `Server "${server.name}" does not support references`,
          );
        const content = await readDocumentContent(file, deps.tracker);
        await deps.tracker.open(file, content);
        const position = humanToLSP(content, { line: input.line, character: input.character });
        return formatLocations(
          await server.references(
            {
              textDocument: { uri: pathToUri(file) },
              position,
              context: { includeDeclaration: input.include_declaration ?? true },
            },
            LSP_CONSTANTS.TOOL_TIMEOUT_MS,
            signal,
          ),
          ctx.cwd,
        );
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
