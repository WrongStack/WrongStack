import { expect, it } from 'vitest';
import { enforceFoldSummaryTokenCap } from '../../src/storage/session-tree-fold.js';

it('does not split an astral character at the fold-summary cap', () => {
  const marker = '\n[...truncated to branchFoldMaxTokens budget]';
  const prefixLength = enforceFoldSummaryTokenCap('a'.repeat(200), 32).indexOf(marker);
  const result = enforceFoldSummaryTokenCap(
    `${'a'.repeat(prefixLength - 1)}😀${'b'.repeat(200)}`,
    32,
  );
  expect(
    [...result].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)),
  ).toBe(false);
});
