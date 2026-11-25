import { describe, expect, it } from 'vitest';
import { isOpaqueMediaStringField } from '../src/opaque-media.js';

describe('isOpaqueMediaStringField null parent guard', () => {
  it('returns false without throwing when parent is null or non-object', () => {
    expect(isOpaqueMediaStringField(null as never, 'data', 'AAAA')).toBe(false);
    expect(
      isOpaqueMediaStringField({ type: 'image', media_type: 'image/png' }, 'data', 'AAAA'),
    ).toBe(true);
  });
});
