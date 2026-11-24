import { expect, it } from 'vitest';
import { authoredText } from '../src/types/live-context.js';

it('fails closed for a non-finite authored block count', () => {
  expect(
    authoredText({
      content: [
        { type: 'text', text: 'user' },
        { type: 'text', text: 'host-added live context' },
      ],
      authoredLength: Number.POSITIVE_INFINITY,
    }),
  ).toBe('');
});
