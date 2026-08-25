import { describe, expect, it } from 'vitest';
import {
  effectiveShowSidebar,
  resolveAppSidebarLayout,
  resolveShowSidebarVisibility,
} from '../src/app-ui-state.js';
import { createTestState } from './helpers/create-test-state.js';
import type { Settings } from '../src/app-settings-type.js';
import { reduceSettingsValues } from '../src/reducers/settings-values.js';
import type { Action } from '../src/app-action-type.js';

// `reduceSettingsValues` narrows to the settings-value slice of `Action`;
// the extract keeps these fixtures assignable without re-exporting the
// reducer-local `SettingsValueAction` type.
type SettingsValueSetAction = Extract<Action, { type: 'settingsValueSet' }>;

const baseSettings = {
  showSidebar: true,
} as Pick<Settings, 'showSidebar'> as Settings;

describe('resolveShowSidebarVisibility', () => {
  it('picker draft wins while the settings picker is open', () => {
    expect(resolveShowSidebarVisibility(true, false, true)).toBe(false);
    expect(resolveShowSidebarVisibility(true, true, false)).toBe(true);
  });

  it('persisted value wins when the picker is closed', () => {
    expect(resolveShowSidebarVisibility(false, true, false)).toBe(false);
    expect(resolveShowSidebarVisibility(false, false, true)).toBe(true);
  });

  it('defaults to visible when nothing was persisted', () => {
    expect(resolveShowSidebarVisibility(false, true, undefined)).toBe(true);
    expect(resolveShowSidebarVisibility(false, false, undefined)).toBe(true);
  });
});

describe('resolveAppSidebarLayout sidebar gating', () => {
  it('collapses the sidebar to width 0 when liveSettings.showSidebar is false', () => {
    const state = createTestState();
    const layout = resolveAppSidebarLayout(state, 120, { ...baseSettings, showSidebar: false }, false);
    expect(layout.sidebarWidth).toBe(0);
    expect(layout.mainColumnWidth).toBe(120);
  });

  it('keeps the sidebar when liveSettings.showSidebar is true', () => {
    const state = createTestState();
    const layout = resolveAppSidebarLayout(state, 120, { ...baseSettings, showSidebar: true }, false);
    expect(layout.sidebarWidth).toBeGreaterThan(0);
  });

  it('defaults to visible when liveSettings is undefined (legacy boot)', () => {
    const state = createTestState();
    const layout = resolveAppSidebarLayout(state, 120, undefined, false);
    expect(layout.sidebarWidth).toBeGreaterThan(0);
  });

  it('picker draft (settings open) collapses the sidebar even when persisted true', () => {
    const state = createTestState({
      settingsPicker: {
        ...createTestState().settingsPicker,
        open: true,
        showSidebar: false,
      },
    });
    const layout = resolveAppSidebarLayout(state, 120, { ...baseSettings, showSidebar: true }, false);
    expect(layout.sidebarWidth).toBe(0);
  });

  it('effectiveShowSidebar mirrors the dual-source read', () => {
    const open = createTestState({
      settingsPicker: { ...createTestState().settingsPicker, open: true, showSidebar: false },
    });
    expect(effectiveShowSidebar(open, baseSettings)).toBe(false);
    const closed = createTestState();
    expect(effectiveShowSidebar(closed, { ...baseSettings, showSidebar: false })).toBe(false);
    expect(effectiveShowSidebar(closed, undefined)).toBe(true);
  });
});

describe('settingsValueSet applies the /lite and /full layout patch', () => {
  it('/lite patch sets statuslineMode minimum + showSidebar false', () => {
    const state = createTestState();
    const next = reduceSettingsValues(state, {
      type: 'settingsValueSet',
      patch: { statuslineMode: 'minimum', showSidebar: false },
    } as SettingsValueSetAction);
    expect(next.settingsPicker.statuslineMode).toBe('minimum');
    expect(next.settingsPicker.showSidebar).toBe(false);
  });

  it('/full patch sets statuslineMode detailed + showSidebar true', () => {
    const state = createTestState();
    const next = reduceSettingsValues(state, {
      type: 'settingsValueSet',
      patch: { statuslineMode: 'detailed', showSidebar: true },
    } as SettingsValueSetAction);
    expect(next.settingsPicker.statuslineMode).toBe('detailed');
    expect(next.settingsPicker.showSidebar).toBe(true);
  });

  it('layout patch preserves unrelated picker state (swarm mode, panel positions)', () => {
    const base = createTestState();
    const next = reduceSettingsValues(base, {
      type: 'settingsValueSet',
      patch: { statuslineMode: 'minimum', showSidebar: false },
    } as SettingsValueSetAction);
    expect(next.settingsPicker.showAgentSwarmPanel).toBe(base.settingsPicker.showAgentSwarmPanel);
    expect(next.settingsPicker.panelPositions).toEqual(base.settingsPicker.panelPositions);
    expect(next.settingsPicker.thinkingWord).toBe(base.settingsPicker.thinkingWord);
  });
});
