import { describe, expect, it } from 'vitest';
import { formatSuggestionLabel } from '../src/components/status-bar-helpers.js';

describe('formatSuggestionLabel non-finite maxLen guard (F2265)', () => {
  it('falls back to default maxLen when maxLen is NaN or < 1', () => {
    expect(formatSuggestionLabel('Run unit tests', Number.NaN)).toBe('Run unit tests');
  });
});
