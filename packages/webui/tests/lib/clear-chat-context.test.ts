import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearChatContext } from '../../src/lib/clear-chat-context.js';
import { setActiveSessionLane } from '../../src/stores/session-lanes.js';

afterEach(() => setActiveSessionLane(null));

describe('clearing session context', () => {
  it('clears unbound context without sending a synthetic lane id to the server', () => {
    setActiveSessionLane(null);
    const client = { newSession: vi.fn(), clearContext: vi.fn() };
    const clearMessages = vi.fn();
    const setLoading = vi.fn();
    clearChatContext({ client, isLoading: false, clearMessages, setLoading });
    expect(client.clearContext).toHaveBeenCalledOnce();
    expect(client.newSession).not.toHaveBeenCalled();
    expect(clearMessages).toHaveBeenCalledOnce();
    expect(setLoading).toHaveBeenCalledWith(false);
  });

  it('retires a real active session and aborts its in-flight run', () => {
    setActiveSessionLane('session-a');
    const client = { newSession: vi.fn(), clearContext: vi.fn(), sendAbort: vi.fn() };
    clearChatContext({ client, isLoading: true, clearMessages: vi.fn(), setLoading: vi.fn() });
    expect(client.newSession).toHaveBeenCalledWith({ replaceSessionId: 'session-a' });
    expect(client.sendAbort).toHaveBeenCalledOnce();
    expect(client.clearContext).not.toHaveBeenCalled();
  });
});
