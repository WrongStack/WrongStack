import { describe, expect, it } from 'vitest';
import { catalogProviderIdFor } from '../src/capabilities.js';

describe('catalogProviderIdFor prototype safety', () => {
  it('does not leak Object.prototype properties for inherited providerId or type names', () => {
    expect(catalogProviderIdFor('toString')).toBe('toString');
    expect(catalogProviderIdFor('x', 'constructor')).toBe('constructor');
    expect(catalogProviderIdFor('ai-gateway')).toBe('vercel');
  });
});
