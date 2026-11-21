// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import type { DesktopController } from '../src/useDesktop';
import { WrongStackSettings } from '../src/WrongStackSettings';

const { command, send } = vi.hoisted(() => ({ command: vi.fn(), send: vi.fn() }));
vi.mock('../src/useEngine', () => ({
  useProfileEngine: () => ({
    command,
    send,
    state: { ...emptyEngineState, connected: true, needsSetup: true },
  }),
}));
vi.mock('../src/RuntimeGate', () => ({
  RuntimeGate: ({ children }: React.PropsWithChildren) => children,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps the active section available when a search has no matches and can clear the search', async () => {
  command.mockImplementation(async () => ({}));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <WrongStackSettings vm={{ reportError: vi.fn() } as unknown as DesktopController} />,
      ),
    );
    const nav = host.querySelector('nav')!;
    const search = nav.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        '  @@no settings@@  ',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(nav.querySelector('[role="status"]')?.textContent).toContain('No settings found');
    expect(nav.querySelector('select')?.value).toBe('setup');
    expect(nav.querySelectorAll('nav > button')).toHaveLength(0);
    await act(async () =>
      nav.querySelector<HTMLButtonElement>('[aria-label="Clear settings search"]')?.click(),
    );
    expect(search.value).toBe('');
    expect(document.activeElement).toBe(search);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Quick setup');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
