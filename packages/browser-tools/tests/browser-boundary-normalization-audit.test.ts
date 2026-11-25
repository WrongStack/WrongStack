import { describe, expect, it } from 'vitest';
import { pushBounded } from '../src/manager-support.js';
import { boundBrowserSelection } from '../src/pick.js';

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

describe('browser boundary normalization audit regressions', () => {
  it('does not split surrogate pairs in bounded page selection text', () => {
    expect(hasLoneSurrogate(boundBrowserSelection({ text: `${'a'.repeat(999)}😀` }).text)).toBe(
      false,
    );
  });

  it('rejects negative element and viewport dimensions', () => {
    const result = boundBrowserSelection({
      bounds: { width: -1, height: -2 },
      viewport: { width: -3, height: -4 },
    });
    expect([
      result.bounds.width,
      result.bounds.height,
      result.viewport.width,
      result.viewport.height,
    ]).toEqual([0, 0, 0, 0]);
  });

  it('treats a non-finite buffer cap as zero', () => {
    const target = [1];
    pushBounded(target, 2, Number.NaN);
    expect(target).toEqual([]);
  });
});
