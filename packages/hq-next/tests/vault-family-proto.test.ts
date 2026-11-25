import { describe, expect, it } from 'vitest';
import { familyTitle } from '../src/features/vault/model';

describe('familyTitle prototype safety', () => {
  it('returns Other instead of Object.prototype properties for inherited keys', () => {
    expect(familyTitle('toString')).toBe('Other');
    expect(familyTitle('constructor')).toBe('Other');
    expect(familyTitle('openai')).toBe('OpenAI');
  });
});
