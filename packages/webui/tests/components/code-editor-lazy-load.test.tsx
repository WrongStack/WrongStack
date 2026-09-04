import { describe, expect, it, vi } from 'vitest';

/**
 * M5 verification: the CodeEditor component (and its heavy monaco-editor
 * dependency) is code-split via React.lazy in the view registry (B-17), so
 * importing ViewRouter does NOT eagerly pull in the monaco-editor bundle.
 *
 * The lazy registration moved from `ViewRouter.tsx` into
 * `view-registry.ts` (B-17), but the contract this test pins is unchanged:
 * the chunk is gated behind a `React.lazy()` factory and does NOT run at
 * module-evaluation time. The lazy factory still lives inside the registry
 * — pointed at the same `./CodeEditor` path.
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
    // Importing ViewRouter goes through view-registry.ts, which holds
    // `const CodeEditor = lazy(() => import('./CodeEditor'))` (B-17). The
    // lazy factory must NOT be called during module evaluation.
    await import('../../src/components/ViewRouter');

    // At this point, neither CodeEditor nor monaco-editor should be loaded.
    expect(codeEditorLoaded).toBe(false);
    expect(monacoLoaded).toBe(false);
  });

  it('React.lazy factory is registered for CodeEditor in the view registry', async () => {
    // Verify the registry source contains the lazy import path. Was
    // `ViewRouter.tsx` before B-17; the contract is identical, the source
    // file is now where the lazy registration is centralised.
    const registrySource = await import('../../src/components/view-registry?raw');
    expect(registrySource.default).toContain("import('./CodeEditor')");
  });
});
