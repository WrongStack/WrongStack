import { describe, expect, it } from 'vitest';
import { earlierConversation } from '../src/acp-leader/acp-leader-stream.js';

// The seed keeps the newest `maxChars` UTF-16 units. Like clip() in the same module,
// the cut must not leave half of a surrogate pair behind.
describe('earlierConversation trimming', () => {
  const tail = 'b'.repeat(40);
  const messages = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: [{ type: 'text', text: `\u{1F600}${tail}` }] },
    { role: 'user', content: 'now' },
  ] as never;
  const bodyLength = 'User: x\n\nAssistant: '.length + 2 + tail.length;

  it('does not start the kept text on a low surrogate', () => {
    const seed = earlierConversation(messages, bodyLength - 21) ?? '';
    expect(seed.isWellFormed()).toBe(true);
    expect(seed).toContain(tail);
    expect(seed).toContain('so are its oldest turns');
  });

  it('keeps a whole pair that fits inside the budget', () => {
    const seed = earlierConversation(messages, bodyLength - 20) ?? '';
    expect(seed).toContain(`\u{1F600}${tail}`);
  });
});
