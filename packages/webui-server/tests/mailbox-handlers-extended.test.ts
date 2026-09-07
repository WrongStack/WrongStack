import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleMailboxAction,
  handleMailboxAgents,
  handleMailboxClear,
  handleMailboxCompact,
  handleMailboxMessages,
  handleMailboxPurge,
  handleMailboxSend,
} from '../src/server/mailbox-handlers.js';

function createMockWs() {
  const sent: unknown[] = [];
  const ws = {
    readyState: 1,
    sent,
    send: vi.fn((data: string) => {
      sent.push(JSON.parse(data));
    }),
  } as unknown as WebSocket & { sent: unknown[] };
  return ws;
}

describe('Mailbox Handlers Extended Unit Tests', () => {
  it('handles missing project root or global root gracefully across all handlers', async () => {
    const ws = createMockWs();
    const emptyDeps = { projectRoot: '', globalRoot: '' };

    await handleMailboxAction(ws, emptyDeps, {
      requestId: 'r1',
      action: 'ack',
      mailId: 'm1',
    } as never);
    expect(ws.sent[0]).toMatchObject({
      type: 'mailbox.action_result',
      payload: { success: false, error: 'No project root available' },
    });

    await handleMailboxMessages(ws, emptyDeps, undefined);
    expect(ws.sent[1]).toMatchObject({
      type: 'mailbox.messages',
      payload: { error: 'No project root available', messages: [] },
    });

    await handleMailboxAgents(ws, emptyDeps, undefined);
    expect(ws.sent[2]).toMatchObject({
      type: 'mailbox.agents',
      payload: { error: 'No project root available', agents: [] },
    });

    await handleMailboxClear(ws, emptyDeps);
    expect(ws.sent[3]).toMatchObject({
      type: 'mailbox.cleared',
      payload: { error: 'No project root available' },
    });

    await handleMailboxPurge(ws, emptyDeps);
    expect(ws.sent[4]).toMatchObject({
      type: 'mailbox.purged',
      payload: { error: 'No project root available' },
    });

    await handleMailboxCompact(ws, emptyDeps);
    expect(ws.sent[5]).toMatchObject({
      type: 'mailbox.compacted',
      payload: { error: 'No project root available' },
    });

    await handleMailboxSend(ws, emptyDeps, {
      requestId: 's1',
      to: 'leader',
      type: 'note',
      audience: 'all',
      subject: 'Test',
      body: 'Hello',
      priority: 'normal',
    });
    expect(ws.sent[6]).toMatchObject({
      type: 'mailbox.sent',
      payload: { success: false, error: 'No project root available' },
    });
  });
});
