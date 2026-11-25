import { describe, expect, it } from 'vitest';
import { hexToOklab } from '../src/execution/design-dna-color.js';

describe('hexToOklab strict hex parsing', () => {
  it('accepts #rrggbb and #rrggbb/alpha but rejects trailing non-alpha garbage', () => {
    expect(hexToOklab('#ff0000')).not.toBeNull();
    expect(hexToOklab('#ff0000/0.5')).not.toBeNull();
    expect(hexToOklab('#ff0000garbage')).toBeNull();
    expect(hexToOklab('#12345678')).toBeNull();
  });
});
