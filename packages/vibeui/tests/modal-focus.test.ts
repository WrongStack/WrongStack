// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../src/components/dialogs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  await act(async () => vi.runOnlyPendingTimersAsync());
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (open: boolean) =>
    act(() =>
      root.render(
        createElement(Modal, {
          open,
          onOpenChange: () => {},
          title: 'Search',
          description: 'Find a message.',
          children: createElement('input', { 'aria-label': 'Query' }),
        }),
      ),
    );
  render(true);
  return async (destination?: HTMLElement) => {
    render(false);
    destination?.focus();
    await act(async () => vi.runOnlyPendingTimersAsync());
  };
}
function message() {
  const input = document.createElement('textarea');
  input.setAttribute('aria-label', 'Message');
  document.body.append(input);
  input.focus();
  return input;
}

describe('modal focus recovery', () => {
  it('returns keyboard focus to the field that opened the dialog', async () => {
    const input = message();
    const close = mount();
    expect(document.activeElement).not.toBe(input);
    await close();
    expect(document.activeElement).toBe(input);
  });
  it('returns to the composer when the opener has disappeared', async () => {
    const input = message();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const close = mount();
    opener.remove();
    await close();
    expect(document.activeElement).toBe(input);
  });
  it('preserves an explicit jump destination after closing a dialog', async () => {
    message();
    const destination = document.createElement('article');
    destination.tabIndex = -1;
    document.body.append(destination);
    const close = mount();
    await close(destination);
    expect(document.activeElement).toBe(destination);
  });
});
