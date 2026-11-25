import { describe, expect, it } from 'vitest';
import {
  clearSuggestions,
  getSuggestions,
  setSuggestions,
} from '../src/services/suggestion-store.js';

describe('suggestion-store array isolation (F2301)', () => {
  it('clones arrays on set and get so caller mutations cannot corrupt stored suggestions', () => {
    clearSuggestions();
    const input = ['run tests'];
    setSuggestions(input);
    input.push('mutated');
    const read = getSuggestions();
    read.push('mutated2');
    expect(getSuggestions()).toEqual(['run tests']);
    clearSuggestions();
  });
});
