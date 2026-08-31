import type { Tool } from '@wrongstack/core/types';
import type { CompletionItem, CompletionList } from 'vscode-languageserver-protocol';
import { LSP_CONSTANTS } from '../constants.js';
import { humanToLSP } from '../position.js';
import { supportsCompletion } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { pathToUri } from '../utils/uri.js';
import {
  readDocumentContent,
  requireServer,
  resolveInputPath,
  stringifyToolError,
  type ToolDeps,
} from './shared.js';

interface CompletionInput {
  path: string;
  line: number;
  character: number;
  content?: string | undefined;
  limit?: number | undefined;
  trigger_character?: string | undefined;
  format?: 'text' | 'json' | undefined;
}

export function createCompletionTool(deps: ToolDeps): Tool<CompletionInput, string> {
  return {
    name: 'lsp_completion',
    description: 'Get semantic code completions from a configured language server.',
    usageHint:
      'Use for context-aware completion at a cursor location. Lines and columns are 1-based; pass trigger_character for member access like ".".',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        line: { type: 'integer' },
        character: { type: 'integer' },
        content: { type: 'string', maxLength: 500_000 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        trigger_character: { type: 'string' },
        format: { type: 'string', enum: ['text', 'json'] },
      },
      required: ['path', 'line', 'character'],
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: LSP_CONSTANTS.TOOL_TIMEOUT_MS,
    maxOutputBytes: 32_768,
    async execute(input, ctx, opts) {
      try {
        const signal = opts?.signal ?? ctx?.signal;
        const file = resolveInputPath(input.path, ctx);
        const server = await requireServer(deps.registry, file, signal);
        if (server.capabilities && !supportsCompletion(server.capabilities)) {
          throw new LSPError(
            LSPErrorCode.CapabilityMissing,
            `Server "${server.name}" does not support completion`,
          );
        }
        const content =
          typeof input.content === 'string'
            ? input.content
            : await readDocumentContent(file, deps.tracker);
        await deps.tracker.open(file, content);
        const position = humanToLSP(content, { line: input.line, character: input.character });
        const result = await server.completion(
          {
            textDocument: { uri: pathToUri(file) },
            position,
            context: input.trigger_character
              ? { triggerKind: 2, triggerCharacter: input.trigger_character }
              : { triggerKind: 1 },
          },
          LSP_CONSTANTS.TOOL_TIMEOUT_MS,
          signal,
        );
        const items = collectCompletionItems(result, Math.min(input.limit ?? 25, 100));
        if (input.format === 'json') {
          return JSON.stringify({
            items: items.map((item) => ({
              label: item.label,
              insertText: item.insertText ?? item.label,
              kind: item.kind ? completionKindName(item.kind) : undefined,
              detail: compact(item.detail),
              documentation: compact(documentationText(item.documentation)),
            })),
          });
        }
        return formatCompletionItems(items, result);
      } catch (err) {
        return stringifyToolError(err);
      }
    },
  };
}

function collectCompletionItems(
  result: CompletionItem[] | CompletionList | null,
  limit: number,
): CompletionItem[] {
  const items = Array.isArray(result) ? result : (result?.items ?? []);
  return items.slice(0, limit);
}

function formatCompletionItems(
  visibleItems: CompletionItem[],
  result: CompletionItem[] | CompletionList | null,
): string {
  const items = Array.isArray(result) ? result : (result?.items ?? []);
  if (items.length === 0) return 'No completions found.';
  const lines = visibleItems.map((item, index) => {
    const label = item.label || item.insertText || '(unnamed)';
    const kind = item.kind ? completionKindName(item.kind) : 'Completion';
    const detail = compact(item.detail);
    const docs = compact(documentationText(item.documentation));
    const suffix = [detail, docs].filter(Boolean).join(' — ');
    return `${index + 1}. ${label} [${kind}]${suffix ? ` — ${suffix}` : ''}`;
  });
  if (items.length > visibleItems.length) {
    lines.push(`... truncated ${items.length - visibleItems.length} more`);
  }
  return lines.join('\n');
}

function documentationText(value: CompletionItem['documentation']): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return value.value;
}

function compact(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length <= 160 ? cleaned : `${cleaned.slice(0, 157)}...`;
}

function completionKindName(kind: number): string {
  const names: Record<number, string> = {
    1: 'Text',
    2: 'Method',
    3: 'Function',
    4: 'Constructor',
    5: 'Field',
    6: 'Variable',
    7: 'Class',
    8: 'Interface',
    9: 'Module',
    10: 'Property',
    11: 'Unit',
    12: 'Value',
    13: 'Enum',
    14: 'Keyword',
    15: 'Snippet',
    16: 'Color',
    17: 'File',
    18: 'Reference',
    19: 'Folder',
    20: 'EnumMember',
    21: 'Constant',
    22: 'Struct',
    23: 'Event',
    24: 'Operator',
    25: 'TypeParameter',
  };
  return names[kind] ?? `Kind ${kind}`;
}

/**
 * Package-private coverage seam for the pure completion formatting helpers.
 * This is intentionally not re-exported from the package barrel.
 */
export const completionCoverage = {
  collectCompletionItems,
  formatCompletionItems,
  documentationText,
  compact,
  completionKindName,
};
