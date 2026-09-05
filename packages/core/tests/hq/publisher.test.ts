import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxAgentStatus, MailboxMessage } from '../../src/coordination/mailbox-types.js';
import {
  HqPublisher,
  type HqSocketLike,
  resetHqPublisherWarningStateForTests,
} from '../../src/hq/publisher.js';

beforeEach(() => {
  resetHqPublisherWarningStateForTests();
});

describe('HqPublisher Kanban snapshots', () => {
  it('delivers server snapshots to the registered handler', async () => {
    const socket = new FakeSocket();
    const onKanbanSnapshot = vi.fn();
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      onKanbanSnapshot,
      socketFactory: () => socket,
    });
    publisher.connect();
    socket.open();
    const payload = {
      projectId: project.projectId,
      generatedAt: '2026-07-22T12:00:00.000Z',
      boards: [],
      tombstones: [],
    };
    socket.message(JSON.stringify({ type: 'hq.kanban_snapshot', payload }));
    await Promise.resolve();
    expect(onKanbanSnapshot).toHaveBeenCalledWith(payload);
    publisher.close();
  });
});

describe('HqPublisher connect-failure diagnostics', () => {
  it('emits ONE warning after repeated consecutive connect failures', async () => {
    const warn = vi.fn();
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:9',
      token: 'some-token',
      client,
      project,
      reconnectBaseMs: 1,
      reconnectMaxMs: 2,
      // Pin the threshold default explicitly and opt out of the process-wide
      // cooldown so this test stays order-independent: it asserts the
      // per-instance one-shot contract, while the cooldown has its own test.
      connectWarnAfterFailures: 5,
      connectWarnCooldownMs: 0,
      warn,
      socketFactory: () => {
        throw new Error('connect refused');
      },
    });

    publisher.connect();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    // The warning is one-shot — further failures stay silent.
    await new Promise((r) => setTimeout(r, 30));
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('consecutive connection failures');
    expect(message).toContain('http://127.0.0.1:9');
    expect(message).toContain('client token present');
    publisher.close();
  });

  it('suppresses duplicate connect-failure warnings process-wide while endpoint is unreachable', () => {
    vi.useFakeTimers();

    const makeFailingPublisher = (warn: (message: string) => void) =>
      new HqPublisher({
        url: 'http://127.0.0.1:9',
        token: 'some-token',
        client,
        project,
        reconnectBaseMs: 1,
        reconnectMaxMs: 2,
        warn,
        socketFactory: () => {
          throw new Error('connect refused');
        },
      });

    const warnA = vi.fn();
    const warnB = vi.fn();
    const publisherA = makeFailingPublisher(warnA);
    publisherA.connect();
    // Reconnect delays 1,2,2,2 → 5 failures at fake t+7ms → first warning of
    // the process.
    vi.advanceTimersByTime(7);
    expect(warnA).toHaveBeenCalledTimes(1);

    // A second instance failing identically is suppressed:
    // its 5th failure crosses the threshold, but process-wide suppression holds it back.
    const publisherB = makeFailingPublisher(warnB);
    publisherB.connect();
    vi.advanceTimersByTime(100);
    expect(warnB).not.toHaveBeenCalled();
    expect(warnA).toHaveBeenCalledTimes(1);

    // Retries continue silently without recurring interval warnings.
    vi.advanceTimersByTime(500);
    expect(warnB).not.toHaveBeenCalled();
    expect(warnA).toHaveBeenCalledTimes(1);

    publisherA.close();
    publisherB.close();
    vi.useRealTimers();
  });

  it('stays silent while connections succeed', async () => {
    const warn = vi.fn();
    const socket = new FakeSocket();
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      client,
      project,
      warn,
      socketFactory: () => socket,
    });
    publisher.connect();
    socket.open();
    await new Promise((r) => setTimeout(r, 20));
    expect(warn).not.toHaveBeenCalled();
    publisher.close();
  });

  it('resets connect warning state after a successful connection', () => {
    vi.useFakeTimers();
    let socket = new FakeSocket();
    let shouldFail = false;
    const warn = vi.fn();
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      client,
      project,
      reconnectBaseMs: 1,
      reconnectMaxMs: 2,
      warn,
      socketFactory: () => {
        if (shouldFail) {
          throw new Error('connect refused');
        }
        socket = new FakeSocket();
        return socket;
      },
    });

    // 1. Initial connection succeeds.
    publisher.connect();
    socket.open();
    expect(warn).not.toHaveBeenCalled();

    // 2. Connection drops and subsequent reconnects fail 5 times.
    shouldFail = true;
    socket.close();
    vi.advanceTimersByTime(10);
    expect(warn).toHaveBeenCalledTimes(1);

    // 3. Further retries while failing do not trigger another warning.
    vi.advanceTimersByTime(500);
    expect(warn).toHaveBeenCalledTimes(1);

    publisher.close();
    vi.useRealTimers();
  });
});

