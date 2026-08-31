import type { Tool } from '@wrongstack/core/types';
import { summarizeWorkspaceEdit } from '../formatters/workspace-edit.js';
import { humanToLSP } from '../position.js';
import { supportsRename } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import {
  readDocumentContent,
  requireServer,
  resolveInputPath,
  stringifyToolError,
  type ToolDeps,
} from './shared.js';
import { applyWorkspaceEdit } from './workspace-edit.js';

interface RenameInput {
  path: string;
  line: number;
  character: number;
  new_name: string;
}

export function createRenameTool(deps: ToolDeps): Tool<RenameInput, string> {
  return {
    name: 'lsp_rename',
    description: 'Rename a symbol semantically across the workspace.',
    usageHint:
      'Prefer this over find-and-replace for functions, classes, variables, and types. This mutates files and requires confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line: { type: 'integer' },
        character: { type: 'integer' },
        new_name: { type: 'string' },
      },
      required: ['path', 'line', 'character', 'new_name'],
    },
    permission: 'confirm',
    mutating: true,
    timeoutMs: 15_000,
    maxOutputBytes: 65_536,
    async execute(input, ctx, opts) {
      try {
        const signal = opts?.signal ?? ctx?.signal;
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, signal);
        if (server.capabilities && !supportsRename(server.capabilities)) {
          throw new LSPError(
            LSPErrorCode.CapabilityMissing,
            `Server "${server.name}" does not support rename`,
          );
        }
        const content = await readDocumentContent(file, deps.tracker);
        const position = humanToLSP(content, { line: input.line, character: input.character });
        const edit = await server.rename(
          {
            textDocument: { uri: pathToUri(file) },
            position,
            newName: input.new_name,
          },
          15_000,
          signal,
        );
        if (!edit) return 'Rename produced no edits.';
        const summary = summarizeWorkspaceEdit(edit, ctx.cwd);
        const applied = await applyWorkspaceEdit(edit, deps.tracker);
        return `${summary}\nApplied: ${applied.edits} edits across ${applied.files.length} files.`;
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}
