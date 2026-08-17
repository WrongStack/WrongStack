import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  formatContextWindowModeList,
  getContextWindowMode,
  isContextWindowModeId,
  isContextWindowModeSelectionId,
  listContextWindowModes,
  normalizeContextWindowModeId,
  resolveContextWindowPolicy,
} from '../../src/types/context-window.js';

describe('big-window default: balanced swaps to deep on ≥1M windows', () => {
  it('defaults to deep on a 1M-class window', () => {
    const policy = resolveContextWindowPolicy({}, undefined, 1_050_000);
    expect(policy.id).toBe('deep');
    expect(policy.thresholds).toEqual({ warn: 0.72, soft: 0.86, hard: 0.96 });
    expect(policy.preserveK).toBe(18);
    expect(policy.eliseThreshold).toBe(5000);
    expect(policy.targetLoad).toBe(0.82);
  });

  it('swaps an explicit balanced selection on a big window (1M windows exist to be filled)', () => {
    expect(resolveContextWindowPolicy({ mode: 'balanced' }, undefined, 1_000_000).id).toBe('deep');
    expect(resolveContextWindowPolicy({}, 'balanced', 1_000_000).id).toBe('deep');
  });

  it('keeps balanced below the threshold and when the window is unknown', () => {
    expect(resolveContextWindowPolicy({}, undefined, 999_999).id).toBe('balanced');
    expect(resolveContextWindowPolicy({}, undefined, 0).id).toBe('balanced');
    expect(resolveContextWindowPolicy().id).toBe('balanced');
  });

  it('never overrides a deliberate frugal/deep selection', () => {
    expect(resolveContextWindowPolicy({ mode: 'frugal' }, undefined, 1_050_000).id).toBe('frugal');
    expect(resolveContextWindowPolicy({ mode: 'deep' }, undefined, 400_000).id).toBe('deep');
    expect(resolveContextWindowPolicy({}, 'frugal', 1_050_000).id).toBe('frugal');
  });

  it('still applies per-field overrides on the deep base', () => {
    const policy = resolveContextWindowPolicy({ hardThreshold: 0.9 }, undefined, 1_050_000);
    expect(policy.id).toBe('deep');
    expect(policy.thresholds).toEqual({ warn: 0.72, soft: 0.86, hard: 0.9 });
  });

  it('normalizes archival to balanced, then swaps on a big window', () => {
    expect(resolveContextWindowPolicy({ mode: 'archival' }, undefined, 1_050_000).id).toBe('deep');
  });
});

describe('context window modes', () => {
  it('lists only active built-in modes', () => {
    expect(listContextWindowModes().map((m) => m.id)).toEqual(['balanced', 'frugal', 'deep']);
  });

  it('defaults to balanced', () => {
    const policy = resolveContextWindowPolicy();
    expect(DEFAULT_CONTEXT_WINDOW_MODE_ID).toBe('balanced');
    expect(policy.id).toBe('balanced');
    expect(policy.thresholds).toEqual({ warn: 0.55, soft: 0.7, hard: 0.85 });
    expect(policy.preserveK).toBe(8);
    expect(policy.eliseThreshold).toBe(1200);
    expect(policy.targetLoad).toBe(0.65);
  });

  it('resolves balanced mode with config overrides', () => {
    const policy = resolveContextWindowPolicy({
      mode: 'balanced',
      warnThreshold: 0.5,
      softThreshold: 0.7,
      hardThreshold: 0.9,
      preserveK: 12,
      eliseThreshold: 1500,
      targetLoad: 0.6,
    });
    expect(policy.thresholds.warn).toBe(0.5);
    expect(policy.preserveK).toBe(12);
    expect(policy.eliseThreshold).toBe(1500);
    expect(policy.targetLoad).toBe(0.6);
  });

  it('applies config overrides on top of non-default mode presets', () => {
    const policy = resolveContextWindowPolicy({
      mode: 'frugal',
      warnThreshold: 0.9,
      softThreshold: 0.91,
      hardThreshold: 0.92,
      preserveK: 99,
      eliseThreshold: 99999,
      targetLoad: 0.4,
    });
    expect(policy.id).toBe('frugal');
    expect(policy.aggressiveOn).toBe('warn');
    expect(policy.targetLoad).toBe(0.4);
    expect(policy.thresholds).toEqual({ warn: 0.9, soft: 0.91, hard: 0.92 });
    expect(policy.preserveK).toBe(99);
    expect(policy.eliseThreshold).toBe(99999);
  });

  it('keeps non-default preset values when overrides are omitted', () => {
    const policy = resolveContextWindowPolicy({ mode: 'deep' });
    expect(policy.thresholds).toEqual({ warn: 0.72, soft: 0.86, hard: 0.96 });
    expect(policy.preserveK).toBe(18);
    expect(policy.eliseThreshold).toBe(5000);
    expect(policy.targetLoad).toBe(0.82);
  });

  it('normalizes deprecated archival mode to balanced', () => {
    expect(isContextWindowModeId('archival')).toBe(false);
    expect(isContextWindowModeSelectionId('archival')).toBe(true);
    expect(normalizeContextWindowModeId('archival')).toBe('balanced');
    expect(getContextWindowMode('archival')?.id).toBe('balanced');
    expect(resolveContextWindowPolicy({ mode: 'archival' }).id).toBe('balanced');
  });

  it('formats the active mode marker after alias normalization', () => {
    expect(getContextWindowMode('deep')?.name).toBe('Deep');
    expect(formatContextWindowModeList('deep')).toContain('* deep');
    expect(formatContextWindowModeList('archival')).toContain('* balanced');
    expect(formatContextWindowModeList('archival')).not.toContain('archival');
  });
});
