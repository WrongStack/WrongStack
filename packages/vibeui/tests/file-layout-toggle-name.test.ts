// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBrowser } from '../src/components/file-browser';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const controller = {
  state: {
    id: 'session-1',
    cwd: '/demo',
    fileTree: [],
    treeLoaded: true,
    treeLoading: false,
    treeError: '',
    preview: null,
  },
  connection: 'open',
  loadFileTree: () => {},
  openArtifact: () => {},
  closeArtifact: () => {},
  referenceFile: () => {},
  notice: () => {},
} as never;

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('file layout toggle name (ARIA 4.1.2)', () => {
  it('keeps the accessible name stable while aria-pressed changes', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(createElement(FileBrowser, { controller, onReference: () => {} }));
    });

    const toggle = host.querySelector<HTMLButtonElement>(
      '.file-layout-actions button[aria-pressed]',
    );
    expect(toggle, 'layout toggle renders').not.toBeNull();
    expect(toggle!.disabled, 'toggle is enabled').toBe(false);
    expect(toggle!.getAttribute('aria-pressed'), 'cards view starts pressed').toBe('true');
    const initialName = toggle!.getAttribute('aria-label') ?? toggle!.textContent?.trim() ?? '';
    expect(initialName).toBe('Show file cards');

    await act(async () => toggle!.click());
    expect(toggle!.getAttribute('aria-pressed'), 'toggling changes the state').toBe('false');
    const nextName = toggle!.getAttribute('aria-label') ?? toggle!.textContent?.trim() ?? '';
    expect(nextName).toBe(initialName);
  });
});
