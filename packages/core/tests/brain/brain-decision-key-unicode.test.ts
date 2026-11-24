import { expect, it } from 'vitest';
import { brainDecisionKey } from '../../src/brain/brain-ledger.js';

it('keeps capped Brain decision keys Unicode-well-formed', () => {
  const key = brainDecisionKey('source', `${'a'.repeat(99)}😀tail`);
  expect(
    [...key].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)),
  ).toBe(false);
});
