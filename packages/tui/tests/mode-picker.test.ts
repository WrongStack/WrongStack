import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import type { Mode } from '@wrongstack/core';
import { ModePicker, toModeOptions } from '../src/components/mode-picker.js';
import { createPanelOpenDispatcher } from '../src/on-panel-open.js';

describe('ModePicker', () => {
  it('maps core modes to display options and marks the active mode', () => {
    const modes: Mode[] = [
      { id: 'default', name: 'Default', description: 'Balanced default mode', tags: ['balanced'] },
      { id: 'review-lite', name: 'Review Lite', description: 'Narrow review', tags: ['lite'] },
      { id: 'code-reviewer', name: 'Review Deep', description: 'Full review', tags: ['deep'] },
    ];

    const options = toModeOptions(modes, 'review-lite');
    expect(options).toEqual([
      {
        id: 'default',
        name: 'Default',
        description: 'Balanced default mode',
        family: 'balanced',
        isActive: false,
      },
      {
        id: 'review-lite',
        name: 'Review Lite',
        description: 'Narrow review',
        family: 'lite',
        isActive: true,
      },
      {
        id: 'code-reviewer',
        name: 'Review Deep',
        description: 'Full review',
        family: 'deep',
        isActive: false,
      },
    ]);
  });

  it('renders available modes, help text, and active marker', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ModePicker, {
        modes: [
          {
            id: 'default',
            name: 'Default',
            description: 'Balanced default mode',
            family: 'balanced',
            isActive: false,
          },
          {
            id: 'review-lite',
            name: 'Review Lite',
            description: 'Review-oriented mode',
            family: 'lite',
            isActive: true,
          },
        ],
        selected: 1,
        hint: 'Enter switches to the selected mode',
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Mode Selection');
    expect(frame).toContain('2 modes');
    expect(frame).toContain('Current: Review Lite');
    expect(frame).toContain('↑/↓ navigate · Enter select · Esc cancel');
    expect(frame).toContain('Default');
    expect(frame).toContain('Review Lite');
    expect(frame).toContain('[base]');
    expect(frame).toContain('[lite]');
    expect(frame).toContain('● active');
    expect(frame).toContain('Enter switches to the selected mode');

    unmount();
  });

  it('renders the empty state when no modes are available', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ModePicker, {
        modes: [],
        selected: 0,
      }),
    );

    expect(lastFrame() ?? '').toContain('No modes available.');
    unmount();
  });
});

describe('mode-picker panel bridge', () => {
  it('delegates modePickerOpen to the async opener and returns true', async () => {
    const dispatch = vi.fn();
    const openProjectPicker = vi.fn();
    const openStatuslinePicker = vi.fn();
    const openModePicker = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createPanelOpenDispatcher({
      dispatch,
      openProjectPicker,
      openStatuslinePicker,
      openModePicker,
    });

    expect(dispatcher('modePickerOpen')).toBe(true);
    expect(openModePicker).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('returns false for modePickerOpen when no opener is wired', () => {
    const dispatcher = createPanelOpenDispatcher({
      dispatch: vi.fn(),
      openProjectPicker: vi.fn(),
      openStatuslinePicker: vi.fn(),
    });

    expect(dispatcher('modePickerOpen')).toBe(false);
  });
});