class FakeSocket implements HqSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const client = {
  clientId: 'client_1',
  kind: 'cli' as const,
  machineId: 'machine_1',
  startedAt: '2026-06-21T12:00:00.000Z',
};

const project = {
  projectId: 'project_1',
  projectRoot: '/repo',
  projectName: 'repo',
  machineId: 'machine_1',
  workspaceKind: 'git' as const,
};

const message: MailboxMessage = {
  id: 'msg_1',
  from: 'leader@a',
  to: '*',
  type: 'status',
  subject: 'Done',
  body: 'SECRET_TOKEN=abcdefghijklmnopqrstuvwxyz123456',
  priority: 'normal',
  readBy: {},
  completed: false,
  timestamp: '2026-06-21T12:00:00.000Z',
};

const agent: MailboxAgentStatus = {
  agentId: 'leader@a',
  name: 'Leader',
  sessionId: 'session_1',
  status: 'running',
  iterations: 1,
  toolCalls: 2,
  lastActivityAt: '2026-06-21T12:00:00.000Z',
  lastSeenAt: '2026-06-21T12:00:00.000Z',
  online: true,
  pid: 123,
  source: 'cli',
};

function parseSent(socket: FakeSocket): unknown[] {
  return socket.sent.map((frame) => JSON.parse(frame) as unknown);
}

