import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ThemePicker } from '../src/components/theme-picker.js';
import { THEME_OPTIONS } from '../src/theme.js';

describe('ThemePicker', () => {
  it('renders the title, controls, active theme, and hint', () => {
    const view = render(
      React.createElement(ThemePicker, {
        options: THEME_OPTIONS,
        selected: 0,
        activeId: 'catppuccin',
        hint: 'Theme saved',
      }),
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('TUI Theme');
    expect(frame).toContain('Enter apply');
    expect(frame).toContain('Catppuccin Mocha');
    expect(frame).toContain('[active]');
    expect(frame).toContain('Theme saved');
    view.unmount();
  });

  it('windows a long theme list around the selected row', () => {
    const view = render(
      React.createElement(ThemePicker, {
        options: THEME_OPTIONS,
        selected: THEME_OPTIONS.length - 1,
        activeId: 'tokyo-night',
      }),
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('more above');
    expect(frame).toContain(THEME_OPTIONS.at(-1)?.name ?? '');
    view.unmount();
  });

  it('renders an empty option list without placeholder artifacts', () => {
    const view = render(
      React.createElement(ThemePicker, {
        options: [],
        selected: 0,
        activeId: 'catppuccin',
      }),
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('TUI Theme');
    expect(frame).not.toContain('undefined');
    view.unmount();
  });
});
