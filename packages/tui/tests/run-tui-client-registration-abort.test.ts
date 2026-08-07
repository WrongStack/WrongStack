import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mailboxMocks = vi.hoisted(() => ({
  instances: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  registerClientGate: null as (() => void) | null,
}));

vi.mock('@wrongstack/core/coordination', () => ({
  resolveProjectDir: (root: string) => root,
  RemoteMailbox: class {
    initialize = vi.fn(async () => {});
    registerClient = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          if (mailboxMocks.registerClientGate) {
            // Test 1 parks the call here so unregister() can race it.
            const release = () => resolve();
            mailboxMocks.registerClientGate = release;
          } else {
            resolve();
          }
        }),
    );
    deregisterClient = vi.fn(async () => {});
    close = vi.fn();
    clientHeartbeat = vi.fn(async () => {});
    query = vi.fn(async () => []);
    getAgentStatuses = vi.fn(async () => []);
    getClientStatuses = vi.fn(async () => []);
    status = vi.fn(async () => ({
      protocolVersion: 1,
      pid: 1,
      clients: 1,
      pendingRequests: 0,
      storageKind: 'sqlite',
    }));
    unreadCount = vi.fn(async () => 0);
    constructor() {
      mailboxMocks.instances.push(this as never);
    }
  },
}));

vi.mock('@wrongstack/core/hq', () => ({
  createHqPublisherFromEnv: () => undefined,
  startBrainTelemetryBridge: () => () => {},
  startCostTelemetryBridge: () => () => {},
  startFleetTelemetryBridge: () => () => {},
  startSessionTelemetryBridge: () => () => {},
  startToolTelemetryBridge: () => () => {},
  startWorktreeTelemetryBridge: () => () => {},
}));

import { createRunTuiClientRegistration } from '../src/run-tui-client-registration.js';

type Handler = (event: string, payload: unknown) => void;

function makeEventsBus() {
  const handlers = new Set<{ handler: Handler }>();
  return {
    bus: {
      onPattern(_pattern: string, handler: Handler) {
        const entry = { handler };
        handlers.add(entry);
        return () => handlers.delete(entry);
      },
      emitCustom(_event: string, _payload: unknown) {},
    } as never,
    emit(event: string, payload: unknown = {}) {
      for (const entry of [...handlers]) entry.handler(event, payload);
    },
    get listenerCount() {
      return handlers.size;
    },
  };
}

describe('run-tui client registration', () => {
  beforeEach(() => {
    mailboxMocks.instances.length = 0;
    mailboxMocks.registerClientGate = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the mailbox pipe and drops the listener when registration is aborted mid-flight', async () => {
    // The bug this pins: the abort branch (generation bumped by an F1
    // project switch while registerClient was awaited) deregistered but
    // never close()d — leaving an open named-pipe connection that put the
    // NEXT startup on the zombie-pipe recovery path — and never removed
    // the mailbox.* listener it had installed before the await.
    const events = makeEventsBus();
    const registration = createRunTuiClientRegistration({
      projectRoot: 'D:/proj',
      events: events.bus,
      hqTelemetryOwnedExternally: true,
      isCleaned: () => false,
    });

    // Park registerClient so unregister() can race the in-flight register().
    mailboxMocks.registerClientGate = () => {};
    const pending = registration.register();
    await Promise.resolve();
    await Promise.resolve();
    registration.unregister();
    // Release the parked registerClient.
    mailboxMocks.registerClientGate?.();
    const result = await pending;

    expect(result).toBeNull();
    const mailbox = mailboxMocks.instances[0];
    expect(mailbox, 'RemoteMailbox was never constructed').toBeDefined();
    expect(mailbox?.deregisterClient).toHaveBeenCalled();
    expect(mailbox?.close, 'aborted registration left the pipe open').toHaveBeenCalled();
    expect(events.listenerCount, 'mailbox.* listener leaked past the abort').toBe(0);
  });

  it('coalesces bursts of mailbox events into one snapshot publish', async () => {
    const events = makeEventsBus();
    const registration = createRunTuiClientRegistration({
      projectRoot: 'D:/proj',
      events: events.bus,
      hqTelemetryOwnedExternally: true,
      isCleaned: () => false,
    });
    const clientId = await registration.register();
    expect(clientId).not.toBeNull();
    const mailbox = mailboxMocks.instances[0];
    if (!mailbox) throw new Error('no mailbox instance');
    // register() publishes one snapshot itself; measure from a clean slate.
    mailbox['query']?.mockClear();

    vi.useFakeTimers();
    // A burst of five mailbox events — previously five full snapshot
    // publishes (5 × five IPC round-trips); now one, after the window.
    for (let i = 0; i < 5; i++) events.emit('mailbox.received', { messageId: `m${i}` });
    expect(mailbox['query']).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(mailbox['query']).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(mailbox['query']).toHaveBeenCalledTimes(1);
    registration.unregister();
  });
});
