import type { Tool } from '@wrongstack/core/types';
import { LSP_CONSTANTS } from '../constants.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

interface Input {
  path: string;
  method: string;
  params?: unknown;
}

const BLOCKED_METHODS = new Set(['initialize', 'initialized', 'shutdown', 'exit']);

export function createRequestTool(deps: ToolDeps): Tool<Input, string> {
  return {
    name: 'lsp_request',
    category: 'Code intelligence',
    description: 'Invoke a custom request method exposed by a language server.',
    usageHint:
      'Use only when no typed LSP tool covers a documented server-specific request. Lifecycle methods are blocked; arbitrary requests require confirmation because vendor methods may mutate state.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path used to select the language server' },
        method: { type: 'string', description: 'Documented JSON-RPC request method' },
        params: { description: 'JSON-compatible request parameters' },
      },
      required: ['path', 'method'],
    },
    permission: 'confirm',
    mutating: true,
    timeoutMs: LSP_CONSTANTS.TOOL_TIMEOUT_MS,
    async execute(input, ctx, opts) {
      try {
        const method = input.method.trim();
        if (!method || BLOCKED_METHODS.has(method)) {
          throw new LSPError(
            LSPErrorCode.InvalidRequest,
            `LSP lifecycle method "${method || '(empty)'}" cannot be invoked through lsp_request`,
          );
        }
        const signal = opts?.signal ?? ctx.signal;
        const server = await requireServer(
          deps.registry,
          resolveInputPath(input.path, ctx),
          signal,
        );
        const result = await server.customRequest(
          method,
          input.params ?? null,
          LSP_CONSTANTS.TOOL_TIMEOUT_MS,
          signal,
        );
        return result === undefined || result === null
          ? 'Request completed.'
          : JSON.stringify(result, null, 2);
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}

export const requestCoverage = { BLOCKED_METHODS };
