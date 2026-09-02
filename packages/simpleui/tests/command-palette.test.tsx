// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../src/command-palette.js';
import type { CommandPaletteAction } from '../src/lib/command-palette-model.js';

const roots: Root[] = [];

function renderPalette(
  options: {
    open?: boolean;
    onRun?: (action: CommandPaletteAction) => void;
    context?: Partial<React.ComponentProps<typeof CommandPalette>['context']>;
  } = {},
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onClose = vi.fn();
  const onRun = vi.fn(options.onRun);
  const context = {
    hasSession: true,
    running: false,
    canCompose: true,
    canCompact: true,
    ...options.context,
  };
  act(() =>
    root.render(
      <CommandPalette
        open={options.open ?? true}
        context={context}
        onClose={onClose}
        onRun={onRun}
      />,
    ),
  );
  return { host, onClose, onRun };
}

function key(target: Element, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

function input(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('CommandPalette', () => {
  it('filters commands and runs the selected command with Enter', () => {
    const { host, onClose, onRun } = renderPalette();
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search commands"]');
    expect(search).not.toBeNull();

    act(() => input(search as HTMLInputElement, 'memory'));
    expect(host.textContent).toContain('Search memory');
    expect(host.textContent).not.toContain('New session');

    act(() => key(search as HTMLInputElement, { key: 'Enter' }));
    expect(onRun).toHaveBeenCalledWith('open-memory');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without running a command', () => {
    const { host, onClose, onRun } = renderPalette();
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search commands"]');

    act(() => key(search as HTMLInputElement, { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRun).not.toHaveBeenCalled();
  });

  it('does not run disabled commands', () => {
    const { host, onClose, onRun } = renderPalette({
      context: { hasSession: false, running: true },
    });
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search commands"]');

    act(() => input(search as HTMLInputElement, 'new session'));
    const disabled = host.querySelector<HTMLButtonElement>('.command-palette-item:disabled');
    expect(disabled?.textContent).toContain('New session');

    act(() => key(search as HTMLInputElement, { key: 'Enter' }));
    expect(onRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('supports arrow-key selection', () => {
    const { host, onRun } = renderPalette();
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search commands"]');

    act(() => key(search as HTMLInputElement, { key: 'ArrowDown' }));
    act(() => key(search as HTMLInputElement, { key: 'Enter' }));
    expect(onRun).toHaveBeenCalledWith('focus-composer');
  });

  it('runs the context breakdown command from the search results', () => {
    const { host, onRun, onClose } = renderPalette();
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search commands"]');

    act(() => input(search as HTMLInputElement, 'breakdown'));
    expect(host.textContent).toContain('Context breakdown');
    act(() => key(search as HTMLInputElement, { key: 'Enter' }));
    expect(onRun).toHaveBeenCalledWith('open-context-breakdown');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables the context breakdown command without a session', () => {
    const { host, onRun } = renderPalette({ context: { hasSession: false } });
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search commands"]');

    act(() => input(search as HTMLInputElement, 'breakdown'));
    const item = host.querySelector<HTMLButtonElement>('.command-palette-item:disabled');
    expect(item?.textContent).toContain('Context breakdown');
    act(() => key(search as HTMLInputElement, { key: 'Enter' }));
    expect(onRun).not.toHaveBeenCalled();
  });
});
