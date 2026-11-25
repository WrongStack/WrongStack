import { expect, it } from 'vitest';
import { buildAutomationResult } from '../src/automation/result.js';

it('keeps capped automation final text Unicode-well-formed', () => {
  const result = buildAutomationResult(
    JSON.stringify({ status: 'done', finalText: `${'a'.repeat(16383)}😀tail` }),
    null,
    1,
  );
  expect(
    [...(result.finalText ?? '')].some(
      (character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character),
    ),
  ).toBe(false);
});
