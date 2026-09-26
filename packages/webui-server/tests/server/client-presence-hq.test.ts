/**
 * WebUI presence ↔ HQ start-up seams.
 *
 * `startHqConnection` calls `onConnect` synchronously, before its return value
 * is stored — so anything `onConnect` did that read the publisher back through
 * the connection saw nothing. And a registration that failed half-way left the
 * HQ connection and its session telemetry running with no reconcile timer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const telemetry = vi.hoisted(() => ({
  publisherAtFirstSync: undefined as unknown,
  stop: vi.fn(),
}));

vi.mock('../../src/server/hq-session-telemetry.js', () => ({
  startWebuiHqSessionTelemetry: (options: { getPublisher: () => unknown }) => ({
    sync: () => {
      telemetry.publisherAtFirstSync ??= options.getPublisher();
    },
    stop: telemetry.stop,
  }),
}));

const mailbox = vi.hoisted(() => ({
  registerClient: vi.fn(async () => undefined),
  deregisterClient: vi.fn(async () => undefined),
  clientHeartbeat: vi.fn(async () => undefined),
}));

vi.mock('@wrongstack/core/coordination', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSharedProjectMailbox: () => mailbox,
}));

const { createWebuiClientPresence } = await import('../../src/server/client-presence.js');

function fakePublisher() {
  return {
    publishEvent: vi.fn(),
    onConnected: vi.fn(() => () => undefined),
    project: { projectId: 'p' },
  };
}

describe('WebUI client presence HQ start-up', () => {
  beforeEach(() => {
    telemetry.publisherAtFirstSync = undefined;
    telemetry.stop.mockReset();
    mailbox.registerClient.mockReset().mockResolvedValue(undefined);
  });

  it('publishes on the first sync instead of waiting for the reconcile timer', async () => {
    const publisher = fakePublisher();
    const presence = createWebuiClientPresence({
      projectRoot: '/repo',
      appConfig: undefined,
      events: { on: () => () => undefined, emit: () => undefined } as never,
      hqSessionId: 'boot',
      getSessionId: () => 'boot',
      startHqConnection: (options) => {
        options.onConnect?.(publisher as never);
        return { getPublisher: () => publisher as never, stop: vi.fn() };
      },
    });
    await presence.register();
    expect(telemetry.publisherAtFirstSync).toBe(publisher);
    presence.unregister();
  });

  it('tears the HQ side down when registration fails half-way', async () => {
    mailbox.registerClient.mockRejectedValue(new Error('daemon unavailable'));
    const stopConnection = vi.fn();
    const presence = createWebuiClientPresence({
      projectRoot: '/repo',
      appConfig: undefined,
      events: { on: () => () => undefined, emit: () => undefined } as never,
      hqSessionId: 'boot',
      getSessionId: () => 'boot',
      startHqConnection: (options) => {
        options.onConnect?.(fakePublisher() as never);
        return { getPublisher: () => undefined, stop: stopConnection };
      },
    });
    await expect(presence.register()).resolves.toBeNull();
    expect(stopConnection).toHaveBeenCalledOnce();
    expect(telemetry.stop).toHaveBeenCalled();
  });
});
