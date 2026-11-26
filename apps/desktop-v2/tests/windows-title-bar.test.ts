// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowsTitleBar } from '../src/WindowsTitleBar';

const bridge = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  current: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: bridge.isTauri }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: bridge.current }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('provides caption controls on Windows and restores native decorations on unmount', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT');
  const unlisten = vi.fn();
  const windowApi = {
    setDecorations: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    isFocused: vi.fn(async () => true),
    onResized: vi.fn(async () => unlisten),
    onFocusChanged: vi.fn(async () => unlisten),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  bridge.current.mockReturnValue(windowApi);
  const container = document.createElement('div');
  const root = createRoot(container);
  const onActiveChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(StrictMode, null, createElement(WindowsTitleBar, { onActiveChange })),
      ),
    );
    expect(onActiveChange).toHaveBeenCalledWith(true);
    expect(windowApi.setDecorations.mock.calls).toEqual([[false]]);
    for (const [name, action] of [
      ['Minimize', windowApi.minimize],
      ['Maximize', windowApi.toggleMaximize],
      ['Close', windowApi.close],
    ] as const) {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
      expect(button).not.toBeNull();
      await act(async () => button?.click());
      expect(action).toHaveBeenCalledOnce();
    }
  } finally {
    await act(async () => root.unmount());
  }
  expect(windowApi.setDecorations.mock.calls).toEqual([[false], [true]]);
  expect(unlisten).toHaveBeenCalledTimes(2);
});

it('keeps the native caption when Windows window metadata is unavailable', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT');
  bridge.current.mockImplementation(() => {
    throw new Error('No window metadata');
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const onActiveChange = vi.fn();
  try {
    await act(async () => root.render(createElement(WindowsTitleBar, { onActiveChange })));
    expect(container.childElementCount).toBe(0);
    expect(onActiveChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
