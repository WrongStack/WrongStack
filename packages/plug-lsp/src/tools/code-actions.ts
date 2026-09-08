import type { Tool } from '@wrongstack/core/types';
import type { CodeAction, Command } from 'vscode-languageserver-protocol';
import { LSP_CONSTANTS } from '../constants.js';
import { supportsCodeAction } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import { requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

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
        await deps.tracker.open(file);
        const uri = pathToUri(file);
        const diagnostics = await server.waitForDiagnostics(
          uri,
          deps.cfg.diagnosticsWaitMs,
          signal,
        );
        const line = Math.max(0, (input.line ?? 1) - 1);
        const character = Math.max(0, (input.character ?? 1) - 1);
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
        return stringifyToolError(err);
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
