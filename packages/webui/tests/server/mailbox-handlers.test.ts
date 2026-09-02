import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import {
  createProjectMailbox,
  type RemoteMailbox,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import { disposeProjectMailbox, removeMailboxTempRoot } from '../helpers/mailbox-daemon.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMailboxMessages } from '@wrongstack/webui-server';

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as never as WebSocket & {
    send: ReturnType<typeof vi.fn>;
  };
}

function lastPayload(ws: { send: ReturnType<typeof vi.fn> }): {
  messages: Array<{ subject: string }>;
} {
  const raw = ws.send.mock.calls.at(-1)?.[0];
  if (raw === undefined) throw new Error('expected a websocket message');
  return (JSON.parse(String(raw)) as { payload: { messages: Array<{ subject: string }> } }).payload;
}

describe('mailbox handlers', () => {
  let root: string;
  let projectRoot: string;
  let globalRoot: string;
  let mailbox: RemoteMailbox;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-webui-mailbox-'));
    projectRoot = path.join(root, 'project');
    globalRoot = path.join(root, 'global');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(globalRoot, { recursive: true });
    mailbox = createProjectMailbox({
      projectDir: resolveProjectDir(projectRoot, globalRoot),
      isolatedConnection: true,
    });
  });

  afterEach(async () => {
    // The mailbox has one mode: a detached owner per project directory. Leave
    // it running and Windows fails the `fs.rm` below with EBUSY on the open
    // `_mailbox.sqlite` handle. Close the wrapper first so its socket does not
    // hold the owner's `server.close()` open.
    await mailbox.close().catch(() => undefined);
    await disposeProjectMailbox(resolveProjectDir(projectRoot, globalRoot));
    await removeMailboxTempRoot(root);
  });

  it('filters mailbox messages by agent recipient and broadcast visibility', async () => {
    await mailbox.send({
      from: 'sender',
      to: 'agent-a',
      type: 'note',
      subject: 'direct-a',
      body: 'a',
    });
    await mailbox.send({
      from: 'sender',
      to: 'agent-b',
      type: 'note',
      subject: 'direct-b',
      body: 'b',
    });
    await mailbox.send({
      from: 'sender',
      to: '*',
      type: 'broadcast',
      subject: 'broadcast',
      body: 'all',
    });

    const ws = mockWs();
    await handleMailboxMessages(ws, { projectRoot, globalRoot }, { agentId: 'agent-a', limit: 10 });

    expect(
      lastPayload(ws)
        .messages.map((m) => m.subject)
        .sort(),
    ).toEqual(['broadcast', 'direct-a']);
  });

  it('applies unreadOnly for an agent instead of silently ignoring it', async () => {
    const read = await mailbox.send({
      from: 'sender',
      to: 'agent-a',
      type: 'note',
      subject: 'read',
      body: 'a',
    });
    await mailbox.send({
      from: 'sender',
      to: 'agent-a',
      type: 'note',
      subject: 'unread',
      body: 'b',
    });
    await mailbox.ack({ messageId: read.id, readerId: 'agent-a', read: true });

    const ws = mockWs();
    await handleMailboxMessages(
      ws,
      { projectRoot, globalRoot },
      { agentId: 'agent-a', unreadOnly: true, limit: 10 },
    );

    expect(lastPayload(ws).messages.map((m) => m.subject)).toEqual(['unread']);
  });
});
