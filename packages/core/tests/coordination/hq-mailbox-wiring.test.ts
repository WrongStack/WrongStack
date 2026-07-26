import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _clearMailboxSingletons,
  getSharedMailbox,
  GlobalMailbox,
} from '../../src/coordination/global-mailbox.js';
import type { HqPublisher } from '../../src/hq/publisher.js';
import { EventBus } from '../../src/kernel/events.js';

let dir: string;
let mailbox: GlobalMailbox;
const publishEvent = vi.fn();
const publishSnapshot = vi.fn().mockResolvedValue(undefined);

function makePublisher(): HqPublisher {
  return {
    publishEvent,
    publishMailboxEvent: publishEvent,
    publishMailboxSnapshot: publishSnapshot,
  } as never as HqPublisher;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-mailbox-wiring-'));
  _clearMailboxSingletons();
  publishEvent.mockClear();
  publishSnapshot.mockClear();
});

afterEach(async () => {
  _clearMailboxSingletons();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('GlobalMailbox HQ publisher wiring', () => {
  it('behaves normally when no HQ publisher is configured', async () => {
    mailbox = new GlobalMailbox(dir);
    const msg = await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    expect(msg.id).toBeDefined();
    expect(publishEvent).not.toHaveBeenCalled();
    expect(publishSnapshot).not.toHaveBeenCalled();
  });

  it('publishes mailbox.snapshot and mailbox.event on send/register/ack/heartbeat/client activity', async () => {
    mailbox = new GlobalMailbox(dir, undefined, makePublisher());

    await mailbox.registerAgent({ agentId: 'leader@1', sessionId: 'session_1', name: 'Leader', role: 'leader', pid: 1, source: 'cli' });
    const msg = await mailbox.send({ from: 'leader@1', to: '*', type: 'status', subject: 'done', body: 'done' });
    await mailbox.heartbeat({ agentId: 'leader@1', status: 'running' });
    await mailbox.registerClient({ clientId: 'tui@1', sessionId: 'session_1', name: 'TUI', source: 'tui', pid: 1 });
    await mailbox.clientHeartbeat({ clientId: 'tui@1' });
    await mailbox.ack({ messageId: msg.id, readerId: 'leader@1', completed: true, outcome: 'shipped' });

    const actions = publishEvent.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(actions).toContain('agent.registered');
    expect(actions).toContain('message.sent');
    expect(actions).toContain('agent.heartbeat');
    expect(actions).toContain('message.completed');

    expect(publishSnapshot.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('publishes a completed event for v2 fan-out completion', async () => {
    mailbox = new GlobalMailbox(dir, undefined, makePublisher());
    const msg = await mailbox.send({
      from: 'leader@1',
      to: '*',
      type: 'broadcast',
      subject: 'fan-out',
      body: 'complete independently',
    });
    publishEvent.mockClear();

    const updated = await mailbox.ack({
      messageId: msg.id,
      readerId: 'worker@1',
      completed: true,
    });

    expect(updated).toMatchObject({ completed: true, completedBy: 'worker@1' });
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'message.completed' }),
    );
  });

  it('does not publish a duplicate HQ event for a no-op acknowledgement', async () => {
    mailbox = new GlobalMailbox(dir, undefined, makePublisher());
    const msg = await mailbox.send({
      from: 'leader@1', to: 'worker@1', type: 'note', subject: 'read once', body: 'body',
    });
    await mailbox.ack({ messageId: msg.id, readerId: 'worker@1', read: true });
    publishEvent.mockClear();

    const updated = await mailbox.ack({ messageId: msg.id, readerId: 'worker@1', read: true });

    expect(updated).toMatchObject({ id: msg.id });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('starts publishing when a lazy HQ publisher becomes available', async () => {
    let publisher: HqPublisher | undefined;
    mailbox = new GlobalMailbox(dir, undefined, () => publisher);

    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'before', body: 'before' });
    expect(publishEvent).not.toHaveBeenCalled();
    expect(publishSnapshot).not.toHaveBeenCalled();

    publisher = makePublisher();
    await mailbox.registerClient({
      clientId: 'tui@1',
      sessionId: 'session_1',
      name: 'TUI',
      source: 'tui',
      pid: 1,
    });
    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'after', body: 'after' });

    const actions = publishEvent.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(actions).toContain('message.sent');
    expect(publishSnapshot).toHaveBeenCalled();
  });

  it('isolates shared mailbox dependencies for same-project agents', async () => {
    const firstEvents = new EventBus();
    const secondEvents = new EventBus();
    const firstEventListener = vi.fn();
    const secondEventListener = vi.fn();
    firstEvents.onPattern('mailbox.message_sent', firstEventListener);
    secondEvents.onPattern('mailbox.message_sent', secondEventListener);

    const firstPublishEvent = vi.fn();
    const secondPublishEvent = vi.fn();
    const firstPublisher = {
      publishMailboxEvent: firstPublishEvent,
      publishMailboxSnapshot: vi.fn().mockResolvedValue(undefined),
    } as never as HqPublisher;
    const secondPublisher = {
      publishMailboxEvent: secondPublishEvent,
      publishMailboxSnapshot: vi.fn().mockResolvedValue(undefined),
    } as never as HqPublisher;

    const firstMailbox = getSharedMailbox(dir, firstEvents, firstPublisher);
    const secondMailbox = getSharedMailbox(dir, secondEvents, secondPublisher);

    expect(getSharedMailbox(dir, firstEvents, firstPublisher)).toBe(firstMailbox);
    expect(secondMailbox).not.toBe(firstMailbox);

    await secondMailbox.send({
      from: 'second@session',
      to: 'first@session',
      type: 'note',
      subject: 'isolated dependencies',
      body: 'body',
    });

    expect(firstEventListener).not.toHaveBeenCalled();
    expect(secondEventListener).toHaveBeenCalledOnce();
    expect(firstPublishEvent).not.toHaveBeenCalled();
    expect(secondPublishEvent).toHaveBeenCalledOnce();
  });

  it('keeps mailbox behavior unaffected when the HQ publisher throws', async () => {
    const failingPublisher = {
      publishMailboxEvent: vi.fn(() => {
        throw new Error('HQ down');
      }),
      publishMailboxSnapshot: vi.fn(() => Promise.reject(new Error('HQ snapshot down'))),
    } as never as HqPublisher;

    mailbox = new GlobalMailbox(dir, undefined, failingPublisher);

    const msg = await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    expect(msg.id).toBeDefined();
    await expect(mailbox.ack({ messageId: msg.id, readerId: 'b', completed: true })).resolves.toMatchObject({ id: msg.id });
  });
});
