// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { AppearanceSettings } from '../src/AppearanceSettings';
import { accentThemes, defaultAppearance } from '../src/appearance';
import type { DesktopController } from '../src/useDesktop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/useEngine', () => ({
  useProfileEngine: () => ({ state: { connected: false, results: {} }, command: vi.fn() }),
}));

describe('the colour palette choice', () => {
  it('names each palette and marks only the chosen one', async () => {
    const chosen = accentThemes[1]!;
    const vm = {
      appearance: { ...defaultAppearance, accent: chosen.id },
      changeAppearance: vi.fn(),
      reportError: vi.fn(),
      connected: true,
    } as unknown as DesktopController;
    const host = document.createElement('div');
    await act(async () => createRoot(host).render(createElement(AppearanceSettings, { vm })));
    const labels = [...host.querySelectorAll('.theme-choices .theme-label')];
    expect(labels.map((label) => label.querySelector('strong')?.textContent)).toEqual(
      accentThemes.map((theme) => theme.name),
    );
    expect(host.textContent).not.toContain('theme.name');
    const checked = labels.filter((label) => label.querySelector('svg'));
    expect(checked.map((label) => label.querySelector('strong')?.textContent)).toEqual([
      chosen.name,
    ]);
  });
});
