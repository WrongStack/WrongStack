import { describe, expect, it } from 'vitest';
import { detectQuantifiedAmbiguity } from '../src/regex-ambiguity.js';
import { compileUserRegex } from '../src/regex-guard.js';

const escaped = String.raw`\uD83D\uDE00`;
const emoji = String.fromCodePoint(0x1f600);

describe('Unicode surrogate escape pairs', () => {
  it.each(['u', 'v'])('rejects identical escaped/raw alternatives in %s mode', (flags) => {
    expect(new RegExp(`^(?:${escaped})$`, flags).test(emoji)).toBe(true);
    const content = `${escaped}|${emoji}`;
    expect(detectQuantifiedAmbiguity(content, flags).verdict).toBe('ambiguous');
    expect(compileUserRegex(`(?:${content})+$`, flags).ok).toBe(false);
  });

  it.each(['u', 'v'])('applies a quantifier to the whole escaped pair in %s mode', (flags) => {
    expect(new RegExp(`^(?:${escaped}?)$`, flags).test('')).toBe(true);
    expect(detectQuantifiedAmbiguity(`${escaped}?`, flags).verdict).toBe('ambiguous');
  });

  it.each(['u', 'v'])('combines escaped class members and range endpoints in %s mode', (flags) => {
    for (const cls of [`[${escaped}]`, String.raw`[\uD83D\uDE00-\uD83D\uDE01]`]) {
      expect(new RegExp(`^${cls}$`, flags).test(emoji)).toBe(true);
      expect(detectQuantifiedAmbiguity(`${cls}|${emoji}`, flags).verdict).toBe('ambiguous');
    }
  });

  it('retains legacy code-unit quantifiers and class members', () => {
    expect(new RegExp(`^(?:${escaped}?)$`).test('')).toBe(false);
    expect(detectQuantifiedAmbiguity(`${escaped}?`).verdict).toBe('unambiguous');
    expect(new RegExp(`^[${escaped}]$`).test(emoji)).toBe(false);
    expect(detectQuantifiedAmbiguity(`[${escaped}]|${emoji}`).verdict).toBe('ambiguous');
  });

  it('keeps separated, reversed, braced and unpaired surrogates distinct', () => {
    for (const flags of ['u', 'v']) {
      for (const content of [
        String.raw`\uD83D(?:\uDE00)?`,
        String.raw`\uDE00\uD83D?`,
        String.raw`\u{D83D}\u{DE00}?`,
        String.raw`\uD83D\u0041?`,
      ]) {
        expect(new RegExp(`^(?:${content})$`, flags).test('')).toBe(false);
        expect(detectQuantifiedAmbiguity(content, flags).verdict).toBe('unambiguous');
      }
      expect(compileUserRegex('(?:a|b)+$', flags).ok).toBe(true);
      expect(compileUserRegex('(?:a|a)+$', flags).ok).toBe(false);
    }
  });
});
