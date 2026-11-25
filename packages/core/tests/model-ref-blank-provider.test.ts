import { describe, expect, it } from 'vitest';
import { formatModelRef } from '../src/core/model-ref.js';

describe('formatModelRef blank provider fallback', () => {
  it('falls back to defaultProvider when ref.provider is empty or whitespace', () => {
    expect(formatModelRef({ provider: '', model: 'gpt-4o' }, 'openai')).toBe('openai/gpt-4o');
    expect(formatModelRef({ provider: '   ', model: 'gpt-4o' }, 'openai')).toBe('openai/gpt-4o');
    expect(formatModelRef({ provider: '  ', model: 'gpt-4o' })).toBe('gpt-4o');
  });
});
