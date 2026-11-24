import { expect, it } from 'vitest';
import { applyContentMode } from '../../src/brain/brain-trace.js';

it('keeps redacted Brain trace text Unicode-well-formed', () => {
  const value = applyContentMode(`${'a'.repeat(118)}😀tail`, 'redacted') ?? '';
  expect(
    [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)),
  ).toBe(false);
});
