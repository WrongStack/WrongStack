// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { surfaceI18n } from '../src/surface-i18n';

// Only the failed leaf is injected; the shell, controller and navigation are real.
vi.mock('../src/WrongStackSettings', () => ({
  WrongStackSettings: () => {
    throw new Error('Test-owned settings render failure');
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;

describe('workspace render recovery', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await surfaceI18n.changeLanguage('en');
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps navigation and can leave a failed workspace without reloading', async () => {
    const uncaught = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      root = createRoot(host, { onUncaughtError: uncaught });
      root.render(createElement(App));
    });
    expect(host.querySelector('.app-shell')).not.toBeNull();
    const settings = host.querySelector<HTMLButtonElement>(
      'button[aria-label="WrongStack settings"]',
    );
    expect(settings).not.toBeNull();
    await act(async () => {
      settings!.click();
      await import('../src/WrongStackSettings');
    });
    expect(host.querySelector('.app-shell')).not.toBeNull();
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
    expect(uncaught).not.toHaveBeenCalled();

    const home = [...host.querySelectorAll<HTMLButtonElement>('main button')].find(
      (button) => button.textContent === 'Mission control',
    );
    expect(home).toBeDefined();
    await act(async () => home!.click());
    expect(host.querySelector('main [role="alert"]')).toBeNull();
    await act(async () => settings!.click());
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();

    const projects = host.querySelector<HTMLButtonElement>('button[aria-label="Projects"]');
    await act(async () => projects!.click());
    expect(host.querySelector('.projects-grid')).not.toBeNull();
    expect(host.querySelector('main [role="alert"]')).toBeNull();
  });
});
