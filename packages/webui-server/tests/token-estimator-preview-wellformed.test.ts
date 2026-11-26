import { describe, expect, it } from 'vitest';
import { messagePreview } from '../src/server/token-estimator.js';

const ROCKET = '\u{1F680}';

/**
 * F2649: `messagePreview` caps a string at 60, a text block at 40 and the joined
 * preview at 60 with plain `.slice`. The preview labels context-breakdown rows
 * the WebUI renders.
 */
describe('token estimator previews keep valid UTF-16 (F2649)', () => {
  it('drops the orphaned half in a string preview', () => {
    const out = messagePreview(`${'s'.repeat(59)}${ROCKET}tail`);

    expect(out.isWellFormed()).toBe(true);
    expect(out).toBe('s'.repeat(59));
  });

  it('drops the orphaned half in a text-block preview', () => {
    const out = messagePreview([{ type: 'text', text: `${'b'.repeat(39)}${ROCKET}tail` }]);

    expect(out.isWellFormed()).toBe(true);
  });

  it('keeps short previews unchanged (control)', () => {
    expect(messagePreview('short preview')).toBe('short preview');
  });
});
