import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainEditorPreferred, rememberPlainEditor } from '../src/CodeEditorSlot';
import { completionRequest, completionSuggestions } from '../src/code-completion';
import { selectionReference } from '../src/file-selection-reference';

const point = (linePrefix: string, extra: Record<string, unknown> = {}) => ({
  filePath: 'src/a.ts',
  language: 'typescript',
  text: `const value = 1;\n${linePrefix}\nafter();`,
  offset: 17 + linePrefix.length,
  lineNumber: 2,
  column: linePrefix.length + 1,
  linePrefix,
  version: 4,
  ...extra,
});

describe('code editor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the engine for completions as the WebUI editor does', () => {
    // A short word with no trigger character is not worth a request.
    expect(completionRequest(point('va'))).toBeNull();
    const dotted = completionRequest(point('value.', { triggerCharacter: '.', triggerKind: 1 }));
    expect(dotted?.payload).toEqual({
      filePath: 'src/a.ts',
      language: 'typescript',
      lineNumber: 2,
      column: 7,
      content: 'const value = 1;\nvalue.\nafter();',
      prefix: 'const value = 1;\nvalue.',
      suffix: '\nafter();',
      triggerCharacter: '.',
      triggerKind: 1,
      allowLlm: true,
    });
    const typed = completionRequest(point('useSta'));
    expect(typed?.payload).toMatchObject({ allowLlm: true });
    expect(typed?.payload).not.toHaveProperty('triggerCharacter');
    // The cache key changes with the document version.
    expect(completionRequest(point('useSta', { version: 5 }))?.cacheKey).not.toBe(typed?.cacheKey);
  });

  it('keeps only usable suggestions from a completion reply', () => {
    expect(completionSuggestions(null)).toEqual([]);
    expect(
      completionSuggestions({
        items: [
          { label: 'map', insertText: 'map', kind: 'method', source: 'index' },
          { label: '', insertText: 'x' },
          { label: 'noText' },
          'junk',
        ],
      }),
    ).toEqual([
      {
        label: 'map',
        insertText: 'map',
        kind: 'method',
        detail: undefined,
        documentation: undefined,
        sortText: undefined,
        source: 'index',
      },
    ]);
  });

  it('remembers the plain text editor choice, and works without storage', () => {
    expect(plainEditorPreferred()).toBe(false);
    expect(rememberPlainEditor(true)).toBe(true);
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    expect(plainEditorPreferred()).toBe(false);
    rememberPlainEditor(true);
    expect(plainEditorPreferred()).toBe(true);
    rememberPlainEditor(false);
    expect(plainEditorPreferred()).toBe(false);
  });

  it('quotes the code editor selection kept on its holder', () => {
    const saved = 'alpha\nbeta\ngamma';
    const root = {
      querySelector: (selector: string) =>
        selector.includes('data-editor-selection')
          ? { dataset: { editorSelection: '10:6' } }
          : null,
    } as unknown as HTMLElement;
    expect(
      selectionReference('a.ts', { content: saved, saved, editing: true }, root, true),
    ).toEqual({ reference: { path: 'a.ts', lines: [2, 2], snippet: 'beta' } });
  });
});
