import type { Tool } from '@wrongstack/core/types';
import { createCodeActionsTool } from './code-actions.js';
import { createCodebaseLspSearchTool } from './codebase-lsp-search.js';
import { createCompletionTool } from './completion.js';
import { createDefinitionTool } from './definition.js';
import { createDiagnosticsTool } from './diagnostics.js';
import { createExecuteCommandTool } from './execute-command.js';
import { createHoverTool } from './hover.js';
import { createReferencesTool } from './references.js';
import { createRenameTool } from './rename.js';
import { createRequestTool } from './request.js';
import type { ToolDeps } from './shared.js';
import { createSymbolsTool } from './symbols.js';

export function makeLSPTools(deps: ToolDeps): Tool[] {
  return [
    createDiagnosticsTool(deps),
    createDefinitionTool(deps),
    createReferencesTool(deps),
    createHoverTool(deps),
    createCompletionTool(deps),
    createSymbolsTool(deps),
    createCodeActionsTool(deps),
    createExecuteCommandTool(deps),
    createRequestTool(deps),
    createCodebaseLspSearchTool(deps),
    createRenameTool(deps),
  ];
}
