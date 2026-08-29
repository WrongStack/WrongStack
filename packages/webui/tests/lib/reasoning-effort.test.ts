import { describe, expect, it } from 'vitest';
import {
  ALL_EFFORTS,
  AUTO_EFFORT,
  AUTO_EFFORT_LABEL_KEY,
  EFFORT_LABEL_KEYS,
  effortControlHidden,
  effortLabelKey,
  effortNotAdvertised,
  isEffort,
  resolveEffortOptions,
} from '../../src/lib/reasoning-effort';

/**
 * The effort vocabulary is consumed by four surfaces (Settings → Agent,
 * Settings → Model, the QuickModelSwitcher modal, the composer effort
 * select). These tests pin the shared narrowing rules that keep every
 * dropdown in step with what the runtime resolver will actually forward,
 * plus the `auto` sentinel semantics ("follow the general setting").
 */
describe('reasoning-effort helper', () => {
  it('leads with auto and offers the full canonical set when the model documents no levels', () => {
    expect(resolveEffortOptions(undefined, 'medium')).toEqual([AUTO_EFFORT, ...ALL_EFFORTS]);
    expect(resolveEffortOptions([], 'medium')).toEqual([AUTO_EFFORT, ...ALL_EFFORTS]);
  });

  it('leads with auto and narrows to the model-documented levels', () => {
    expect(resolveEffortOptions(['low', 'high', 'max'], 'high')).toEqual([
      AUTO_EFFORT,
      'low',
      'high',
      'max',
    ]);
  });

  it('appends a persisted effort the model no longer advertises (desync guard)', () => {
    const options = resolveEffortOptions(['low', 'high', 'max'], 'medium');
    expect(options).toEqual([AUTO_EFFORT, 'low', 'high', 'max', 'medium']);
  });

  it('filters non-canonical server values out of the options', () => {
    expect(resolveEffortOptions(['weird', 'low'], 'low')).toEqual([AUTO_EFFORT, 'low']);
  });

  it('keeps every canonical level label-keyed', () => {
    for (const level of ALL_EFFORTS) {
      expect(EFFORT_LABEL_KEYS[level]).toMatch(/^settings:agent\.reasoningEffort/);
    }
    expect(isEffort('xhigh')).toBe(true);
    expect(isEffort('ultra')).toBe(false);
  });

  it('labels the auto option through its own key, levels through the pinned record', () => {
    expect(effortLabelKey(AUTO_EFFORT)).toBe(AUTO_EFFORT_LABEL_KEY);
    expect(effortLabelKey('high')).toBe(EFFORT_LABEL_KEYS.high);
  });

  it('only claims "not advertised" when a non-empty documented list excludes the value', () => {
    expect(effortNotAdvertised(['low', 'high', 'max'], 'medium')).toBe(true);
    // Undocumented vocabulary: the resolver forwards, so the UI must not
    // claim the value is wrong.
    expect(effortNotAdvertised(undefined, 'medium')).toBe(false);
    expect(effortNotAdvertised([], 'medium')).toBe(false);
    expect(effortNotAdvertised(['low', 'high', 'max'], 'low')).toBe(false);
    // `auto` is not a level at all — it defers to the general setting, so it
    // can never be "not advertised".
    expect(effortNotAdvertised(['low', 'high', 'max'], AUTO_EFFORT)).toBe(false);
  });

  it('hides the control only for a documented effortSupported=false (tri-state)', () => {
    // `false` = the model documents that it has NO effort control.
    expect(effortControlHidden(false)).toBe(true);
    // `undefined` = vocabulary undocumented → resolver forwards; show it.
    expect(effortControlHidden(undefined)).toBe(false);
    expect(effortControlHidden(true)).toBe(false);
  });
});
