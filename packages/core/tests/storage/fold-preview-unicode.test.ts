import { expect, it } from 'vitest';
import { buildDeterministicFoldSummary } from '../../src/storage/session-tree-fold.js';

it('keeps deterministic fold previews Unicode-well-formed', () => {
  const summary = buildDeterministicFoldSummary(
    {
      id: 'branch',
      name: 'branch',
      parentBranchId: 'main',
      forkSeq: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
      turnCount: 0,
    },
    [
      {
        type: 'user_input',
        ts: '2026-01-01T00:00:00.000Z',
        content: `${'a'.repeat(198)}😀tail`,
      },
    ],
  );
  expect(
    [...summary].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)),
  ).toBe(false);
});