describe('HqPublisher', () => {
  it('publishes raw transcript text by default while still applying secret scrubbing', () => {
    const socket = new FakeSocket();
    socket.readyState = 1;
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      socketFactory: () => socket,
    });
    publisher.connect();
    const event = publisher.publishEvent({
      type: 'session.transcript',
      payload: {
        sessionId: 's1',
        fromSeq: 0,
        entries: [{ ts: '2026-06-21T12:00:00.000Z', role: 'user', text: 'private prompt' }],
      },
    });

    expect((event.payload as { entries: Array<{ text: string }> }).entries[0]?.text).toBe(
      'private prompt',
    );
    const hello = parseSent(socket)[0] as { payload: { redactionPolicy: unknown } };
    expect(hello.payload.redactionPolicy).toEqual({
      rawContent: true,
      toolArgs: 'full',
      paths: 'full',
    });
    publisher.close();
  });

  it('allows explicitly opted-in raw transcript text while still applying secret scrubbing', () => {
    const socket = new FakeSocket();
    socket.readyState = 1;
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      redactionPolicy: { rawContent: true },
      socketFactory: () => socket,
    });
    publisher.connect();
    const event = publisher.publishEvent({
      type: 'session.transcript',
      payload: {
        sessionId: 's1',
        fromSeq: 0,
        entries: [{ ts: '2026-06-21T12:00:00.000Z', role: 'user', text: 'visible prompt' }],
      },
    });
    expect((event.payload as { entries: Array<{ text: string }> }).entries[0]?.text).toBe(
      'visible prompt',
    );
    publisher.close();
  });

  it('does not truncate opted-in transcript text at the generic 500-char summary cap', () => {
    const socket = new FakeSocket();
    socket.readyState = 1;
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      redactionPolicy: { rawContent: true },
      socketFactory: () => socket,
    });
    publisher.connect();
    const longText = 'x'.repeat(4_000);
    const event = publisher.publishEvent({
      type: 'session.transcript',
      payload: {
        sessionId: 's1',
        fromSeq: 0,
        entries: [{ ts: '2026-06-21T12:00:00.000Z', role: 'assistant', text: longText }],
      },
    });
    expect((event.payload as { entries: Array<{ text: string }> }).entries[0]?.text).toBe(longText);
    publisher.close();
  });

  it('connects to /ws/client and sends hello plus queued mailbox events', () => {
    const sockets: FakeSocket[] = [];
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      token: 'token_1',
      client,
      project,
      now: () => '2026-06-21T12:00:00.000Z',
      idFactory: () => 'evt_1',
      socketFactory: (url) => {
        expect(url).toBe('ws://localhost:3499/ws/client?token=token_1');
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const event = publisher.publishMailboxEvent({
      mailboxId: 'project_1:mailbox',
      action: 'message.sent',
      message,
    });
    expect(event.type).toBe('mailbox.event');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toEqual([]);

    sockets[0]?.open();
    const frames = parseSent(sockets[0]!);
    expect(frames).toMatchObject([
      { type: 'client.hello' },
      {
        type: 'client.event',
        event: { type: 'mailbox.event', payload: { action: 'message.sent' } },
      },
    ]);
    // WS-007: the mailbox body still rides along under the `rawContent` default
    // (that is what rawContent is for), but a credential inside it is scrubbed
    // before the frame leaves the process — per docs/configuration.md:1229.
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(wire).toContain('REDACTED');
  });

  it('sends application heartbeats while the socket is open', () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      now: () => '2026-06-21T12:00:01.000Z',
      idFactory: () => 'heartbeat_evt',
      heartbeatIntervalMs: 1_000,
      socketFactory: () => socket,
    });

    publisher.connect();
    socket.open();
    vi.advanceTimersByTime(1_000);

    expect(parseSent(socket)).toContainEqual({
      type: 'client.event',
      event: {
        id: 'heartbeat_evt',
        type: 'client.heartbeat',
        schemaVersion: 1,
        timestamp: '2026-06-21T12:00:01.000Z',
        clientId: 'client_1',
        projectId: 'project_1',
        seq: 1,
        payload: { uptimeMs: 1000, status: 'idle' },
      },
    });
    publisher.close();
    vi.useRealTimers();
  });

  it('treats socket factory failures as best-effort and queues telemetry', () => {
    vi.useFakeTimers();
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      client,
      project,
      reconnectBaseMs: 1_000,
      socketFactory: () => {
        throw new Error('socket unavailable');
      },
    });

    expect(() => publisher.connect()).not.toThrow();
    expect(() =>
      publisher.publishMailboxEvent({
        mailboxId: 'project_1:mailbox',
        action: 'message.sent',
        message,
      }),
    ).not.toThrow();

    publisher.close();
    vi.useRealTimers();
  });

  it('counts frames dropped by the bounded outbound queue on overflow', () => {
    vi.useFakeTimers();
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      client,
      project,
      reconnectBaseMs: 1_000,
      maxQueuedMessages: 1,
      socketFactory: () => {
        throw new Error('socket unavailable');
      },
    });

    // Offline (socket factory throws): connect() schedules a reconnect and
    // enqueues nothing itself, so every publish queues exactly one frame.
    publisher.connect();
    expect(publisher.getQueueStats().droppedFrames).toBe(0);

    publisher.publishMailboxEvent({
      mailboxId: 'project_1:mailbox',
      action: 'message.sent',
      message,
    });
    publisher.publishMailboxEvent({
      mailboxId: 'project_1:mailbox',
      action: 'message.sent',
      message,
    });
    publisher.publishMailboxEvent({
      mailboxId: 'project_1:mailbox',
      action: 'message.sent',
      message,
    });

    // Cap of 1 → the first two frames are dropped oldest-first, one retained.
    const stats = publisher.getQueueStats();
    expect(stats.entries).toBe(1);
    expect(stats.droppedFrames).toBe(2);
    expect(stats.droppedBytes).toBeGreaterThan(0);

    publisher.close();
    vi.useRealTimers();
  });

  it('coalesces obsolete snapshots while HQ is offline', () => {
    vi.useFakeTimers();
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      client,
      project,
      reconnectBaseMs: 1_000,
      maxQueuedBytes: 1024 * 1024,
      socketFactory: () => {
        throw new Error('socket unavailable');
      },
    });

    publisher.connect();
    for (let revision = 1; revision <= 3; revision += 1) {
      publisher.publishEvent({
        type: 'mailbox.snapshot',
        payload: { mailboxId: 'project_1:mailbox', revision, body: 'x'.repeat(4096) },
      });
    }

    const stats = publisher.getQueueStats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBeLessThan(8 * 1024);
    expect(stats.coalescedFrames).toBe(2);
    expect(stats.coalescedBytes).toBeGreaterThan(0);
    expect(stats.droppedFrames).toBe(0);

    publisher.close();
    vi.useRealTimers();
  });

  it('keeps every chunk of one snapshot while HQ is offline', () => {
    // Chunks of a split publish are different content, not successive versions
    // of the same content. They used to share a coalesce key — so a three-chunk
    // kanban snapshot queued during an outage arrived as its last chunk alone,
    // and the boards in the first two chunks silently never reached HQ.
    vi.useFakeTimers();
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      client,
      project,
      reconnectBaseMs: 1_000,
      maxQueuedBytes: 1024 * 1024,
      socketFactory: () => {
        throw new Error('socket unavailable');
      },
    });

    publisher.connect();
    for (let chunkIndex = 0; chunkIndex < 3; chunkIndex += 1) {
      publisher.publishEvent({
        type: 'kanban.snapshot',
        payload: {
          projectId: 'project_1',
          generatedAt: '2026-08-10T00:00:00.000Z',
          boards: [],
          tombstones: [],
          chunkIndex,
          chunkCount: 3,
          body: 'x'.repeat(4096),
        },
      });
    }

    let stats = publisher.getQueueStats();
    expect(stats.entries).toBe(3);
    expect(stats.coalescedFrames).toBe(0);
    expect(stats.droppedFrames).toBe(0);

    // A newer publish still supersedes the older one chunk for chunk.
    for (let chunkIndex = 0; chunkIndex < 3; chunkIndex += 1) {
      publisher.publishEvent({
        type: 'kanban.snapshot',
        payload: {
          projectId: 'project_1',
          generatedAt: '2026-08-10T00:01:00.000Z',
          boards: [],
          tombstones: [],
          chunkIndex,
          chunkCount: 3,
          body: 'y'.repeat(4096),
        },
      });
    }

    stats = publisher.getQueueStats();
    expect(stats.entries).toBe(3);
    expect(stats.coalescedFrames).toBe(3);

    publisher.close();
    vi.useRealTimers();
  });

  it('drops a single telemetry frame larger than the byte cap', () => {
    vi.useFakeTimers();
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      client,
      project,
      reconnectBaseMs: 1_000,
      maxQueuedBytes: 256,
      socketFactory: () => {
        throw new Error('socket unavailable');
      },
    });

    publisher.connect();
    publisher.publishEvent({
      type: 'mailbox.snapshot',
      payload: { mailboxId: 'project_1:mailbox', body: 'x'.repeat(1024) },
    });

    const stats = publisher.getQueueStats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);
    expect(stats.droppedFrames).toBe(1);
    expect(stats.droppedBytes).toBeGreaterThan(256);

    publisher.close();
    vi.useRealTimers();
  });

  it('treats invalid HQ URLs as best-effort and queues telemetry', () => {
    vi.useFakeTimers();
    const publisher = new HqPublisher({
      url: 'not a url',
      client,
      project,
      reconnectBaseMs: 1_000,
      socketFactory: () => new FakeSocket(),
    });

    expect(() => publisher.connect()).not.toThrow();
    expect(() =>
      publisher.publishMailboxEvent({
        mailboxId: 'project_1:mailbox',
        action: 'message.sent',
        message,
      }),
    ).not.toThrow();

    publisher.close();
    vi.useRealTimers();
  });

  it('publishes mailbox snapshots from the mailbox API', async () => {
    const socket = new FakeSocket();
    socket.readyState = 1;
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      now: () => '2026-06-21T12:00:00.000Z',
      idFactory: () => 'evt_snapshot',
      socketFactory: () => socket,
    });

    publisher.connect();
    await publisher.publishMailboxSnapshot(
      {
        query: async () => [message],
        getAgentStatuses: async () => [agent],
      },
      { mailboxId: 'project_1:mailbox', sessionId: 'session_1' },
    );

    const frames = parseSent(socket);
    expect(frames).toMatchObject([
      { type: 'client.hello' },
      {
        type: 'client.event',
        event: {
          id: 'evt_snapshot',
          type: 'mailbox.snapshot',
          sessionId: 'session_1',
          payload: { totals: { messages: 1, incomplete: 1, onlineAgents: 1 } },
        },
      },
    ]);
  });

  it('polls commands over the outbound client connection and acknowledges handled commands', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const handled: string[] = [];
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      commandPollIntervalMs: 1_000,
      onCommand: (command) => {
        handled.push(command.commandId);
        return { commandId: command.commandId, status: 'completed', message: 'ok' };
      },
      socketFactory: () => socket,
    });

    publisher.connect();
    socket.open();

    expect(parseSent(socket)).toContainEqual({
      type: 'client.command_poll',
      clientId: 'client_1',
      projectId: 'project_1',
      limit: 25,
    });

    socket.message(
      JSON.stringify({
        type: 'hq.command_batch',
        commands: [
          {
            commandId: 'cmd_1',
            type: 'refresh',
            createdAt: '2026-06-21T12:00:00.000Z',
            payload: {},
          },
        ],
      }),
    );
    await Promise.resolve();

    expect(handled).toEqual(['cmd_1']);
    expect(parseSent(socket)).toContainEqual({
      type: 'client.command_ack',
      clientId: 'client_1',
      projectId: 'project_1',
      commandId: 'cmd_1',
      status: 'completed',
      message: 'ok',
    });

    publisher.pollCommands();
    expect(parseSent(socket)).toContainEqual({
      type: 'client.command_poll',
      clientId: 'client_1',
      projectId: 'project_1',
      afterCommandId: 'cmd_1',
      limit: 25,
    });
    publisher.close();
    vi.useRealTimers();
  });
});

