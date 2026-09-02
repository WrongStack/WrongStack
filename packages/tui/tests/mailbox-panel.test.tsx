import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  MailboxPanel,
  type MailboxMessageEntry,
  type MailboxAgentEntry,
} from '../src/components/mailbox-panel.js';

function msg(overrides: Partial<MailboxMessageEntry> = {}): MailboxMessageEntry {
  return {
    id: 'msg-1',
    from: 'agent-a',
    to: '*',
    type: 'note',
    subject: 'Test message',
    body: 'Hello world',
    priority: 'normal',
    timestamp: new Date().toISOString(),
    readByCount: 0,
    readByMe: false,
    completed: false,
    ...overrides,
  };
}

function agent(overrides: Partial<MailboxAgentEntry> = {}): MailboxAgentEntry {
  return {
    agentId: 'agent-1',
    name: 'Test Agent',
    sessionId: 'sess-1',
    status: 'running',
    lastSeenAt: new Date().toISOString(),
    online: true,
    ...overrides,
  };
}

describe('MailboxPanel', () => {
  it('renders nothing visible when open is false', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [],
        unreadCount: 0,
        open: false,
      }),
    );
    // Component returns null, but ink-testing-library wraps it so lastFrame() is ''
    expect(view.lastFrame() ?? '').toBe('');
    view.unmount();
  });

  it('renders the header when open', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Mailbox');
    expect(frame).toContain('0 unread');
    expect(frame).toContain('0 agents online');
    view.unmount();
  });

  it('shows unread count in yellow when > 0', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [],
        unreadCount: 3,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('3 unread');
    view.unmount();
  });

  it('shows "No messages yet" when messages empty', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('No messages yet');
    view.unmount();
  });

  it('renders messages with details', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [msg({ from: 'bot', subject: 'Status update', body: 'All good' })],
        agents: [],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('bot');
    expect(frame).toContain('Status update');
    view.unmount();
  });

  it('shows "new" badge for unread messages', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [msg({ readByMe: false, readByCount: 0 })],
        agents: [],
        unreadCount: 1,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('✉');
    view.unmount();
  });

  it('shows read count for messages read by others', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [msg({ readByMe: true, readByCount: 3 })],
        agents: [],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('👁');
    view.unmount();
  });

  it('shows checkmark for completed messages', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [msg({ completed: true })],
        agents: [],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('✓');
    view.unmount();
  });

  it('labels leader-only messages', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [msg({ audience: 'leaders' })],
        agents: [],
        unreadCount: 1,
        open: true,
      }),
    );
    expect(view.lastFrame() ?? '').toContain('leaders');
    view.unmount();
  });

  it('renders online agents', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [agent({ name: 'Worker-1' })],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Worker-1');
    view.unmount();
  });

  it('shows agent role when present', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [agent({ name: 'BugH', role: 'bug-hunter' })],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('bug-hunter');
    view.unmount();
  });

  it('shows agent current tool when present', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [agent({ currentTool: 'grep' })],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('grep');
    view.unmount();
  });

  it('shows agent current task when present', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [agent({ currentTask: 'Auditing auth' })],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Auditing auth');
    view.unmount();
  });

  it('shows agent source when present', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [agent({ source: 'http' })],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('http');
    view.unmount();
  });

  it('shows offline agent with dim indicator', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [agent({ online: false })],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('○');
    view.unmount();
  });

  it('shows online agent with green indicator', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [agent({ online: true })],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('●');
    view.unmount();
  });

  it('truncates long subject based on terminal width', () => {
    const longSubject = 'a'.repeat(100);
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [msg({ subject: longSubject })],
        agents: [],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('…');
    view.unmount();
  });

  it('renders the footer', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('/mailbox');
    expect(frame).toContain('Esc to close');
    view.unmount();
  });

  it('pluralizes agent count correctly', () => {
    const single = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [agent()],
        unreadCount: 0,
        open: true,
      }),
    );
    expect(single.lastFrame()).toContain('1 agent online');
    single.unmount();

    const multiple = render(
      React.createElement(MailboxPanel, {
        messages: [],
        agents: [agent(), agent({ agentId: 'a2', name: 'A2' })],
        unreadCount: 0,
        open: true,
      }),
    );
    expect(multiple.lastFrame()).toContain('2 agents online');
    multiple.unmount();
  });

  it('renders different message types with icons', () => {
    const types = ['ask', 'assign', 'steer', 'btw', 'broadcast', 'status', 'result'];
    for (const t of types) {
      const view = render(
        React.createElement(MailboxPanel, {
          messages: [msg({ type: t })],
          agents: [],
          unreadCount: 0,
          open: true,
        }),
      );
      expect(view.lastFrame()?.length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('renders unknown type with default icon', () => {
    const view = render(
      React.createElement(MailboxPanel, {
        messages: [msg({ type: 'unknown-type' })],
        agents: [],
        unreadCount: 0,
        open: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('📨');
    view.unmount();
  });
});
