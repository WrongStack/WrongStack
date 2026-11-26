/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberPlainEditor } from '../src/CodeEditorSlot.js';

/** The real draft storage calls the Tauri host, absent in jsdom; keep drafts in memory. */
const storedDrafts = new Map<string, { revision: number; value: unknown }>();

vi.mock('../src/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform.js')>();
  return {
    ...actual,
    request: async (method: string) => {
      if (method === 'file-drafts.list') return { drafts: [] };
      return {};
    },
    fileDraftStorage: () => ({
      get: async (key: string) => storedDrafts.get(key) ?? { revision: 0, value: null },
      save: async (key: string, value: unknown) => {
        const revision = (storedDrafts.get(key)?.revision ?? 0) + 1;
        storedDrafts.set(key, { revision, value });
        return revision;
      },
    }),
  };
});

// Plain .ts with createElement: the desktop-v2 default config only collects *.test.ts.
const { FileWorkspace } = await import('../src/FileWorkspace.js');

const TREE = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }],
  },
];

const makeCommand = () => async (type: string) => {
  if (type === 'files.tree') return { tree: TREE };
  if (type === 'git.changes') return {};
  if (type === 'files.read') return { content: 'hello\nworld', binary: false };
  return {};
};

const state = { connected: true, sessionId: 'sess-collapse', messages: [], results: {} };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  }
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')?.get) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 400,
    });
  }
  // The plain editor renders synchronously in jsdom; the code editor needs Monaco workers.
  rememberPlainEditor(true);
  storedDrafts.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  rememberPlainEditor(false);
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

async function renderWorkspace(scopeKey: string, projectId: string) {
  await act(async () => {
    root!.render(
      createElement(FileWorkspace, {
        scopeKey,
        projectId,
        command: makeCommand() as never,
        send: async () => {},
        state: state as never,
      }),
    );
  });
  await new Promise((r) => setTimeout(r, 20));
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await new Promise((r) => setTimeout(r, 15));
}

function required<T extends Element>(selector: string): T {
  const element = container!.querySelector<T>(selector);
  expect(element, `missing element: ${selector}`).toBeTruthy();
  return element!;
}

/** Opens `src/a.ts`, enters edit mode, and types a dirty draft into the plain editor. */
async function openDirtyEditor(): Promise<HTMLTextAreaElement> {
  await click(required<HTMLButtonElement>('[data-tree-path="src"]'));
  await click(required<HTMLButtonElement>('[data-tree-path="src/a.ts"]'));
  await new Promise((r) => setTimeout(r, 20));
  await click(required<HTMLButtonElement>('.file-document-toolbar button[aria-pressed="false"]'));
  const textarea = required<HTMLTextAreaElement>('textarea.file-code-editor');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, 'hello\nworld edited');
  await act(async () => {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return textarea;
}

describe('FileWorkspace collapsible file tree', () => {
  it('collapses without unmounting the editor or losing the dirty draft, and reopens', async () => {
    await renderWorkspace('/collapse-open', 'p-collapse-open');
    const textarea = await openDirtyEditor();
    const body = required<HTMLElement>('.file-workspace-body');
    const aside = required<HTMLElement>('aside.file-navigation');
    expect(body.classList.contains('tree-collapsed')).toBe(false);
    const collapseButton = required<HTMLButtonElement>(
      'aside.file-navigation button[aria-expanded="true"]',
    );
    expect(collapseButton.getAttribute('aria-controls')).toBe(aside.id);

    await click(collapseButton);

    expect(body.classList.contains('tree-collapsed')).toBe(true);
    // The tree aside and the editor stay mounted; only the CSS hides the tree.
    expect(container!.querySelector('aside.file-navigation')).toBe(aside);
    expect(textarea.isConnected).toBe(true);
    expect(textarea.value).toBe('hello\nworld edited');
    expect(required<Element>('.file-open-tabs .file-unsaved-dot')).toBeTruthy();
    // A labelled reopen control points at the same tree panel.
    const reopen = required<HTMLButtonElement>('.file-tree-rail button');
    expect(reopen.textContent!.trim().length).toBeGreaterThan(0);
    expect(reopen.getAttribute('aria-expanded')).toBe('false');
    expect(reopen.getAttribute('aria-controls')).toBe(aside.id);
    expect(document.activeElement).toBe(reopen);

    await click(reopen);

    expect(body.classList.contains('tree-collapsed')).toBe(false);
    expect(container!.querySelector('.file-tree-rail')).toBeNull();
    expect(textarea.isConnected).toBe(true);
    expect(textarea.value).toBe('hello\nworld edited');
    expect(required<Element>('.file-open-tabs .file-unsaved-dot')).toBeTruthy();
    const collapseAgain = required<HTMLButtonElement>(
      'aside.file-navigation button[aria-expanded="true"]',
    );
    expect(document.activeElement).toBe(collapseAgain);
  });

  it('restores the collapsed tree when the workspace remounts in the same scope', async () => {
    await renderWorkspace('/collapse-restore', 'p-collapse-restore');
    const body = required<HTMLElement>('.file-workspace-body');
    // Isolation guard: this scope starts expanded, so the later pass proves persistence.
    expect(body.classList.contains('tree-collapsed')).toBe(false);
    await click(required<HTMLButtonElement>('aside.file-navigation button[aria-expanded="true"]'));
    expect(body.classList.contains('tree-collapsed')).toBe(true);

    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container!);
    await renderWorkspace('/collapse-restore', 'p-collapse-restore');

    expect(required<HTMLElement>('.file-workspace-body').classList.contains('tree-collapsed')).toBe(
      true,
    );
    expect(required<HTMLButtonElement>('.file-tree-rail button')).toBeTruthy();
  });
});
