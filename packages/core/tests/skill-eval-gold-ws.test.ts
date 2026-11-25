import { describe, expect, it } from 'vitest';
import { classifyCase, parseEvalJsonl, scoreSuggestions } from '../src/skills/suggest/evaluate.js';

describe('skill suggestion evaluation whitespace gold guard (F2005)', () => {
  it('treats whitespace-only gold labels as uncovered', () => {
    expect(classifyCase({ text: 'hello', gold: '   ' }, undefined)).toBe('correctly-silent');
    const { score } = scoreSuggestions([{ text: 'hello', gold: '   ' }], () => undefined);
    expect(score.covered).toBe(0);
    expect(score.uncovered).toBe(1);
    const parsed = parseEvalJsonl('{"text": "hello", "gold": "   "}');
    expect(parsed.requests[0]?.gold).toBeNull();
  });
});
