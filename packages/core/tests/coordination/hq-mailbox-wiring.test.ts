/**
 * HQ publisher wiring for the project mailbox.
 *
 * The publisher hangs off `RemoteMailbox`, not off the SQLite store: the store
 * is owned by one detached process per project and knows nothing about HQ, so
 * telemetry is produced by the client wrapper as it observes IPC events. All
 * publishing is fire-and-forget — the assertions poll rather than await.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createProjectMailbox,
  getSharedProjectMailbox,
  MailboxProjectServerConnection,
  type RemoteMailbox,
} from '../../src/coordination/index.js';
import type { HqPublisher } from '../../src/hq/publisher.js';
import { EventBus } from '../../src/kernel/events.js';

let dir: string;
const openMailboxes: RemoteMailbox[] = [];
const publishEvent = vi.fn();
const publishSnapshot = vi.fn().mockResolvedValue(undefined);

function makePublisher(): HqPublisher {
  return {
    publishEvent,
    publishMailboxEvent: publishEvent,
    publishMailboxSnapshot: publishSnapshot,
  } as never as HqPublisher;
}

function open(hqPublisher?: HqPublisher | (() => HqPublisher | undefined)): RemoteMailbox {
  const mailbox = createProjectMailbox({ projectDir: dir, hqPublisher, isolatedConnection: true });
  openMailboxes.push(mailbox);
  return mailbox;
}

function track(mailbox: RemoteMailbox): RemoteMailbox {
  openMailboxes.push(mailbox);
  return mailbox;
}

/** Actions seen by the publisher so far. */
function publishedActions(spy = publishEvent): string[] {
  return spy.mock.calls.map((call) => (call[0] as { action: string }).action);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-mailbox-wiring-'));
  publishEvent.mockClear();
  publishSnapshot.mockClear();
});

