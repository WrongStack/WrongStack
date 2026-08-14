import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from '../../src/components/MessageBubble/index.js';
import { useChatStore } from '../../src/stores/chat-store.js';
import type { ChatMessage } from '../../src/stores/types.js';

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
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('MessageBubble user-message styling', () => {
  it('renders user bubble with transparent background and primary-colored border', () => {
    const { container } = render(<MessageBubble message={userMessage()} isFirst />);
    const bubble = container.querySelector('[data-message-id="user_1"] .shadow-sm');
    expect(bubble).not.toBeNull();
    const className = bubble?.className ?? '';

    // Background must be transparent — no solid fill behind the text.
    expect(className).toContain('bg-transparent');
    expect(className).not.toContain('bg-primary');

    // Border stays in the primary palette (visual cue that this is the user).
    expect(className).toContain('border-primary/40');

    // Text color must be the standard foreground, not the inverted primary-foreground
    // (which was unreadable on bg-primary).
    expect(className).toContain('text-foreground');
    expect(className).not.toContain('text-primary-foreground');

    // The now-redundant .msg-user-bubble contrast override must be gone —
    // its rules inverted link/code/blockquote colors for the old colored bg.
    expect(className).not.toContain('msg-user-bubble');
  });

  it('still applies a primary-colored border (the "kept" cue from the request)', () => {
    const { container } = render(<MessageBubble message={userMessage()} isFirst />);
    const bubble = container.querySelector('[data-message-id="user_1"] .shadow-sm');
    expect(bubble?.className).toMatch(/border-primary\//);
  });

  it('does not regress the assistant bubble (still uses bg-card + neutral border)', () => {
    const { container } = render(<MessageBubble message={assistantMessage()} isFirst />);
    const bubble = container.querySelector('[data-message-id="assistant_1"] .shadow-sm');
    expect(bubble).not.toBeNull();
    const className = bubble?.className ?? '';
    expect(className).toContain('bg-card');
    expect(className).toContain('text-foreground');
    // Assistant does not inherit the user-specific border-primary.
    expect(className).not.toContain('border-primary/40');
  });

  it('preserves the corner-shape cue (rounded-br-sm) that distinguishes user from assistant', () => {
    const { container } = render(<MessageBubble message={userMessage()} isFirst />);
    const bubble = container.querySelector('[data-message-id="user_1"] .shadow-sm');
    expect(bubble?.className).toContain('rounded-br-sm');
  });

  it('shows next steps only for the latest assistant response', () => {
    const older = assistantMessage();
    older.nextSteps = { steps: [{ index: 1, text: 'Older suggestion' }] };
    const latest = assistantMessage({
      id: 'assistant_2',
      content: 'new reply',
      timestamp: 1_700_000_000_001,
    });
    latest.nextSteps = { steps: [{ index: 1, text: 'Latest suggestion' }] };
    useChatStore.getState().setMessages([older, latest]);
    useChatStore.getState().setLoading(false);
    expect(useChatStore.getState().messages.map((message) => message.id)).toEqual([
      'assistant_1',
      'assistant_2',
    ]);

    const { queryByText } = render(
      <>
        <MessageBubble message={older} isFirst />
        <MessageBubble message={latest} isFirst />
      </>,
    );

    expect(queryByText('Older suggestion')).toBeNull();
    expect(queryByText('Latest suggestion')).not.toBeNull();
    useChatStore.getState().clearMessages();
  });
});
