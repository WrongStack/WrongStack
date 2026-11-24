import { expect, it } from 'vitest';
import { resolveContinuation } from '../../src/core/continue-intent.js';

it('keeps continuation labels Unicode-well-formed', () => {
  const label = resolveContinuation({ suggestions: [`${'a'.repeat(70)}😀tail`] }).label;
  expect(
    [...label].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)),
  ).toBe(false);
});
