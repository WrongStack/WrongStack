import {
  buildCompletionCacheKey,
  COMPLETION_DOCUMENT_CHARS,
  COMPLETION_PREFIX_CHARS,
  COMPLETION_SUFFIX_CHARS,
  currentToken,
  shouldAllowCompletionLlm,
  shouldAskCompletionServer,
} from '@wrongstack/project-surfaces/lib/completion';

/** One suggestion of the engine's `completion.result`. */
export interface CompletionSuggestion {
  label: string;
  insertText: string;
  kind?: string | undefined;
  detail?: string | undefined;
  documentation?: string | undefined;
  sortText?: string | undefined;
  source?: string | undefined;
}

/** Where the caret is in the editor's text, as the completion request reports it. */
export interface CompletionPoint {
  filePath: string;
  language: string;
  text: string;
  offset: number;
  lineNumber: number;
  column: number;
  /** The caret's line up to the caret. */
  linePrefix: string;
  version: number;
  triggerCharacter?: string | undefined;
  triggerKind?: number | undefined;
}

/**
 * The `completion.request` payload for a caret, or null when nothing is worth asking for, as in
 * the WebUI editor: the text around the caret, the whole file while it is small, and whether
 * the engine may ask a model.
 */
export function completionRequest(point: CompletionPoint): {
  payload: Record<string, unknown>;
  cacheKey: string;
} | null {
  const trigger = {
    ...(point.triggerCharacter ? { triggerCharacter: point.triggerCharacter } : {}),
    ...(point.triggerKind === undefined ? {} : { triggerKind: point.triggerKind }),
  };
  const token = currentToken(point.linePrefix);
  if (!shouldAskCompletionServer(trigger, token)) return null;
  const prefix = point.text.slice(
    Math.max(0, point.offset - COMPLETION_PREFIX_CHARS),
    point.offset,
  );
  const suffix = point.text.slice(point.offset, point.offset + COMPLETION_SUFFIX_CHARS);
  return {
    payload: {
      filePath: point.filePath,
      language: point.language,
      lineNumber: point.lineNumber,
      column: point.column,
      ...(point.text.length <= COMPLETION_DOCUMENT_CHARS ? { content: point.text } : {}),
      prefix,
      suffix,
      ...trigger,
      allowLlm: shouldAllowCompletionLlm(trigger, token),
    },
    cacheKey: buildCompletionCacheKey({
      filePath: point.filePath,
      language: point.language,
      lineNumber: point.lineNumber,
      column: point.column,
      versionId: point.version,
      ...(point.triggerCharacter ? { triggerCharacter: point.triggerCharacter } : {}),
      linePrefix: point.linePrefix,
      suffix,
    }),
  };
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** The usable suggestions of a `completion.result` reply. */
export function completionSuggestions(
  reply: Record<string, unknown> | null,
): CompletionSuggestion[] {
  const items = reply?.['items'];
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const label = text(row['label']);
    const insertText = text(row['insertText']);
    if (!label || insertText === undefined) return [];
    return [
      {
        label,
        insertText,
        kind: text(row['kind']),
        detail: text(row['detail']),
        documentation: text(row['documentation']),
        sortText: text(row['sortText']),
        source: text(row['source']),
      },
    ];
  });
}