afterEach(async () => {
  for (const mailbox of openMailboxes.splice(0)) await mailbox.close().catch(() => undefined);
  const control = new MailboxProjectServerConnection(dir);
  try {
    await control.shutdown('test-teardown');
  } catch {
    // No owner running, or it exited on its own.
  } finally {
    control.close();
  }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('project mailbox HQ publisher wiring', () => {
  it('behaves normally when no HQ publisher is configured', async () => {
    const mailbox = open();
    const msg = await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    expect(msg.id).toBeDefined();
    expect(publishEvent).not.toHaveBeenCalled();
    expect(publishSnapshot).not.toHaveBeenCalled();
  });

  it('publishes mailbox events and snapshots on send/register/ack/heartbeat activity', async () => {
    const mailbox = open(makePublisher());

    await mailbox.registerAgent({
      agentId: 'leader@1', sessionId: 'session_1', name: 'Leader', role: 'leader', pid: 1, source: 'cli',
    });
    const msg = await mailbox.send({
      from: 'leader@1', to: '*', type: 'status', subject: 'done', body: 'done',
    });
    await mailbox.heartbeat({ agentId: 'leader@1', status: 'running' });
    await mailbox.registerClient({
      clientId: 'tui@1', sessionId: 'session_1', name: 'TUI', source: 'tui', pid: 1,
    });
    await mailbox.clientHeartbeat({ clientId: 'tui@1' });
    await mailbox.ack({
      messageId: msg.id, readerId: 'leader@1', completed: true, outcome: 'shipped',
    });

    await expect
      .poll(() => publishedActions(), { timeout: 5000 })
      .toEqual(expect.arrayContaining(['agent.registered', 'message.sent', 'agent.heartbeat']));
    // An ack is an update, not a distinct completion action: completion is
    // per-actor now, so the aggregate telemetry carries the whole message.
    await expect
      .poll(() => publishedActions(), { timeout: 5000 })
      .toContain('message.updated');
    await expect.poll(() => publishSnapshot.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
  });

  it('does not publish a snapshot for a heartbeat once the roster is known', async () => {
    const mailbox = open(makePublisher());
    await mailbox.registerAgent({
      agentId: 'leader@1', sessionId: 'session_1', name: 'Leader', role: 'leader', pid: 1, source: 'cli',
    });
    // Registration moves the roster, so it legitimately schedules one snapshot.
    await expect.poll(() => publishSnapshot.mock.calls.length, { timeout: 5000 }).toBe(1);
    publishSnapshot.mockClear();

    await mailbox.heartbeat({ agentId: 'leader@1', status: 'running' });
    await mailbox.heartbeat({ agentId: 'leader@1', status: 'running' });
    await mailbox.heartbeat({ agentId: 'leader@1', status: 'running' });

    // The heartbeat delta still goes out — it is what keeps `lastSeen` live.
    await expect.poll(() => publishedActions(), { timeout: 5000 }).toContain('agent.heartbeat');
    // But no rollup: a heartbeat changes no state the snapshot summarizes, and
    // at one per agent per 30s this was the bulk of HQ's persisted volume.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(publishSnapshot).not.toHaveBeenCalled();
  });

  it('coalesces snapshots across a burst of message activity', async () => {
    const mailbox = open(makePublisher());
    for (let index = 0; index < 8; index++) {
      await mailbox.send({
        from: 'a', to: 'b', type: 'note', subject: `burst-${index}`, body: 'body',
      });
    }

    // Every message publishes its own delta — the live feed stays exact.
    await expect
      .poll(() => publishedActions().filter((action) => action === 'message.sent').length, {
        timeout: 5000,
      })
      .toBe(8);
    // The rollup fires once for the burst (leading publish, then the 10s gate
    // swallows the rest) instead of eight ~30 KB snapshots.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(publishSnapshot.mock.calls.length).toBe(1);
  });

  it('publishes an update when one actor completes a fan-out message', async () => {
    const mailbox = open(makePublisher());
    const msg = await mailbox.send({
      from: 'leader@1',
      to: '*',
      type: 'broadcast',
      subject: 'fan-out',
      body: 'complete independently',
    });
    await expect.poll(() => publishedActions(), { timeout: 5000 }).toContain('message.sent');
    publishEvent.mockClear();

    const updated = await mailbox.ack({
      messageId: msg.id,
      readerId: 'worker@1',
      completed: true,
    });

    // The ACTOR's view: worker@1 completed it. The stored message stays
    // incomplete for everyone else — see mailbox-v2-receipts.test.ts.
    expect(updated).toMatchObject({ completed: true, completedBy: 'worker@1' });
    await expect.poll(() => publishedActions(), { timeout: 5000 }).toContain('message.updated');
  });

  it('does not publish an event for a no-op acknowledgement', async () => {
    const mailbox = open(makePublisher());
    const msg = await mailbox.send({
      from: 'leader@1', to: 'worker@1', type: 'note', subject: 'read once', body: 'body',
    });
    await mailbox.ack({ messageId: msg.id, readerId: 'worker@1', read: true });
    await expect.poll(() => publishedActions(), { timeout: 5000 }).toContain('message.updated');
    publishEvent.mockClear();

    const updated = await mailbox.ack({ messageId: msg.id, readerId: 'worker@1', read: true });

    expect(updated).toMatchObject({ id: msg.id });
    // Give a stray event a chance to land before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('starts publishing when a lazy HQ publisher becomes available', async () => {
    let publisher: HqPublisher | undefined;
    const mailbox = open(() => publisher);

    await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 'before', body: 'before' });
    await new Promise((resolve) => setTimeout(resolve, 250));
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

    await expect.poll(() => publishedActions(), { timeout: 5000 }).toContain('message.sent');
    await expect.poll(() => publishSnapshot.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
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

    const firstMailbox = track(getSharedProjectMailbox(dir, firstEvents, firstPublisher));
    const secondMailbox = track(getSharedProjectMailbox(dir, secondEvents, secondPublisher));

    // Same (projectDir, events, publisher) triple → the same wrapper.
    expect(getSharedProjectMailbox(dir, firstEvents, firstPublisher)).toBe(firstMailbox);
    expect(secondMailbox).not.toBe(firstMailbox);

    await secondMailbox.send({
      from: 'second@session',
      to: 'first@session',
      type: 'note',
      subject: 'isolated dependencies',
      body: 'body',
    });

    // Every client connected to the project owner observes project mailbox
    // activity — that cross-process visibility is the whole point of the
    // daemon. What stays isolated is the DEPENDENCY set: each wrapper feeds
    // its own EventBus and its own publisher, exactly once, with no crosstalk
    // between the two dependency triples.
    await expect.poll(() => firstPublishEvent.mock.calls.length, { timeout: 5000 }).toBe(1);
    await expect.poll(() => secondPublishEvent.mock.calls.length, { timeout: 5000 }).toBe(1);
    expect(firstEventListener).toHaveBeenCalledOnce();
    expect(secondEventListener).toHaveBeenCalledOnce();
  });

  it('keeps mailbox behavior unaffected when the HQ publisher throws', async () => {
    const failingPublisher = {
      publishMailboxEvent: vi.fn(() => {
        throw new Error('HQ down');
      }),
      publishMailboxSnapshot: vi.fn(() => Promise.reject(new Error('HQ snapshot down'))),
    } as never as HqPublisher;

    const mailbox = open(failingPublisher);

    const msg = await mailbox.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    expect(msg.id).toBeDefined();
    await expect(
      mailbox.ack({ messageId: msg.id, readerId: 'b', completed: true }),
    ).resolves.toMatchObject({ id: msg.id });
  });
});
