import { describe, expect, it } from 'vitest';
import { capSkillBody, compactTrigger } from '../../src/core/system-prompt-skill-text.js';
import { SKILL_LIMITS } from '../../src/skills/limits.js';
import { normalizeSkillRequest } from '../../src/skills/suggest/local.js';

const hasLoneSurrogate = (value: string): boolean =>
  [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character));

describe('skill text Unicode boundaries', () => {
  it('keeps normalized routing requests well-formed', () => {
    expect(hasLoneSurrogate(normalizeSkillRequest(`${'a'.repeat(16383)}😀tail`))).toBe(false);
  });

  it('keeps capped skill bodies well-formed', () => {
    const body = `${'a'.repeat(SKILL_LIMITS.MAX_SKILL_BODY_CHARS - 2)}😀tail`;
    expect(hasLoneSurrogate(capSkillBody(body))).toBe(false);
  });

  it('keeps compact trigger labels well-formed', () => {
    expect(hasLoneSurrogate(compactTrigger(`${'a'.repeat(67)}😀tail`))).toBe(false);
  });
});
