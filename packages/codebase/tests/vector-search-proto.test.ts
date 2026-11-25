import { describe, expect, it } from 'vitest';
import { extractSemanticFeatures } from '../src/vector-search.js';

describe('extractSemanticFeatures prototype safety', () => {
  it('does not leak Object.prototype properties for constructor/toString/valueOf tokens', () => {
    const features = extractSemanticFeatures('constructor toString valueOf hasOwnProperty');
    expect(features.every((f) => typeof f.feature === 'string')).toBe(true);
  });
});
