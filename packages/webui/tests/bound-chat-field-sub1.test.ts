import { describe, expect, it } from 'vitest';
import { boundChatField } from '../src/stores/chat-retention';

describe('boundChatField sub-1 maxChars guard (F2221)', () => {
  it('falls back to MAX_CHAT_FIELD_CHARS for sub-1 positive maxChars instead of wiping text', () => {
    expect(boundChatField('hello world', 0.5)).toBe('hello world');
    expect(boundChatField('hello world', 0.99)).toBe('hello world');
  });

  it('still bounds text for valid maxChars >= 1', () => {
    expect(boundChatField('abcdefghij', 4)).toBe('abij');
  });
});
