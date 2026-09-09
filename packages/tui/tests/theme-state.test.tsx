import type { Config, ConfigStore } from '@wrongstack/core/types';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useThemeState } from '../src/hooks/use-theme-state.js';
import {
  getActiveThemeName,
  RANDOM_THEME_ROTATION_MS,
  setActiveTheme,
  type ThemeName,
  themePresets,
} from '../src/theme.js';

function ThemeStateHarness({ configStore }: { configStore?: ConfigStore }): React.ReactElement {
  useThemeState({ configStore });
  return React.createElement(React.Fragment);
}

function createConfigStore(themePreset?: ThemeName): {
  store: ConfigStore;
  setThemePreset: (next: ThemeName | undefined) => void;
} {
  let config = { themePreset } as Config;
  const watchers = new Set<(next: Readonly<Config>, previous: Readonly<Config>) => void>();

  const notify = (previous: Config) => {
    for (const watcher of watchers) watcher(config, previous);
  };
  const store: ConfigStore = {
    get: () => config,
    getSection: (key) => config[key] as never,
    getExtension: () => ({}),
    update: (partial) => {
      const previous = config;
      config = { ...config, ...partial } as Config;
      notify(previous);
      return config;
    },
    watch: (callback) => {
      watchers.add(callback);
      return () => watchers.delete(callback);
    },
  };

  return {
    store,
    setThemePreset: (next) => {
      const previous = config;
      config = { ...config, themePreset: next } as Config;
      notify(previous);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setActiveTheme('catppuccin');
});

describe('useThemeState', () => {
  it('chooses a random preset at startup and rotates to a different one every 15 minutes without a saved theme', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    setActiveTheme('catppuccin');
    const config = createConfigStore();
    const view = render(React.createElement(ThemeStateHarness, { configStore: config.store }));

    const initial = getActiveThemeName();
    expect(initial).not.toBe('catppuccin');
    expect(Object.hasOwn(themePresets, initial)).toBe(true);

    vi.advanceTimersByTime(RANDOM_THEME_ROTATION_MS);
    expect(getActiveThemeName()).not.toBe(initial);
    view.unmount();
  });

  it('keeps an explicitly configured theme and stops random rotation after a live selection', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const config = createConfigStore();
    const view = render(React.createElement(ThemeStateHarness, { configStore: config.store }));

    config.setThemePreset('tokyo-night');
    expect(getActiveThemeName()).toBe('tokyo-night');

    vi.advanceTimersByTime(RANDOM_THEME_ROTATION_MS * 2);
    expect(getActiveThemeName()).toBe('tokyo-night');
    view.unmount();
  });

  it('does not start a random timer when a theme is configured at launch', () => {
    vi.useFakeTimers();
    const config = createConfigStore('gruvbox-dark');
    const view = render(React.createElement(ThemeStateHarness, { configStore: config.store }));

    expect(getActiveThemeName()).toBe('gruvbox-dark');
    vi.advanceTimersByTime(RANDOM_THEME_ROTATION_MS * 2);
    expect(getActiveThemeName()).toBe('gruvbox-dark');
    view.unmount();
  });
});
