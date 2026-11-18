// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/platform', () => ({
  native: false,
  request: vi.fn(async () => ({ drafts: [], revision: 0, value: null })),
  fileDraftStorage: vi.fn(() => ({
    get: async () => ({ revision: 0, value: null }),
    save: async () => 1,
  })),
  projectFormDraftStorage: vi.fn(() => ({
    get: async () => ({ revision: 0, value: null }),
    save: async () => 1,
  })),
}));

import { emptyEngineState } from '../src/engine-state';
import { FileWorkspace } from '../src/FileWorkspace';
import { InputRequestCard } from '../src/InputRequestCard';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('InputRequestCard partial draft defaults and FileWorkspace filter race (F174, F175)', () => {
  let host: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(async () => {
    await surfaceI18n.changeLanguage('en');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '');
      };
    }
    if (!HTMLDialogElement.prototype.close) {
      HTMLDialogElement.prototype.close = function () {
        this.removeAttribute('open');
      };
    }
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
  });

  it('submits visibly checked recommended answers alongside partial draft edits (F174)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await act(async () => {
      root = createRoot(host);
      root.render(
        createElement(InputRequestCard, {
          request: {
            id: 'req-partial',
            title: 'Setup',
            tabs: [
              {
                id: 't1',
                label: 'General',
                questions: [
                  { id: 'q1', prompt: 'Name', kind: 'text', required: true },
                  {
                    id: 'q2',
                    prompt: 'Runtime',
                    kind: 'single_select',
                    required: true,
                    options: [
                      { id: 'bun', label: 'Bun' },
                      { id: 'node', label: 'Node' },
                    ],
                    recommendedOptionIds: ['bun'],
                  },
                ],
              },
            ],
          },
          draft: { q1: { selectedOptionIds: [], text: 'WrongStack', delegated: false } },
          onChange: () => {},
          send: async (_type, payload) => {
            if (!payload) throw new Error('Expected clarify answer payload');
            sent.push(payload);
          },
          connected: true,
        }),
      );
    });
    await act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!['response']).toMatchObject({
      requestId: 'req-partial',
      status: 'submitted',
      answers: [
        { questionId: 'q1', text: 'WrongStack', usedRecommendation: false },
        { questionId: 'q2', selectedOptionIds: ['bun'], usedRecommendation: true },
      ],
    });
  });

  it('ignores superseded filter replies and invalidates sibling filter caches after local file creation (F175)', async () => {
    const dVisible = deferred<Record<string, unknown>>();
    const dAll = deferred<Record<string, unknown>>();
    await act(async () => {
      root = createRoot(host);
      root.render(
        createElement(FileWorkspace, {
          projectId: 'proj-f175-race',
          scopeKey: 'D:/f175-race',
          state: { ...emptyEngineState, results: { 'files.tree.changed': { seq: 1 } } },
          send: async () => {},
          command: async (type, payload) => {
            if (type === 'files.tree') {
              return payload?.['includeIgnored'] ? dAll.promise : dVisible.promise;
            }
            return { files: [] };
          },
        }),
      );
    });

    const toggle = host.querySelector<HTMLButtonElement>(
      '.file-workspace-toolbar button[aria-pressed]',
    )!;
    await act(async () => {
      toggle.click();
    });
    await act(async () => {
      dAll.resolve({
        tree: [
          { name: '.env', path: '.env', type: 'file' },
          { name: 'index.ts', path: 'index.ts', type: 'file' },
        ],
      });
      await dAll.promise;
    });
    await act(async () => {
      dVisible.resolve({ tree: [{ name: 'index.ts', path: 'index.ts', type: 'file' }] });
      await dVisible.promise;
    });
    expect(host.querySelector('.file-navigation')?.textContent).toContain('.env');
  });

  it('shows the cached explorer as soon as the user switches back to it', async () => {
    const ignoredListing = deferred<Record<string, unknown>>();
    const visibleTree = [{ name: 'index.ts', path: 'index.ts', type: 'file' }];
    const command = vi.fn(async (type: string, payload?: Record<string, unknown>) => {
      if (type !== 'files.tree') return { files: [] };
      return payload?.['includeIgnored'] ? ignoredListing.promise : { tree: visibleTree };
    });
    await act(async () => {
      root = createRoot(host);
      root.render(
        createElement(FileWorkspace, {
          projectId: 'proj-filter-cache-return',
          scopeKey: 'D:/filter-cache-return',
          state: emptyEngineState,
          send: async () => {},
          command,
        }),
      );
    });

    const navigation = host.querySelector('.file-navigation')!;
    const toggle = host.querySelector<HTMLButtonElement>(
      '.file-workspace-toolbar button[aria-pressed]',
    )!;
    expect(navigation.textContent).toContain('index.ts');
    await act(async () => toggle.click());
    expect(navigation.querySelector('.spin')).not.toBeNull();
    await act(async () => toggle.click());

    expect(command.mock.calls.filter(([type]) => type === 'files.tree')).toHaveLength(2);
    expect(navigation.textContent).toContain('index.ts');
    expect(navigation.querySelector('.spin')).toBeNull();

    await act(async () =>
      ignoredListing.resolve({
        tree: [...visibleTree, { name: 'ignored.txt', path: 'ignored.txt', type: 'file' }],
      }),
    );
    expect(navigation.textContent).not.toContain('ignored.txt');
  });

  it('keeps the reading indicator for a reopened pending file', async () => {
    const first = deferred<Record<string, unknown>>();
    const second = deferred<Record<string, unknown>>();
    const command = vi.fn(async (type: string, payload?: Record<string, unknown>) => {
      if (type === 'files.tree')
        return {
          tree: ['first.txt', 'second.txt'].map((path) => ({ name: path, path, type: 'file' })),
        };
      if (type === 'files.read')
        return payload?.['filePath'] === 'first.txt' ? first.promise : second.promise;
      return { files: [] };
    });
    await act(async () => {
      root = createRoot(host);
      root.render(
        createElement(FileWorkspace, {
          projectId: 'proj-pending-file-return',
          scopeKey: 'D:/pending-file-return',
          state: emptyEngineState,
          send: async () => {},
          command,
        }),
      );
    });

    const selectFile = (path: string) =>
      act(async () => host.querySelector<HTMLButtonElement>(`[data-tree-path="${path}"]`)!.click());
    const currentFile = () => host.querySelector('.file-document');
    await selectFile('first.txt');
    expect(currentFile()?.textContent).toContain('Reading first.txt');
    await selectFile('second.txt');
    expect(currentFile()?.textContent).toContain('Reading second.txt');
    await selectFile('first.txt');
    expect(command.mock.calls.filter(([type]) => type === 'files.read')).toHaveLength(2);
    expect(currentFile()?.textContent).toContain('Reading first.txt');

    await act(async () => second.resolve({ content: 'Second file contents' }));
    expect(currentFile()?.textContent).toContain('Reading first.txt');
    await act(async () => first.resolve({ content: 'First file contents' }));
    expect(currentFile()?.textContent).toContain('First file contents');
    expect(currentFile()?.querySelector('.spin')).toBeNull();
  });

  it('displays read errors only for the file the user is viewing', async () => {
    const pending = deferred<Record<string, unknown>>();
    const command = async (type: string, payload?: Record<string, unknown>) => {
      if (type === 'files.tree')
        return {
          tree: ['missing.txt', 'ready.txt'].map((path) => ({ name: path, path, type: 'file' })),
        };
      if (type === 'files.read')
        return payload?.['filePath'] === 'missing.txt'
          ? pending.promise
          : { content: 'Ready file contents' };
      return { files: [] };
    };
    await act(async () => {
      root = createRoot(host);
      root.render(
        createElement(FileWorkspace, {
          projectId: 'proj-file-read-error',
          scopeKey: 'D:/file-read-error',
          state: emptyEngineState,
          send: async () => {},
          command,
        }),
      );
    });

    const selectFile = (path: string) =>
      act(async () => host.querySelector<HTMLButtonElement>(`[data-tree-path="${path}"]`)!.click());
    const error = () => host.querySelector('.file-workspace-error')?.textContent;
    await selectFile('missing.txt');
    await selectFile('ready.txt');
    expect(host.querySelector('.file-document')?.textContent).toContain('Ready file contents');
    await act(async () => pending.reject(new Error('Missing fixture file')));
    expect(error()).toBeUndefined();

    await selectFile('missing.txt');
    expect(error()).toBe('Missing fixture file');
  });
});
