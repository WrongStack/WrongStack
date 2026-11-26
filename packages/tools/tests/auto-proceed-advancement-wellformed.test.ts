import { describe, expect, it } from 'vitest';
import { generateAdvancementPrompt } from '../src/auto-proceed-loop-guard.js';

const ROCKET = '\u{1F680}';
const todo = (content: string) => ({ id: 't1', content, status: 'in_progress' });

/**
 * F2654: one advancement preamble embeds the stalled todo label via
 * `content.slice(0, 72)`. The prompt is auto-fed as the next turn, so a split
 * astral character reaches the provider wire.
 */
describe('advancement prompt keeps valid UTF-16 (F2654)', () => {
  it('drops the orphaned half in the stalled label', () => {
    const out = generateAdvancementPrompt(todo(`${'t'.repeat(71)}${ROCKET}tail`), null, 2, [
      todo('x'),
    ]);

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('t'.repeat(71));
  });

  it('keeps a short label unchanged (control)', () => {
    const out = generateAdvancementPrompt(todo('plain todo'), null, 2, [todo('plain todo')]);

    expect(out).toContain('plain todo');
  });
});
