import type { Tool } from '@wrongstack/core/types';
import { LSP_CONSTANTS } from '../constants.js';
import { formatLocations } from '../formatters/location.js';
import { humanToLSP } from '../position.js';
import { supportsDefinition } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import {
  readDocumentContent,
  requireServer,
  resolveInputPath,
  stringifyToolError,
  type ToolDeps,
} from './shared.js';

interface PositionInput {
  path: string;
  line: number;
  character: number;
}

export function createDefinitionTool(deps: ToolDeps): Tool<PositionInput, string> {
  return {
    name: 'lsp_definition',
    description: 'Find where a symbol is defined.',
    usageHint:
      'Use for semantic navigation when you know the symbol position. Lines and columns are 1-based.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line: { type: 'integer' },
        character: { type: 'integer' },
      },
      required: ['path', 'line', 'character'],
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: LSP_CONSTANTS.TOOL_TIMEOUT_MS,
    async execute(input, ctx, opts) {
      try {
        const signal = opts?.signal ?? ctx?.signal;
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, signal);
        if (server.capabilities && !supportsDefinition(server.capabilities)) {
          throw new LSPError(
            LSPErrorCode.CapabilityMissing,
            `Server "${server.name}" does not support definition`,
          );
        }
        const content = await readDocumentContent(file, deps.tracker);
        const position = humanToLSP(content, { line: input.line, character: input.character });
        const locs = await server.definition(
          { textDocument: { uri: pathToUri(file) }, position },
          LSP_CONSTANTS.TOOL_TIMEOUT_MS,
          signal,
        );
        return formatLocations(locs, ctx.cwd);
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
