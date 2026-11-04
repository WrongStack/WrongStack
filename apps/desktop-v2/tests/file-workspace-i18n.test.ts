// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { FileWorkspace } from '../src/FileWorkspace';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout; the tree view only needs the observer to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// The engine never answers here: the workspace stays on its first, empty view.
const pending = () => new Promise<never>(() => {});

async function mount(mode: 'files' | 'changes', scopeKey: string) {
  const host = document.createElement('div');
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(FileWorkspace, {
        command: vi.fn(pending),
        send: vi.fn(pending),
        state: emptyEngineState,
        scopeKey,
        projectId: 'p1',
        mode,
      }),
    );
  });
  return { host, unmount: () => act(() => root?.unmount()) };
}

describe('the file workspace in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('names its header, search and explorer in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let files = await mount('files', 'D:/i18n-en');
    expect(files.host.querySelector('section')?.getAttribute('aria-label')).toBe(
      'Project file manager',
    );
    expect(files.host.textContent).toContain('Project workspace');
    expect(files.host.textContent).toContain('Search contents');
    expect(files.host.querySelector('input')?.getAttribute('placeholder')).toBe(
      'Find a file or folder…',
    );
    await files.unmount();
    let changes = await mount('changes', 'D:/i18n-en-changes');
    expect(changes.host.textContent).toContain('Changes & review');
    expect(changes.host.textContent).toContain('0 changed files');
    await changes.unmount();

    await surfaceI18n.changeLanguage('tr');
    files = await mount('files', 'D:/i18n-tr');
    expect(files.host.querySelector('section')?.getAttribute('aria-label')).toBe(
      'Proje dosya yöneticisi',
    );
    expect(files.host.textContent).toContain('Proje çalışma alanı');
    expect(files.host.textContent).toContain('İçerikte ara');
    expect(files.host.querySelector('input')?.getAttribute('placeholder')).toBe(
      'Dosya ya da klasör bul…',
    );
    await files.unmount();
    changes = await mount('changes', 'D:/i18n-tr-changes');
    expect(changes.host.textContent).toContain('Değişiklikler ve inceleme');
    expect(changes.host.textContent).toContain('0 değişen dosya');
    await changes.unmount();
  });
});