describe('HqPublisher command redelivery', () => {
  const batch = (commandId: string): string =>
    JSON.stringify({
      type: 'hq.command_batch',
      commands: [{ commandId, type: 'spawn', createdAt: '2026-06-21T12:00:00.000Z', payload: {} }],
    });

  it('runs a redelivered command once while its handler is still in flight', async () => {
    // `lastCommandId` only advances AFTER the handler returns, while
    // `command_poll` fires on a fixed timer — so any handler slower than the
    // poll interval is re-sent the same command. For `spawn` that used to mean
    // a second subagent; for `abort`, a second kill.
    const socket = new FakeSocket();
    let calls = 0;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      onCommand: async (command) => {
        calls += 1;
        await started;
        return { commandId: command.commandId, status: 'completed', message: 'spawned' };
      },
      socketFactory: () => socket,
    });
    publisher.connect();
    socket.open();

    socket.message(batch('cmd_slow'));
    await Promise.resolve();
    socket.message(batch('cmd_slow'));
    await Promise.resolve();
    expect(calls).toBe(1);

    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    const acks = parseSent(socket).filter(
      (frame) => (frame as { type?: string }).type === 'client.command_ack',
    );
    expect(acks).toHaveLength(1);
    publisher.close();
  });

  it('replays the original ack for a command redelivered after it finished', async () => {
    // The audit row must converge on the real outcome, not be overwritten by
    // a fresh placeholder ack for the same commandId.
    const socket = new FakeSocket();
    let calls = 0;
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      onCommand: (command) => {
        calls += 1;
        return { commandId: command.commandId, status: 'completed', message: 'spawned' };
      },
      socketFactory: () => socket,
    });
    publisher.connect();
    socket.open();

    socket.message(batch('cmd_done'));
    await Promise.resolve();
    socket.message(batch('cmd_done'));
    await Promise.resolve();

    expect(calls).toBe(1);
    const acks = parseSent(socket).filter(
      (frame) => (frame as { type?: string }).type === 'client.command_ack',
    );
    expect(acks).toHaveLength(2);
    for (const ack of acks) {
      expect(ack).toMatchObject({ commandId: 'cmd_done', status: 'completed', message: 'spawned' });
    }
    publisher.close();
  });
});
