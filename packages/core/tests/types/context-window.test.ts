import { describe, expect, it } from 'vitest';
import {
  formatContextWindowModeList,
  getContextWindowMode,
  listContextWindowModes,
  resolveContextWindowPolicy,
} from '../../src/types/context-window.js';

describe('context window modes', () => {
  it('lists built-in modes', () => {
    expect(listContextWindowModes().map((m) => m.id)).toEqual([
      'balanced',
      'frugal',
      'deep',
      'archival',
    ]);
  });

  it('resolves balanced mode with config overrides', () => {
    const policy = resolveContextWindowPolicy({
      mode: 'balanced',
      warnThreshold: 0.5,
      softThreshold: 0.7,
      hardThreshold: 0.9,
      preserveK: 12,
      eliseThreshold: 1500,
    });
    expect(policy.thresholds.warn).toBe(0.5);
    expect(policy.preserveK).toBe(12);
    expect(policy.eliseThreshold).toBe(1500);
  });

  it('applies config overrides on top of non-default mode presets', () => {
    const policy = resolveContextWindowPolicy({
      mode: 'frugal',
      warnThreshold: 0.9,
      softThreshold: 0.91,
      hardThreshold: 0.92,
      preserveK: 99,
      eliseThreshold: 99999,
    });
    expect(policy.id).toBe('frugal');
    expect(policy.aggressiveOn).toBe('warn');
    expect(policy.targetLoad).toBe(0.5);
    expect(policy.thresholds).toEqual({ warn: 0.9, soft: 0.91, hard: 0.92 });
    expect(policy.preserveK).toBe(99);
    expect(policy.eliseThreshold).toBe(99999);
  });

  it('keeps non-default preset values when overrides are omitted', () => {
    const policy = resolveContextWindowPolicy({ mode: 'deep' });
    expect(policy.thresholds).toEqual({ warn: 0.72, soft: 0.86, hard: 0.96 });
    expect(policy.preserveK).toBe(18);
    expect(policy.eliseThreshold).toBe(5000);
  });

  it('formats the active mode marker', () => {
    expect(getContextWindowMode('deep')?.name).toBe('Deep');
    expect(formatContextWindowModeList('deep')).toContain('* deep');
  });
});
