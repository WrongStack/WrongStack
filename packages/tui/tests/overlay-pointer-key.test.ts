import { describe, expect, it } from 'vitest';
import { EMPTY_KEY, type KeyEvent } from '../src/components/input.js';
import { overlayPointerKey } from '../src/overlay-key-router.js';
import { createTestState } from './helpers/create-test-state.js';

/** termRows=40 / viewportRows=20 → rows 21..40 are the bottom (overlay) region. */
const GEOMETRY = { termRows: 40, viewportRows: 20 };

function mouseKey(button: 'left' | 'right', y = 30): KeyEvent {
  return {
    ...EMPTY_KEY,
    mouse: {
      kind: 'press',
      button,
      x: 12,
      y,
      wheel: 0,
      shift: false,
      meta: false,
      ctrl: false,
      motion: false,
    },
  };
}

describe('overlayPointerKey', () => {
  it('maps left click to Enter only while a selectable overlay is open', () => {
    expect(overlayPointerKey(createTestState(), '', mouseKey('left'), GEOMETRY)).toEqual({
      isEnter: false,
      cancelAction: null,
    });

    const state = createTestState({
      promptPicker: { ...createTestState().promptPicker, open: true },
    });
    expect(overlayPointerKey(state, '', mouseKey('left'), GEOMETRY)).toEqual({
      isEnter: true,
      cancelAction: null,
    });
  });

  it('ignores a left click that lands in the history band above the overlay', () => {
    const state = createTestState({
      projectPicker: { ...createTestState().projectPicker, open: true },
    });
    // y=8 is inside the 20-row history viewport — a stray click while reading
    // scrollback must NOT confirm the focused project (which would respawn).
    expect(overlayPointerKey(state, '', mouseKey('left', 8), GEOMETRY)).toEqual({
      isEnter: false,
      cancelAction: null,
    });
    // Same press in the bottom region does confirm.
    expect(overlayPointerKey(state, '', mouseKey('left', 30), GEOMETRY)).toEqual({
      isEnter: true,
      cancelAction: null,
    });
  });

  it('keeps keyboard Enter working regardless of geometry', () => {
    const state = createTestState({
      promptPicker: { ...createTestState().promptPicker, open: true },
    });
    expect(overlayPointerKey(state, '', { ...EMPTY_KEY, return: true }, GEOMETRY).isEnter).toBe(
      true,
    );
  });

  it.each([
    ['modePicker', { type: 'modePickerClose' }],
    ['promptPicker', { type: 'promptPickerClose' }],
    ['projectPicker', { type: 'projectPickerClose' }],
    ['statuslinePicker', { type: 'statuslineClose' }],
    ['pluginPicker', { type: 'pluginPickerClose' }],
    ['mcpPicker', { type: 'mcpPickerClose' }],
    ['toolsPicker', { type: 'toolsPickerClose' }],
    ['helpPanel', { type: 'helpClose' }],
    ['brainPanel', { type: 'brainClose' }],
    ['shadowPanel', { type: 'shadowClose' }],
    ['fKeyPicker', { type: 'fKeyPickerClose' }],
    ['authPanel', { type: 'authClose' }],
  ] as const)('maps right click on %s to its close action', (field, expected) => {
    const base = createTestState();
    const state = createTestState({
      [field]: { ...base[field], open: true },
    });

    expect(overlayPointerKey(state, '', mouseKey('right'), GEOMETRY)).toEqual({
      isEnter: false,
      cancelAction: expected,
    });
  });

  it('maps right click on the sessions panel to its toggle action', () => {
    const state = createTestState({ sessionsPanelOpen: true });
    expect(overlayPointerKey(state, '', mouseKey('right'), GEOMETRY)).toEqual({
      isEnter: false,
      cancelAction: { type: 'toggleSessionsPanel' },
    });
  });

  it('maps right click in the model list to Back before closing the picker', () => {
    const state = createTestState({
      modelPicker: { ...createTestState().modelPicker, open: true, step: 'model' },
    });

    expect(overlayPointerKey(state, '', mouseKey('right'), GEOMETRY)).toEqual({
      isEnter: false,
      cancelAction: { type: 'modelPickerBack' },
    });
  });
});
