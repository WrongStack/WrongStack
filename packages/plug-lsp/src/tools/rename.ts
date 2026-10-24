import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { summarizeWorkspaceEdit } from '../formatters/workspace-edit.js';
import { humanToLSP } from '../position.js';
import { supportsRename } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import {
  readDocumentContent,
  requireServer,
  resolveInputPath,
  type ToolDeps,
  toToolError,
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
        path: { type: 'string', description: 'File containing the symbol.' },
        line: { type: 'integer', minimum: 1, description: '1-based line of the symbol.' },
        character: {
          type: 'integer',
          minimum: 1,
          description: '1-based column inside the symbol name.',
        },
        new_name: {
          type: 'string',
          minLength: 1,
          pattern: '^\\S+$',
          description: 'New identifier. No whitespace.',
        },
      },
      required: ['path', 'line', 'character', 'new_name'],
    },
    permission: 'confirm',
    mutating: true,
    timeoutMs: 15_000,
    maxOutputBytes: 65_536,
    async execute(input, ctx, opts) {
      // The server does not validate the name: "bad name" was applied across
      // every reference and broke the code in two files (audit 2026-09-15).
      // Refuse before the server is asked, since the edit is written at once.
      if (!/^\S+$/.test(input.new_name)) {
        throw new ToolValidationError({
          message: `lsp_rename: new_name must be a non-empty identifier without whitespace, got ${JSON.stringify(input.new_name)}`,
          field: 'new_name',
        });
      }
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
        await deps.tracker.open(file, content);
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
        const applied = await applyWorkspaceEdit(edit, deps.tracker, ctx.projectRoot ?? ctx.cwd);
        return `${summary}\nApplied: ${applied.edits} edits across ${applied.files.length} files.`;
      } catch (err) {
        throw toToolError(err);
      }
    },
  };
}
