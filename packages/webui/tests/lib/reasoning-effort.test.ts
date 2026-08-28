import { describe, expect, it } from 'vitest';
import {
  ALL_EFFORTS,
  EFFORT_LABEL_KEYS,
  effortNotAdvertised,
  isEffort,
  resolveEffortOptions,
} from '../../src/lib/reasoning-effort';

/**
 * The effort vocabulary is consumed by three surfaces (Settings → Agent,
 * Settings → Model, the QuickModelSwitcher modal). These tests pin the
 * shared narrowing rules that keep every dropdown in step with what the
 * runtime resolver will actually forward.
 */
describe('reasoning-effort helper', () => {
  it('offers the full canonical set when the model documents no levels', () => {
    expect(resolveEffortOptions(undefined, 'medium')).toEqual([...ALL_EFFORTS]);
    expect(resolveEffortOptions([], 'medium')).toEqual([...ALL_EFFORTS]);
  });

  it('narrows to the model-documented levels', () => {
    expect(resolveEffortOptions(['low', 'high', 'max'], 'high')).toEqual(['low', 'high', 'max']);
  });

  it('appends a persisted effort the model no longer advertises (desync guard)', () => {
    const options = resolveEffortOptions(['low', 'high', 'max'], 'medium');
    expect(options).toEqual(['low', 'high', 'max', 'medium']);
  });

  it('filters non-canonical server values out of the options', () => {
    expect(resolveEffortOptions(['weird', 'low'], 'low')).toEqual(['low']);
  });

  it('keeps every canonical level label-keyed', () => {
    for (const level of ALL_EFFORTS) {
      expect(EFFORT_LABEL_KEYS[level]).toMatch(/^settings:agent\.reasoningEffort/);
    }
    expect(isEffort('xhigh')).toBe(true);
    expect(isEffort('ultra')).toBe(false);
  });

  it('only claims "not advertised" when a non-empty documented list excludes the value', () => {
    expect(effortNotAdvertised(['low', 'high', 'max'], 'medium')).toBe(true);
    // Undocumented vocabulary: the resolver forwards, so the UI must not
    // claim the value is wrong.
    expect(effortNotAdvertised(undefined, 'medium')).toBe(false);
    expect(effortNotAdvertised([], 'medium')).toBe(false);
    expect(effortNotAdvertised(['low', 'high', 'max'], 'low')).toBe(false);
  });
});
