import { describe, expect, it } from 'vitest';
import { type HqEventLogPreset, hqEventLogPresetFields } from '../src/persistence/event-log.js';

describe('hqEventLogPresetFields prototype key guard', () => {
  it('rejects Object.prototype keys like toString and constructor', () => {
    expect(hqEventLogPresetFields('vps8').maxBytes).toBe(8 * 1024 * 1024);
    expect(() => hqEventLogPresetFields('toString' as HqEventLogPreset)).toThrow(
      /Unknown HqEventLogPreset/,
    );
    expect(() => hqEventLogPresetFields('constructor' as HqEventLogPreset)).toThrow(
      /Unknown HqEventLogPreset/,
    );
  });
});
