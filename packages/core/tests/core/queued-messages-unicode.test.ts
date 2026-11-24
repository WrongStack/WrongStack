import { expect, it } from 'vitest';
import { peekQueuedMessages, setQueuedMessagesSnapshot } from '../../src/core/queued-messages.js';

it('keeps queued-message previews Unicode-well-formed', () => {
  const ctx = { meta: {} } as never;
  setQueuedMessagesSnapshot(ctx, [`${'a'.repeat(498)}😀tail`]);
  const preview = peekQueuedMessages(ctx)[0] ?? '';
  expect(
    [...preview].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)),
  ).toBe(false);
});
