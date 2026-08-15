import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '../../src/components/MessageBubble/index.js';
import { useChatStore } from '../../src/stores/chat-store.js';
import type { ChatMessage } from '../../src/stores/types.js';

const mockWs = {
  sendMessage: vi.fn(),
  isConnected: true,
};

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => mockWs,
}));

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'user_1',
    role: 'user',
    content: 'hello world',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant_1',
    role: 'assistant',
    content: 'hi back',
    timestamp: 1_700_000_000_001,
    ...overrides,
  };
}

describe('MessageBubble edit and retry operations', () => {
  beforeEach(() => {
    mockWs.sendMessage.mockClear();
    useChatStore.getState().clearMessages();
    useChatStore.getState().setLoading(false);
  });

  it('saveEdit updates the message in place and does NOT add a duplicate user message', () => {
    const userMsg = userMessage({ id: 'u1', content: 'original prompt' });
    const asstMsg = assistantMessage({ id: 'a1', content: 'original response' });
    useChatStore.getState().setMessages([userMsg, asstMsg]);

    render(<MessageBubble message={userMsg} isFirst />);

    // Click Edit button
    const editBtn = screen.getByRole('button', { name: /Edit/i });
    fireEvent.click(editBtn);

    // Change textarea value
    const textarea = screen.getByDisplayValue('original prompt');
    fireEvent.change(textarea, { target: { value: 'edited prompt' } });

    // Click Save button
    const saveBtn = screen.getByRole('button', { name: /Save & Send|Save/i });
    fireEvent.click(saveBtn);

    // Assert WebSocket sent the new prompt
    expect(mockWs.sendMessage).toHaveBeenCalledWith('edited prompt', undefined);

    // Assert chat store messages:
    // Should have only 1 user message (edited), and the subsequent assistant message truncated
    const messages = useChatStore.getState().messages;
    expect(messages.length).toBe(1);
    expect(messages[0]?.id).toBe('u1');
    expect(messages[0]?.content).toBe('edited prompt');
    expect(messages[0]?.role).toBe('user');
  });

  it('retryUserMessage resends failed message without duplicating it in history', () => {
    const failedUserMsg = userMessage({ id: 'u1', content: 'failed prompt', status: 'failed' });
    useChatStore.getState().setMessages([failedUserMsg]);

    render(<MessageBubble message={failedUserMsg} isFirst />);

    // Should see a Retry button on the failed user message
    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    fireEvent.click(retryBtn);

    expect(mockWs.sendMessage).toHaveBeenCalledWith('failed prompt', undefined);

    const messages = useChatStore.getState().messages;
    expect(messages.length).toBe(1);
    expect(messages[0]?.id).toBe('u1');
    expect(messages[0]?.content).toBe('failed prompt');
    expect(messages[0]?.status).toBeUndefined();
  });

  it('regenerate resends user message without creating duplicate user messages', () => {
    const userMsg = userMessage({ id: 'u1', content: 'my prompt' });
    const asstMsg = assistantMessage({ id: 'a1', content: 'error reply', isError: true });
    useChatStore.getState().setMessages([userMsg, asstMsg]);

    render(<MessageBubble message={asstMsg} isFirst />);

    // Click Retry / Regenerate on assistant message
    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    fireEvent.click(retryBtn);

    expect(mockWs.sendMessage).toHaveBeenCalledWith('my prompt', undefined);

    // Chat store should keep the 1 user message, truncate the assistant message, and NOT add a duplicate user message
    const messages = useChatStore.getState().messages;
    expect(messages.length).toBe(1);
    expect(messages[0]?.id).toBe('u1');
    expect(messages[0]?.content).toBe('my prompt');
    expect(messages[0]?.role).toBe('user');
  });
});
