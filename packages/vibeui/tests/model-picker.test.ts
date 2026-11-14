// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../src/components/model-picker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

function mount() {
  const onChoose = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(ModelPicker, {
        models: {
          account: [
            { id: 'first', name: 'First model', contextWindow: 128000 },
            { id: 'second', name: 'Second model', contextWindow: 4096 },
          ],
        },
        providers: [],
        provider: 'account',
        model: 'first',
        locked: false,
        pending: false,
        onChoose,
        onSettings: vi.fn(),
        onRefresh: vi.fn(),
      }),
    ),
  );
  return onChoose;
}
function shortcut() {
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}
const search = () => document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
function key(value: string, isComposing = false) {
  act(() =>
    search().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: value,
        isComposing,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

describe('model picker keyboard behavior', () => {
  it('keeps IME confirmation from switching the model', () => {
    const choose = mount();
    shortcut();
    key('Enter', true);
    expect(choose).not.toHaveBeenCalled();
    expect(search()).not.toBeNull();
    key('ArrowDown');
    key('Enter');
    expect(choose).toHaveBeenCalledWith('account', 'second', 4096);
  });
  it('leaves the highlighted option unchanged while composing', () => {
    mount();
    shortcut();
    const active = search().getAttribute('aria-activedescendant');
    key('ArrowDown', true);
    expect(search().getAttribute('aria-activedescendant')).toBe(active);
  });
  it('starts a fresh search when reopened with Ctrl+K', () => {
    mount();
    shortcut();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search(),
        'missing',
      );
      search().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(search().value).toBe('missing');
    shortcut();
    expect(search()).toBeNull();
    shortcut();
    expect(search().value).toBe('');
  });
});
