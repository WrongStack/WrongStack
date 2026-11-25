import { describe, expect, it } from 'vitest';
import { validateMemoryAnchors } from '../src/memory-input-validation.js';

describe('validateMemoryAnchors non-string field handling', () => {
  it('throws structured validation errors instead of TypeError for non-string anchor fields', () => {
    for (const anchor of [
      { type: 'file', path: 123 },
      { type: 'command', command: ['ls'] },
      { type: 'agent', role: 42 },
      { type: 'symbol', path: 'src/a.ts', symbol: {} },
    ]) {
      try {
        validateMemoryAnchors([anchor as never]);
        expect.unreachable('expected validation error');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(TypeError);
      }
    }
  });
});
