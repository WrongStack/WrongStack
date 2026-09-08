import type { Tool } from '@wrongstack/core/types';
import { LSP_CONSTANTS } from '../constants.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

interface Input {
  path: string;
  command: string;
  arguments?: unknown[];
}

export function createExecuteCommandTool(deps: ToolDeps): Tool<Input, string> {
  return {
    name: 'lsp_execute_command',
    category: 'Code intelligence',
    description: 'Execute a named command exposed by a configured language server.',
    usageHint:
      'Use only for a command returned by lsp_code_actions or explicitly documented by the active server. This may mutate workspace state and requires confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        command: { type: 'string' },
        arguments: { type: 'array', items: {} },
      },
      required: ['path', 'command'],
    },
    permission: 'confirm',
    mutating: true,
    timeoutMs: LSP_CONSTANTS.TOOL_TIMEOUT_MS,
    async execute(input, ctx, opts) {
      try {
        const signal = opts?.signal ?? ctx.signal;
        const server = await requireServer(
          deps.registry,
          resolveInputPath(input.path, ctx),
          signal,
        );
        const commands = server.capabilities?.executeCommandProvider?.commands;
        if (!commands?.includes(input.command)) {
          throw new LSPError(
            LSPErrorCode.CapabilityMissing,
            `Server "${server.name}" does not expose command "${input.command}"`,
          );
        }
        const result = await server.executeCommand(
          { command: input.command, ...(input.arguments ? { arguments: input.arguments } : {}) },
          LSP_CONSTANTS.TOOL_TIMEOUT_MS,
          signal,
        );
        return result === undefined || result === null
          ? 'Command completed.'
          : JSON.stringify(result, null, 2);
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
