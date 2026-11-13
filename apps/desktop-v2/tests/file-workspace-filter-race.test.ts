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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
});
