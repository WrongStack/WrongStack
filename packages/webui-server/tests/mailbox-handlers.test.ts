import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createProjectMailbox,
  type RemoteMailbox,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import { createMailboxRouteHandlers, handleMailboxMessages } from '@wrongstack/webui-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { disposeProjectMailbox, removeMailboxTempRoot } from './helpers/mailbox-daemon.js';

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

  it('binds a leader-addressed send to the tab that composed it', async () => {
    const ws = mockWs();
    const routes = createMailboxRouteHandlers({
      getProjectRoot: () => projectRoot,
      getGlobalRoot: () => globalRoot,
    });

    await routes.send(ws, {
      type: 'mailbox.send',
      payload: {
        requestId: 'r1',
        to: 'leader',
        type: 'btw',
        audience: 'all',
        subject: 'btw from WebUI',
        body: 'while you are in there, check the retries',
        priority: 'normal',
        sessionId: 'tab-3',
      },
    });

    const messages = await mailbox.query({ to: 'leader' });
    const sent = messages.find((m) => m.subject === 'btw from WebUI');
    // `leader` is the alias for "this session's leader", and four tabs have
    // four of them. Without the affinity token every running tab folds this
    // note into its own run — a "btw" typed in tab 3 steering tab 1.
    expect(sent?.sessionAffinity).toEqual({ sessionId: 'tab-3' });
    expect(sent?.senderSessionId).toBe('tab-3');
  });

  it('leaves a message addressed to a named agent unscoped', async () => {
    const ws = mockWs();
    const routes = createMailboxRouteHandlers({
      getProjectRoot: () => projectRoot,
      getGlobalRoot: () => globalRoot,
    });

    await routes.send(ws, {
      type: 'mailbox.send',
      payload: {
        requestId: 'r2',
        to: 'agent-a',
        type: 'note',
        audience: 'all',
        subject: 'named recipient',
        body: 'for you specifically',
        priority: 'normal',
        sessionId: 'tab-3',
      },
    });

    const messages = await mailbox.query({ to: 'agent-a' });
    const sent = messages.find((m) => m.subject === 'named recipient');
    // A named agent is already exactly one recipient; narrowing it further
    // would change what the user asked for rather than resolve an ambiguity.
    expect(sent?.sessionAffinity).toBeUndefined();
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
    await mailbox.send({
      from: 'sender',
      to: 'agent-a',
      type: 'note',
      audience: 'leaders',
      subject: 'leader-private',
      body: 'hidden',
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

  it('validates route payloads before reaching mailbox storage', async () => {
    const ws = mockWs();
    const routes = createMailboxRouteHandlers({
      getProjectRoot: () => projectRoot,
      getGlobalRoot: () => globalRoot,
    });

    await routes.messages(ws, { type: 'mailbox.messages', payload: { limit: 'invalid' } });

    const response = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as {
      type: string;
      payload: { success: boolean; message: string };
    };
    expect(response.type).toBe('key.operation_result');
    expect(response.payload.success).toBe(false);
  });

  it('persists WebUI leader-only mail and acknowledges the request', async () => {
    const ws = mockWs();
    const routes = createMailboxRouteHandlers({
      getProjectRoot: () => projectRoot,
      getGlobalRoot: () => globalRoot,
    });

    await routes.send(ws, {
      type: 'mailbox.send',
      payload: {
        requestId: 'webui-1',
        to: 'leader',
        type: 'result',
        audience: 'leaders',
        subject: 'Review done',
        body: 'No findings',
        priority: 'normal',
      },
    });

    const response = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])) as {
      type: string;
      payload: { requestId: string; success: boolean; audience: string };
    };
    expect(response).toMatchObject({
      type: 'mailbox.sent',
      payload: { requestId: 'webui-1', success: true, audience: 'leaders' },
    });
    const messages = await mailbox.query({ to: 'leader' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: 'webui',
      audience: 'leaders',
      subject: 'Review done',
    });
  });
});
