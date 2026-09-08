import type { Tool } from '@wrongstack/core/types';
import { LSP_CONSTANTS } from '../constants.js';
import { formatDiagnostics } from '../formatters/diagnostics.js';
import { supportsPullDiagnostics } from '../server/capabilities.js';
import { pathToUri, uriToPath } from '../utils/uri.js';
import { requireServer, resolveInputPath, stringifyToolError, type ToolDeps } from './shared.js';

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
        if (input.path) {
          const file = resolveInputPath(input.path, ctx);
          const server = await requireServer(deps.registry, file, signal);
          await deps.tracker.open(file);
          const uri = pathToUri(file);
          const diagnostics =
            server.capabilities && supportsPullDiagnostics(server.capabilities)
              ? await server.pullDiagnostics(uri, LSP_CONSTANTS.TOOL_TIMEOUT_MS, signal)
              : await server.waitForDiagnostics(uri, deps.cfg.diagnosticsWaitMs, signal);
          byFile.set(file, diagnostics);
        } else {
          // Workspace sweep: wait once per server, not once per document —
          // servers publish for every open file, so the first push usually
          // settles the rest and a per-file wait would multiply the latency.
          const waited = new Set<string>();
          for (const doc of deps.tracker.list()) {
            const server = await deps.registry.findForPath(doc.path, signal);
            if (!server) continue;
            const diagnostics = waited.has(server.name)
              ? server.getDiagnostics(doc.uri)
              : await server.waitForDiagnostics(doc.uri, deps.cfg.diagnosticsWaitMs, signal);
            waited.add(server.name);
            byFile.set(uriToPath(doc.uri), diagnostics);
          }
        }
        return formatDiagnostics(byFile, {
          cwd: ctx.cwd,
          severityFilter: deps.cfg.severityFilter,
          maxPerFile: deps.cfg.maxDiagnosticsPerFile,
          maxTotal: input.limit ?? deps.cfg.maxDiagnosticsTotal,
        });
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
