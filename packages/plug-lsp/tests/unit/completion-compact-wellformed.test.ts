import { describe, expect, it } from 'vitest';
import { completionCoverage } from '../../src/tools/completion.js';

const ROCKET = '\u{1F680}';

/**
 * F2643: `compact()` caps completion documentation at 157 UTF-16 units with a
 * plain `.slice`. The text is the language server's documentation, rendered into
 * the `lsp_completion` tool result the model reads.
 */
describe('completion documentation cap keeps valid UTF-16 (F2643)', () => {
  it('drops the orphaned half instead of keeping it', () => {
    const out = completionCoverage.compact(`${'x'.repeat(156)}${ROCKET}tail`);

    expect(out?.isWellFormed()).toBe(true);
    expect(out).toBe(`${'x'.repeat(156)}...`);
  });

  it('keeps an emoji that ends exactly at the cap', () => {
    const out = completionCoverage.compact(`${'x'.repeat(155)}${ROCKET}tail`);

    expect(out).toBe(`${'x'.repeat(155)}${ROCKET}...`);
  });

  it('keeps short documentation unchanged (control)', () => {
    expect(completionCoverage.compact('  short\n docs  ')).toBe('short docs');
  });
});
