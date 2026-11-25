import { describe, expect, it } from 'vitest';
import { insertSkillMention } from '../src/skills/mentions.js';

describe('insertSkillMention negative span bounds (F2009)', () => {
  it('clamps negative mention start/end bounds to [0, text.length]', () => {
    const res = insertSkillMention('hello $foo', { start: -1, end: 10, query: 'foo' }, 'bar');
    expect(res).toEqual({ text: '$bar ', cursor: 5 });
  });
});
