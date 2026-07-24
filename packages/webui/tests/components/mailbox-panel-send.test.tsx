import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMailboxStore } from '../../src/stores/mailbox-store.js';

type Handler = (message: { type: string; payload: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();
const sends: Array<{ type: string; payload?: unknown }> = [];

const client = {
  status: { state: 'open' },
  onStatus(handler: (status: { state: string }) => void) {
    handler({ state: 'open' });
    return () => undefined;
  },
  on(type: string, handler: Handler) {
    const registered = handlers.get(type) ?? new Set<Handler>();
    registered.add(handler);
    handlers.set(type, registered);
    return () => registered.delete(handler);
  },
  send(message: { type: string; payload?: unknown }) {
    sends.push(message);
  },
};

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ client }),
}));

import { MailboxPanel } from '../../src/components/MailboxPanel.js';

beforeEach(() => {
  handlers.clear();
  sends.length = 0;
  useMailboxStore.setState({ messages: [], agents: [], lastCompaction: null });
});

describe('MailboxPanel composer', () => {
  it('sends an explicit leaders-only WebUI mailbox message', () => {
    render(<MailboxPanel />);
    fireEvent.click(screen.getByRole('button', { name: /compose message/i }));

    fireEvent.change(screen.getByLabelText('Audience'), { target: { value: 'leaders' } });
    fireEvent.change(screen.getByPlaceholderText('Subject (optional)'), {
      target: { value: 'Review result' },
    });
    fireEvent.change(screen.getByPlaceholderText('Message body'), {
      target: { value: 'No findings' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    const sent = sends.find((message) => message.type === 'mailbox.send');
    expect(sent?.payload).toMatchObject({
      to: 'leader',
      type: 'note',
      audience: 'leaders',
      subject: 'Review result',
      body: 'No findings',
      priority: 'normal',
    });
    expect(screen.getByText(/only leader agents/i)).toBeTruthy();
  });

  it('shows the correlated server acknowledgement', () => {
    render(<MailboxPanel />);
    fireEvent.click(screen.getByRole('button', { name: /compose message/i }));
    fireEvent.change(screen.getByPlaceholderText('Message body'), {
      target: { value: 'Milestone' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    const request = sends.find((message) => message.type === 'mailbox.send');
    const requestId = (request?.payload as { requestId?: string } | undefined)?.requestId;
    expect(requestId).toBeDefined();
    act(() => {
      for (const handler of handlers.get('mailbox.sent') ?? []) {
        handler({
          type: 'mailbox.sent',
          payload: { requestId, success: true, messageId: 'message-123456' },
        });
      }
    });

    expect(screen.getByText(/sent · message-/i)).toBeTruthy();
  });
});
