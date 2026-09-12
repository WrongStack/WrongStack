// The /model picker's per-model effort strip, at the reducer boundary.
//
// The contract that matters: the choice belongs to the ROW it was made on.
// Every navigation (↑/↓, filter, provider change, back) resets it to the
// `default` sentinel, so a level picked for one model can never be committed
// against another whose catalog may not even document it.

import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import { createInitialState } from '../src/app-initial-state.js';
import type { State } from '../src/app-state.js';
import type { ProviderOption } from '../src/components/model-picker.js';
import { EFFORT_KEEP } from '../src/components/model-picker-effort.js';

const PROVIDERS: ProviderOption[] = [
  {
    id: 'openai',
    family: 'openai',
    models: ['o3', 'gpt-4o'],
    modelDetails: {
      o3: { reasoning: true, effortLevels: ['low', 'medium', 'high'] },
      'gpt-4o': { reasoning: false },
    },
  },
];

function base(): State {
  return createInitialState({
    banner: '',
    appVersion: '0.0.0',
    provider: 'openai',
    model: 'o3',
    cwd: '/tmp',
    family: 'openai',
    restoredEntries: [],
    enhanceEnabled: false,
  });
}

/** Open the picker and walk it to step 2 with `o3` focused. */
function atModelStep(): State {
  let state = reducer(base(), { type: 'modelPickerOpen', providers: PROVIDERS });
  state = reducer(state, {
    type: 'modelPickerPickProvider',
    providerId: 'openai',
    models: ['o3', 'gpt-4o'],
  });
  return state;
}

describe('modelPickerEffort', () => {
  it('starts on the default sentinel', () => {
    expect(atModelStep().modelPicker.effort).toBe(EFFORT_KEEP);
  });

  it('cycles through the focused model documented levels', () => {
    let state = atModelStep();
    state = reducer(state, { type: 'modelPickerEffort', delta: 1 });
    expect(state.modelPicker.effort).toBe('low');
    state = reducer(state, { type: 'modelPickerEffort', delta: 1 });
    expect(state.modelPicker.effort).toBe('medium');
    state = reducer(state, { type: 'modelPickerEffort', delta: -1 });
    expect(state.modelPicker.effort).toBe('low');
  });

  it('is inert on a model that does not reason', () => {
    let state = reducer(atModelStep(), { type: 'modelPickerMove', delta: 1 });
    expect(state.modelPicker.filteredOptions[state.modelPicker.selected]).toBe('gpt-4o');
    state = reducer(state, { type: 'modelPickerEffort', delta: 1 });
    expect(state.modelPicker.effort).toBe(EFFORT_KEEP);
  });

  it('is inert in step 1', () => {
    const state = reducer(reducer(base(), { type: 'modelPickerOpen', providers: PROVIDERS }), {
      type: 'modelPickerEffort',
      delta: 1,
    });
    expect(state.modelPicker.effort).toBe(EFFORT_KEEP);
  });

  it('resets when the cursor moves to another model', () => {
    let state = reducer(atModelStep(), { type: 'modelPickerEffort', delta: 2 });
    expect(state.modelPicker.effort).toBe('medium');
    state = reducer(state, { type: 'modelPickerMove', delta: 1 });
    expect(state.modelPicker.effort).toBe(EFFORT_KEEP);
  });

  it('resets when the filter changes the focused row', () => {
    let state = reducer(atModelStep(), { type: 'modelPickerEffort', delta: 1 });
    state = reducer(state, { type: 'modelPickerSearch', query: 'gpt' });
    expect(state.modelPicker.effort).toBe(EFFORT_KEEP);
  });

  it('resets on Esc back to the provider step', () => {
    let state = reducer(atModelStep(), { type: 'modelPickerEffort', delta: 1 });
    state = reducer(state, { type: 'modelPickerBack' });
    expect(state.modelPicker.effort).toBe(EFFORT_KEEP);
  });

  it("offers no strip for generic 'pick' invocations", () => {
    let state = reducer(base(), {
      type: 'modelPickerOpen',
      providers: PROVIDERS,
      purpose: 'pick',
      title: 'Add council voter',
    });
    state = reducer(state, {
      type: 'modelPickerPickProvider',
      providerId: 'openai',
      models: ['o3'],
    });
    state = reducer(state, { type: 'modelPickerEffort', delta: 1 });
    expect(state.modelPicker.effort).toBe(EFFORT_KEEP);
  });
});
