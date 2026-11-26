import { describe, expect, it } from 'vitest';
import { sageMemorySummary } from '../src/server/memory-summary.js';

const ROCKET = '\u{1F680}';

/**
 * F2642: `sageMemorySummary` builds the 120-unit list-card preview with a plain
 * `.slice(0, 120)`. Memory text is user/model content; splitting an astral
 * character leaves a lone surrogate in the card the WebUI renders.
 */
describe('SAGE memory summary preview keeps valid UTF-16 (F2642)', () => {
  it('drops the orphaned half instead of keeping it', () => {
    const summary = sageMemorySummary({ id: 'm1', text: `${'m'.repeat(119)}${ROCKET}tail` });

    expect(String(summary['preview']).isWellFormed()).toBe(true);
    expect(summary['preview']).toBe('m'.repeat(119));
  });

  it('keeps an emoji that ends exactly at the cap', () => {
    const summary = sageMemorySummary({ id: 'm2', text: `${'m'.repeat(118)}${ROCKET}tail` });

    expect(summary['preview']).toBe(`${'m'.repeat(118)}${ROCKET}`);
  });

  it('keeps short text and whitespace collapsing unchanged (control)', () => {
    expect(sageMemorySummary({ id: 'm3', text: 'short   memory\ntext' })['preview']).toBe(
      'short memory text',
    );
  });
});
