import { describe, expect, it } from 'vitest';
import { memoryPreview } from '../src/sage/shared.js';
import { previewText } from '../src/sage/vector/model.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('memory previews keep surrogate pairs whole (F1301)', () => {
  for (const [name, preview] of [
    ['memoryPreview', memoryPreview],
    ['previewText', previewText],
  ] as const) {
    it(`${name} drops a pair the cut would split instead of leaving half of it`, () => {
      // The emoji occupies units 8–9; a 10-unit preview keeps 9 units + "…".
      const cut = preview('abcdefgh\u{1F9ED}tail-text-that-overflows', 10);
      expect(LONE_SURROGATE.test(cut)).toBe(false);
      expect(cut).toBe('abcdefgh…');
    });

    it(`${name} keeps a pair that fits and leaves ASCII previews unchanged`, () => {
      expect(preview('abcdefg\u{1F9ED}tail-text-that-overflows', 10)).toBe('abcdefg\u{1F9ED}…');
      expect(preview('abcdefghij'.repeat(3), 10)).toBe('abcdefghi…');
      expect(preview('short')).toBe('short');
    });
  }
});
