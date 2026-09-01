import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from '../../src/components/MessageBubble/index.js';
import type { ChatMessage } from '../../src/stores/types.js';

const INSTRUCTION =
  '<!-- wrongstack-perf-run scope="packages/sage" mode="cpu" metric="p99-latency-ms" -->\n' +
  'A very long performance prompt the user should never have to scroll past.';

function perfMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'perf_1',
    role: 'user',
    content: INSTRUCTION,
    timestamp: 1_700_000_000_000,
    perfRun: { scope: 'packages/sage', mode: 'cpu', metric: 'p99-latency-ms' },
    ...overrides,
  };
}

describe('MessageBubble performance round card', () => {
  it('renders the mode, scope, and metric instead of the instruction text', () => {
    render(<MessageBubble message={perfMessage()} isFirst />);
    expect(screen.getByText('CPU Hot Path Reduction')).toBeTruthy();
    expect(screen.getByText('packages/sage and below')).toBeTruthy();
    expect(screen.getByText('p99 latency')).toBeTruthy();
    // The prompt body is what the agent gets; the transcript shows the card.
    expect(screen.queryByText(/never have to scroll past/)).toBeNull();
  });

  it('says "Whole project" for an empty scope and omits the metric chip when unset', () => {
    render(
      <MessageBubble
        message={perfMessage({
          id: 'perf_2',
          perfRun: { scope: '', mode: 'ratchet', metric: '' },
        })}
        isFirst
      />,
    );
    expect(screen.getByText('Performance Ratchet')).toBeTruthy();
    expect(screen.getByText('Whole project')).toBeTruthy();
    expect(screen.queryByText('p99 latency')).toBeNull();
  });

  it('suppresses the copy action, which would copy the hidden instruction', () => {
    const { container } = render(<MessageBubble message={perfMessage({ id: 'perf_3' })} isFirst />);
    const bubble = container.querySelector('[data-message-id="perf_3"]');
    expect(bubble?.textContent).not.toContain('common:action.copy');
    expect(bubble?.querySelector('button[title*="opy"]')).toBeNull();
  });

  it('renders no card chrome for an ordinary user message', () => {
    const { container } = render(
      <MessageBubble
        message={{ id: 'plain', role: 'user', content: 'hello', timestamp: 1 }}
        isFirst
      />,
    );
    const bubble = container.querySelector('[data-message-id="plain"]');
    expect(bubble?.textContent).not.toContain('Performance Ratchet');
    expect(bubble?.textContent).not.toContain('Whole project');
    // The copy action is suppressed only for the card, not for user messages
    // in general — this is the contrast the previous case relies on.
    expect(bubble?.textContent).toContain('Copy');
  });
});
