import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showPanel = vi.fn();

vi.mock('@/lib/view-navigation', () => ({ showPanel }));
vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@monaco-editor/react', () => ({ default: () => null, loader: { config: vi.fn() } }));
vi.mock('monaco-editor', () => ({
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
  KeyMod: { CtrlCmd: 1, Shift: 2 },
  KeyCode: { KeyL: 1 },
  languages: {
    CompletionItemKind: {},
    CompletionItemInsertTextRule: {},
    registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

const { CodeEditor } = await import('../../src/components/CodeEditor');
const { ThemeProvider } = await import('../../src/components/ThemeProvider');
const { useFileStore } = await import('../../src/stores/file-store');

describe('CodeEditor empty state', () => {
  beforeEach(() => {
    showPanel.mockClear();
    useFileStore.setState({ openFiles: [], activeFilePath: null });
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  it('opens the file explorer when no file is open', async () => {
    await act(async () => {
      render(
        <ThemeProvider defaultTheme="light">
          <CodeEditor />
        </ThemeProvider>,
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'activity:codeEditor.openExplorer' }));
    });

    expect(showPanel).toHaveBeenCalledWith('files');
  });
});
