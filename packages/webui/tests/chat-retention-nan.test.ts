import { describe, expect, it } from 'vitest';
import { boundChatField, retainWebChatMessages } from '../src/stores/chat-retention';

describe('chat-retention non-finite budget guards', () => {
  it('falls back to defaults when maxMessages or maxChars is NaN', () => {
    const msgs = [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }] as Parameters<
      typeof retainWebChatMessages
    >[0];
    expect(retainWebChatMessages(msgs, { maxMessages: Number.NaN })).toHaveLength(1);
    expect(boundChatField('hello', Number.NaN)).toBe('hello');
  });
});
