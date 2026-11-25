import { describe, expect, it } from 'vitest';
import { createTokenPreview, TOKEN_PREVIEW_MAX_CHARS } from '../src/token-previews.js';

describe('createTokenPreview non-finite limit guards', () => {
  it('falls back to default char/line caps when maxChars or maxLines is NaN', () => {
    const long = 'a'.repeat(20_000);
    const res = createTokenPreview(long, Number.NaN, Number.NaN);
    expect(res.length).toBeLessThanOrEqual(TOKEN_PREVIEW_MAX_CHARS);
  });
});
