import Editor, { loader, type OnMount } from '@monaco-editor/react';
import {
  COMPLETION_CACHE_TTL_MS,
  COMPLETION_LANGUAGES,
  COMPLETION_TIMEOUT_MS,
  getLanguage,
} from '@wrongstack/project-surfaces/lib/completion';
import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import {
  type CompletionSuggestion,
  completionRequest,
  completionSuggestions,
} from './code-completion';
import type { EngineCommand } from './engine-operations';

// The bundled Monaco, never a CDN copy: the desktop's content policy only allows its own scripts.
loader.config({ monaco });

interface CompletionSource {
  path: string;
  command: EngineCommand;
}

/** Each open editor model's file and engine, by model URI. */
const sources = new Map<string, () => CompletionSource>();
const cache = new Map<string, { expiresAt: number; items: CompletionSuggestion[] }>();
const CACHE_LIMIT = 200;
let registered = false;

const KINDS: Record<string, monaco.languages.CompletionItemKind> = {
  method: monaco.languages.CompletionItemKind.Method,
  function: monaco.languages.CompletionItemKind.Function,
  constructor: monaco.languages.CompletionItemKind.Constructor,
  field: monaco.languages.CompletionItemKind.Field,
  variable: monaco.languages.CompletionItemKind.Variable,
  class: monaco.languages.CompletionItemKind.Class,
  interface: monaco.languages.CompletionItemKind.Interface,
  module: monaco.languages.CompletionItemKind.Module,
  property: monaco.languages.CompletionItemKind.Property,
  unit: monaco.languages.CompletionItemKind.Unit,
  value: monaco.languages.CompletionItemKind.Value,
  enum: monaco.languages.CompletionItemKind.Enum,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  snippet: monaco.languages.CompletionItemKind.Snippet,
  file: monaco.languages.CompletionItemKind.File,
  reference: monaco.languages.CompletionItemKind.Reference,
};

function remember(key: string, items: CompletionSuggestion[]) {
  const now = Date.now();
  if (cache.size >= CACHE_LIMIT)
    for (const [entry, value] of cache) if (value.expiresAt <= now) cache.delete(entry);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, { expiresAt: now + COMPLETION_CACHE_TTL_MS, items });
}

/** Asks the conversation's engine for completions, as the WebUI editor does. */
async function complete(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  context: monaco.languages.CompletionContext,
  token: monaco.CancellationToken,
): Promise<monaco.languages.CompletionList> {
  const source = sources.get(model.uri.toString())?.();
  if (!source) return { suggestions: [] };
  const request = completionRequest({
    filePath: source.path,
    language: model.getLanguageId(),
    text: model.getValue(),
    offset: model.getOffsetAt(position),
    lineNumber: position.lineNumber,
    column: position.column,
    linePrefix: model
      .getLineContent(position.lineNumber)
      .slice(0, Math.max(0, position.column - 1)),
    version: model.getVersionId(),
    triggerCharacter: context.triggerCharacter,
    triggerKind: context.triggerKind,
  });
  if (!request) return { suggestions: [] };
  let items = cache.get(request.cacheKey);
  if (!items || items.expiresAt <= Date.now()) {
    const reply = await Promise.race([
      source.command('completion.request', request.payload, ['completion.result'], {
        timeoutMs: COMPLETION_TIMEOUT_MS,
      }),
      new Promise<null>((resolve) => token.onCancellationRequested(() => resolve(null))),
    ]).catch(() => null);
    if (!reply) return { suggestions: [] };
    remember(request.cacheKey, completionSuggestions(reply));
    items = cache.get(request.cacheKey);
  }
  const word = model.getWordUntilPosition(position);
  const range = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: position.column,
  };
  return {
    suggestions: (items?.items ?? []).map((item, index) => {
      const detail = item.detail ?? (item.source ? `WrongStack ${item.source}` : undefined);
      return {
        label: item.label,
        kind: KINDS[item.kind ?? ''] ?? monaco.languages.CompletionItemKind.Text,
        insertText: item.insertText,
        ...(detail ? { detail } : {}),
        ...(item.documentation ? { documentation: item.documentation } : {}),
        sortText: item.sortText ?? `${String(index).padStart(3, '0')}-${item.label}`,
        range,
        ...(item.kind === 'snippet'
          ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
          : {}),
      };
    }),
  };
}

function registerCompletions() {
  if (registered) return;
  registered = true;
  for (const language of COMPLETION_LANGUAGES)
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', '_'],
      provideCompletionItems: complete,
    });
}

const themeOf = (root: HTMLElement) => {
  const dark = root.dataset['mode'] === 'dark';
  if (root.dataset['contrast'] === 'more') return dark ? 'hc-black' : 'hc-light';
  return dark ? 'vs-dark' : 'vs';
};

/** Follows the desktop's light, dark and contrast choice. */
function useEditorTheme(): string {
  const [theme, setTheme] = useState(() => themeOf(document.documentElement));
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(themeOf(root)));
    observer.observe(root, { attributes: true, attributeFilter: ['data-mode', 'data-contrast'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * The language-aware file editor: Monaco with the language of the file's extension, the
 * engine's completions, and the selection kept on the holder (`data-editor-selection`, start and
 * end offsets) so the file's Reference and Quote actions read it like the plain editor's.
 */
export default function MonacoFileEditor({
  path,
  value,
  label,
  command,
  onChange,
}: {
  path: string;
  value: string;
  label: string;
  command: EngineCommand;
  onChange: (value: string) => void;
}) {
  const theme = useEditorTheme();
  const holder = useRef<HTMLDivElement>(null);
  const latest = useRef<CompletionSource>({ path, command });
  latest.current = { path, command };
  const bound = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const uri of bound.current) sources.delete(uri);
    },
    [],
  );
  const mount: OnMount = (editor) => {
    registerCompletions();
    const bind = () => {
      const uri = editor.getModel()?.uri.toString();
      if (!uri) return;
      sources.set(uri, () => latest.current);
      bound.current.push(uri);
    };
    bind();
    editor.onDidChangeModel(bind);
    editor.onDidChangeCursorSelection(() => {
      const model = editor.getModel();
      const selection = editor.getSelection();
      if (!model || !selection || !holder.current) return;
      holder.current.dataset['editorSelection'] =
        `${model.getOffsetAt(selection.getStartPosition())}:${model.getOffsetAt(selection.getEndPosition())}`;
    });
  };
  return (
    <div ref={holder} className="file-monaco-editor" data-editor-selection="0:0">
      <Editor
        path={path}
        language={getLanguage(path)}
        value={value}
        theme={theme}
        onChange={(text) => {
          if (text !== undefined) onChange(text);
        }}
        onMount={mount}
        options={{
          ariaLabel: label,
          automaticLayout: true,
          fontSize: 13,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
        }}
      />
    </div>
  );
}
