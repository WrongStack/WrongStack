import type { Tool } from '@wrongstack/core/types';
import type { Hover, MarkedString, MarkupContent } from 'vscode-languageserver-protocol';
import { LSP_CONSTANTS } from '../constants.js';
import { humanToLSP } from '../position.js';
import { supportsHover } from '../server/capabilities.js';
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
}

export function createHoverTool(deps: ToolDeps): Tool<Input, string> {
  return {
    name: 'lsp_hover',
    category: 'Code intelligence',
    description: 'Get type and documentation information for a symbol.',
    usageHint:
      'Use for inferred types, overload signatures, and API documentation without navigating away. Lines and columns are 1-based.',
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
        const signal = opts?.signal ?? ctx.signal;
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, signal);
        if (server.capabilities && !supportsHover(server.capabilities))
          throw new LSPError(
            LSPErrorCode.CapabilityMissing,
            `Server "${server.name}" does not support hover`,
          );
        const content = await readDocumentContent(file, deps.tracker);
        await deps.tracker.open(file, content);
        const position = humanToLSP(content, { line: input.line, character: input.character });
        return formatHover(
          await server.hover(
            { textDocument: { uri: pathToUri(file) }, position },
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

function formatHover(hover: Hover | null): string {
  if (!hover) return 'No hover information.';
  const values = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  return values
    .map((value) =>
      typeof value === 'string'
        ? value
        : 'kind' in value
          ? (value as MarkupContent).value
          : `\`\`\`${(value as MarkedString & { language: string }).language}\n${(value as { value: string }).value}\n\`\`\``,
    )
    .join('\n\n');
}

export const hoverCoverage = { formatHover };
