import { expect, it } from 'vitest';
import { progressNotification } from '../src/protocol.js';

it('keeps clamped MCP progress text Unicode-well-formed', () => {
  const message = progressNotification({
    progressToken: 'p',
    progress: 1,
    message: `${'a'.repeat(1999)}😀tail`,
  })?.message;
  expect(
    [...(message ?? '')].some(
      (character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character),
    ),
  ).toBe(false);
});
