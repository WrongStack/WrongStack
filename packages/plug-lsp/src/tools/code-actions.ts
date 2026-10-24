import type { Tool } from '@wrongstack/contracts/types';
import type { CodeAction, Command } from 'vscode-languageserver-protocol';
import { LSP_CONSTANTS } from '../constants.js';
import { humanToLSP } from '../position.js';
import { supportsCodeAction } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import {
  readDocumentContent,
  requireServer,
  resolveInputPath,
  type ToolDeps,
  toToolError,
} from './shared.js';

interface Input {
  path: string;
  line?: number;
  character?: number;
}

export function createCodeActionsTool(deps: ToolDeps): Tool<Input, string> {
  return {
    name: 'lsp_code_actions',
    category: 'Code intelligence',
    description: 'List quick fixes and refactors offered by the language server.',
    usageHint:
      'Use after diagnostics to discover server-provided fixes. This tool lists actions without applying them.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line: { type: 'integer' },
        character: { type: 'integer' },
      },
      required: ['path'],
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: LSP_CONSTANTS.TOOL_TIMEOUT_MS,
    async execute(input, ctx, opts) {
      try {
        const signal = opts?.signal ?? ctx.signal;
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, signal);
        if (server.capabilities && !supportsCodeAction(server.capabilities))
          throw new LSPError(
            LSPErrorCode.CapabilityMissing,
            `Server "${server.name}" does not support code actions`,
          );
        const content = await readDocumentContent(file, deps.tracker);
        await deps.tracker.open(file, content);
        const uri = pathToUri(file);
        const diagnostics = await server.waitForDiagnostics(
          uri,
          deps.cfg.diagnosticsWaitMs,
          signal,
        );
        // Same 1-based byte-column convention as every other LSP tool. The raw
        // `character - 1` here sent a byte column where the server expects
        // UTF-16, so on a line with multi-byte text before the cursor the
        // actions came back for the wrong spot.
        const { line, character } = humanToLSP(content, {
          line: input.line ?? 1,
          character: input.character ?? 1,
        });
        const actions = await server.codeAction(
          {
            textDocument: { uri },
            range: { start: { line, character }, end: { line, character } },
            context: { diagnostics },
          },
          LSP_CONSTANTS.TOOL_TIMEOUT_MS,
          signal,
        );
        return formatActions(actions);
      } catch (err) {
        throw toToolError(err);
      }
    },
  };
}

function formatActions(actions: Array<CodeAction | Command>): string {
  if (!actions.length) return 'No code actions.';
  return actions
    .map(
      (action, index) =>
        `${index + 1}. ${action.title}${'kind' in action && action.kind ? ` [${action.kind}]` : ''}${'disabled' in action && action.disabled ? ` (disabled: ${action.disabled.reason})` : ''}`,
    )
    .join('\n');
}

export const codeActionsCoverage = { formatActions };
