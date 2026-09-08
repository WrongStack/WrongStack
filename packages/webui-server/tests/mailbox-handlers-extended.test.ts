import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSharedProjectMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
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

describe('Mailbox handlers — model-controlled limits (S10)', () => {
  it('clamps the mailbox.messages limit before it reaches the store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ws-mailbox-limit-'));
    const mb = getSharedProjectMailbox(resolveProjectDir(root, root));
    try {
      for (let i = 0; i < 250; i++) {
        await mb.send({ from: 'seeder', to: '*', type: 'note', subject: `m${i}`, body: 'x' });
      }
      // Harness guard: the store really holds the seed, so the clamp assertion
      // below can only pass vacuously if the handler reads a different store.
      expect((await mb.query({ limit: 250 })).length).toBe(250);

      const ws = createMockWs();
      await handleMailboxMessages(ws, { projectRoot: root, globalRoot: root }, { limit: 1e9 });
      const payload = (ws.sent[0] as { payload: { messages: unknown[] } }).payload;
      expect(payload.messages.length).toBeGreaterThan(0); // handler read the SAME store
      expect(payload.messages.length).toBeLessThanOrEqual(200); // the S10 clamp

      const wsDefault = createMockWs();
      await handleMailboxMessages(wsDefault, { projectRoot: root, globalRoot: root }, undefined);
      const payloadDefault = (wsDefault.sent[0] as { payload: { messages: unknown[] } }).payload;
      expect(payloadDefault.messages.length).toBeLessThanOrEqual(30);
    } finally {
      // Cleanup must never mask the assertion result: close is async and the
      // SQLite handle can lag, so retry the rm and swallow its final failure.
      try {
        await mb.close();
      } catch {
        /* best-effort */
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await rm(root, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  });
});
