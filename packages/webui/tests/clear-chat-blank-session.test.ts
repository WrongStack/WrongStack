import { describe, expect, it } from 'vitest';
import { clearChatContext } from '../src/lib/clear-chat-context';

describe('clearChatContext blank sessionId guard (F2229)', () => {
  it('ignores whitespace-only sessionId and falls back to clearContext', () => {
    let newSessionCalled = false;
    let clearContextCalled = false;
    clearChatContext({
      client: {
        newSession: () => {
          newSessionCalled = true;
        },
        clearContext: () => {
          clearContextCalled = true;
        },
      },
      isLoading: false,
      clearMessages: () => {},
      setLoading: () => {},
      sessionId: '   ',
    });
    expect(newSessionCalled).toBe(false);
    expect(clearContextCalled).toBe(true);
  });
});
