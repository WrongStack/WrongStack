import { describe, expect, it } from 'vitest';
import {
  formatContextWindow,
  formatPricePair,
  suggestionProfileName,
} from '../src/components/SettingsPanel/fallback-suggestions';

describe('fallback-suggestions prototype and non-finite guards', () => {
  it('uses Object.hasOwn for profile names and sanitizes non-finite prices/context', () => {
    expect(suggestionProfileName('toString' as never, {})).toBe('toString');
    expect(formatPricePair(Number.NaN, 1)).toBe('? / $1.0');
    expect(formatContextWindow(-1000)).toBe('');
    expect(formatContextWindow(Number.NaN)).toBe('');
  });
});
