import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Mode } from '@wrongstack/core/types';
import { Text } from '../src/ink.js';
import {
  buildModePickerOptions,
  useModePicker,
  type GetModesResult,
} from '../src/hooks/use-mode-picker.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockModes: Mode[] = [
  { id: 'chat', name: 'Chat', description: 'Chat mode', prompt: '' },
  { id: 'agent', name: 'Agent', description: 'Agent mode', prompt: '' },
];

describe('buildModePickerOptions', () => {
  it('maps modes to options and marks active id', () => {
    const result: GetModesResult = { modes: mockModes, activeId: 'chat' };
    const options = buildModePickerOptions(result);
    expect(options).toHaveLength(2);
    // Check what the actual output structure looks like
    expect(options[0]!.id).toBe('chat');
    expect(options[1]!.id).toBe('agent');
    // The active one should be marked - check for any truthy "active" or "isActive" property
    const first = options[0]!;
    const activeProp = Object.keys(first).find((k) => k.toLowerCase().includes('active'));
    expect(activeProp).toBeTruthy();
    expect((first as unknown as Record<string, unknown>)[activeProp!]).toBeTruthy();
  });

  it('handles null activeId', () => {
    const result: GetModesResult = { modes: mockModes, activeId: null };
    const options = buildModePickerOptions(result);
    expect(options.every((o) => !o.isActive)).toBe(true);
  });

  it('handles empty modes array', () => {
    const result: GetModesResult = { modes: [] as never as never, activeId: null };
    expect(buildModePickerOptions(result)).toEqual([]);
  });
});

describe('useModePicker', () => {
  it('openModePicker does nothing when getModes is undefined', async () => {
    const dispatch = vi.fn();

    let capturedOpen: (() => Promise<void>) | null = null;
    function Harness(): React.ReactElement {
      const { openModePicker } = useModePicker({ dispatch });
      capturedOpen = openModePicker;
      return React.createElement(Text, null, 'test');
    }

    render(React.createElement(Harness));
    await capturedOpen!();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('openModePicker dispatches modePickerOpen', async () => {
    const dispatch = vi.fn();
    const getModes = vi.fn(async () => ({ modes: mockModes, activeId: 'agent' }));

    let capturedOpen: (() => Promise<void>) | null = null;
    function Harness(): React.ReactElement {
      const { openModePicker } = useModePicker({ dispatch, getModes });
      capturedOpen = openModePicker;
      return React.createElement(Text, null, 'test');
    }

    render(React.createElement(Harness));
    await capturedOpen!();
    expect(getModes).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalled();
    const callArg = dispatch.mock.calls[0]?.[0];
    expect(callArg.type).toBe('modePickerOpen');
    expect(callArg.modes).toBeDefined();
    expect(Array.isArray(callArg.modes)).toBe(true);
  });
});
