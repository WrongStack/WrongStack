import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { createTestState } from './helpers/create-test-state.js';

describe('Agent swarm panel field 40 cycle', () => {
  function openSettingsField40() {
    let s = createTestState();
    s = { ...s, settingsPicker: { ...s.settingsPicker, open: true } };
    s = reducer(s, { type: 'settingsFieldMove', delta: 40 - s.settingsPicker.field });
    return s;
  }

  it('cycles forward: bottom → sidebar → off → bottom', () => {
    let s = openSettingsField40();
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('bottom');

    s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('sidebar');

    s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('off');

    s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('bottom');
  });

  it('cycles backward: bottom → off → sidebar → bottom', () => {
    let s = openSettingsField40();
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('bottom');

    s = reducer(s, { type: 'settingsValueChange', delta: -1 });
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('off');

    s = reducer(s, { type: 'settingsValueChange', delta: -1 });
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('sidebar');

    s = reducer(s, { type: 'settingsValueChange', delta: -1 });
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('bottom');
  });

  it('resets to bottom via resetSettingsFieldValue', () => {
    let s = openSettingsField40();
    // Move to off
    s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('off');
    // Reset via settingsValueSet
    s = reducer(s, { type: 'settingsValueSet', patch: { showAgentSwarmPanel: 'bottom' } });
    expect(s.settingsPicker.showAgentSwarmPanel).toBe('bottom');
  });
});
