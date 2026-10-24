import type { Tool } from '@wrongstack/contracts/types';
import { LSP_CONSTANTS } from '../constants.js';
import { formatDiagnostics } from '../formatters/diagnostics.js';
import { supportsPullDiagnostics } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import {
  createLineTextReader,
  requireServer,
  resolveInputPath,
  type ToolDeps,
  toToolError,
} from './shared.js';

interface DiagnosticsInput {
  path?: string | undefined;
  limit?: number | undefined;
}

export function createDiagnosticsTool(deps: ToolDeps): Tool<DiagnosticsInput, string> {
  return {
    name: 'lsp_diagnostics',
    description: 'Get diagnostics from configured language servers.',
    usageHint:
      'Use after reading or editing a file when an LSP server is configured. Pass `path` for file diagnostics or omit it for tracked workspace diagnostics.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'integer' } },
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: LSP_CONSTANTS.TOOL_TIMEOUT_MS,
    maxOutputBytes: 65_536,
    async execute(input, ctx, opts) {
      try {
        const signal = opts?.signal ?? ctx?.signal;
        const byFile = new Map<string, import('vscode-languageserver-protocol').Diagnostic[]>();
        const servers = new Set<string>();
        const files = input.path
          ? [resolveInputPath(input.path, ctx)]
          : deps.tracker.list().map((doc) => doc.path);
        if (files.length === 0) {
          throw new LSPError(
            LSPErrorCode.InvalidRequest,
            'No tracked documents to check. Pass a file path; the workspace has not been verified.',
          );
        }
        // Each document needs its own response. A publication for one URI says
        // nothing about another URI, even when they share a language server.
        // Resolve/start and open sequentially; wait for analysis concurrently.
        const pending = [];
        for (const file of files) {
          const server = await requireServer(deps.registry, file, signal);
          if (!(await deps.tracker.open(file))) {
            throw new LSPError(
              LSPErrorCode.InvalidRequest,
              `Could not open ${file} for LSP diagnostics (unreadable, unsupported, or too large).`,
            );
          }
          const uri = pathToUri(file);
          servers.add(server.name);
          pending.push({ file, uri, server });
        }
        await Promise.all(
          pending.map(async ({ file, uri, server }) => {
            const diagnostics =
              server.capabilities && supportsPullDiagnostics(server.capabilities)
                ? await server.pullDiagnostics(uri, LSP_CONSTANTS.TOOL_TIMEOUT_MS, signal)
                : await server.waitForDiagnostics(uri, deps.cfg.diagnosticsWaitMs, signal, true);
            byFile.set(file, diagnostics);
          }),
        );
        const output = formatDiagnostics(byFile, {
          cwd: ctx.cwd,
          severityFilter: deps.cfg.severityFilter,
          maxPerFile: deps.cfg.maxDiagnosticsPerFile,
          maxTotal: input.limit ?? deps.cfg.maxDiagnosticsTotal,
          lineText: createLineTextReader(deps.tracker),
        });
        return `${output}\nChecked ${files.length} ${input.path ? 'file' : 'tracked files'} via ${[...servers].join(', ')}; severities: ${deps.cfg.severityFilter.join(', ')}.`;
      } catch (err) {
        throw toToolError(err);
      }
    },
  };
}
