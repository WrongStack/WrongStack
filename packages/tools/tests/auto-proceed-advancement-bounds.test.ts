import { describe, expect, it } from 'vitest';
import { generateAdvancementPrompt } from '../src/auto-proceed-loop-guard.js';

describe('generateAdvancementPrompt attemptCount bounds', () => {
  it('handles NaN and fractional attempt counts without crashing', () => {
    expect(generateAdvancementPrompt({ id: '1', content: 'Fix bug' }, null, 1.5, [])).toContain(
      '1 attempt(s)',
    );
    expect(
      generateAdvancementPrompt({ id: '1', content: 'Fix bug' }, null, Number.NaN, []),
    ).toContain('1 attempt(s)');
  });
});
