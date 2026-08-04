/**
 * Focused coverage for services/suggestion-store.ts — the module-level
 * suggestion state shared by /suggest (writer) and /next (reader).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSuggestions,
  getAutoSuggestions,
  getSuggestions,
  removeSuggestions,
  setAutoSuggestions,
  setSuggestions,
} from '../src/services/suggestion-store.js';

beforeEach(() => {
  clearSuggestions();
});

describe('suggestion store', () => {
  it('stores and retrieves suggestions and auto suggestions', () => {
    setSuggestions(['one', 'two']);
    expect(getSuggestions()).toEqual(['one', 'two']);
    setAutoSuggestions(['auto-one']);
    expect(getAutoSuggestions()).toEqual(['auto-one']);
  });

  it('removes suggestions at indices and clears auto suggestions', () => {
    setSuggestions(['a', 'b', 'c']);
    setAutoSuggestions(['auto']);
    removeSuggestions([0, 2]);
    expect(getSuggestions()).toEqual(['b']);
    // An explicit selection clears the auto-submit queue.
    expect(getAutoSuggestions()).toEqual([]);
  });

  it('is a no-op for an empty index list', () => {
    setSuggestions(['a']);
    setAutoSuggestions(['x']);
    removeSuggestions([]);
    expect(getSuggestions()).toEqual(['a']);
    expect(getAutoSuggestions()).toEqual(['x']);
  });

  it('clears both stores', () => {
    setSuggestions(['a']);
    setAutoSuggestions(['x']);
    clearSuggestions();
    expect(getSuggestions()).toEqual([]);
    expect(getAutoSuggestions()).toEqual([]);
  });
});
