import { describe, expect, it, vi } from 'vitest';

/**
 * M5 verification: the CodeEditor component (and its heavy monaco-editor
 * dependency) is code-split via React.lazy in ViewRouter.tsx, so importing
 * ViewRouter does NOT eagerly pull in the monaco-editor bundle.
 */

// Track whether the CodeEditor module was evaluated.
let codeEditorLoaded = false;
let monacoLoaded = false;

vi.mock('monaco-editor', () => {
  monacoLoaded = true;
  return {
    editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
    KeyMod: { CtrlCmd: 1, Shift: 2 },
    KeyCode: { KeyL: 1 },
    languages: {
      CompletionItemKind: { Text: 1 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: vi.fn(),
    },
    IRange: {},
    IDisposable: {},
  };
});

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  loader: { config: vi.fn() },
}));

vi.mock('../../src/components/CodeEditor', () => {
  codeEditorLoaded = true;
  return { CodeEditor: () => null };
});

vi.mock('../../src/components/monaco-theme', () => ({
  getMonacoTheme: () => 'wrongstack-dark',
}));

describe('CodeEditor lazy loading (M5)', () => {
  it('ViewRouter does not eagerly import CodeEditor or monaco-editor', async () => {
    // Import ViewRouter — this evaluates the module, which contains
    // `const CodeEditor = lazy(() => import('./CodeEditor'))`. The lazy
    // factory should NOT be called during module evaluation.
    await import('../../src/components/ViewRouter');

    // At this point, neither CodeEditor nor monaco-editor should be loaded.
    expect(codeEditorLoaded).toBe(false);
    expect(monacoLoaded).toBe(false);
  });

  it('React.lazy factory is registered for CodeEditor in ViewRouter', async () => {
    // Verify the ViewRouter source contains the lazy import path.
    const viewRouterSource = await import('../../src/components/ViewRouter?raw');
    expect(viewRouterSource.default).toContain("import('./CodeEditor')");
  });
});
