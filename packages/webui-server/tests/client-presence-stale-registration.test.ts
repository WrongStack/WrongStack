import { afterEach, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  active: new Set<string>(),
  deferred: null as null | Promise<void>,
  ids: 0,
  connections: [] as Array<{ stop: ReturnType<typeof vi.fn> }>,
  connects: [] as Array<(publisher: never) => void>,
}));

vi.mock('@wrongstack/core/coordination', () => ({
  resolveProjectDir: () => '/fixture',
  getSharedProjectMailbox: () => ({
    registerClient: async (p: { clientId: string }) => {
      const wait = seam.deferred;
      if (wait) await wait;
      seam.active.add(p.clientId);
    },
    deregisterClient: async (id: string) => {
      seam.active.delete(id);
    },
    clientHeartbeat: async () => {},
  }),
}));
vi.mock('@wrongstack/core/utils', () => ({ wstackGlobalRoot: () => '/fixture-home' }));
vi.mock('@wrongstack/hq', () => ({
  createApprovalRegistry: () => ({ dispose: vi.fn() }),
  startApprovalTelemetryBridge: () => () => {},
}));
vi.mock('node:crypto', () => ({
  randomUUID: () => `owner${String(++seam.ids).padStart(3, '0')}-0000-0000-0000-000000000000`,
}));
vi.mock('../src/server/hq-session-telemetry.js', () => ({
  startWebuiHqSessionTelemetry: () => ({ stop: vi.fn(), sync: vi.fn() }),
}));

import { createWebuiClientPresence } from '../src/server/client-presence.js';

function fixture() {
  return createWebuiClientPresence({
    projectRoot: '/fixture',
    appConfig: undefined,
    events: {} as never,
    hqSessionId: 'session',
    getSessionId: () => 'session',
    startHqConnection: (options) => {
      const connection = { stop: vi.fn(), getPublisher: () => undefined };
      seam.connections.push(connection);
      seam.connects.push(options.onConnect as never);
      return connection;
    },
  });
}
function gate() {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
it('fences late success, late failure and old HQ callback without losing current owner', async () => {
  vi.useFakeTimers();
  for (const outcome of ['success', 'failure']) {
    seam.active.clear();
    seam.connections = [];
    seam.connects = [];
    const deferred = gate();
    seam.deferred = deferred.promise;
    const presence = fixture();
    const old = presence.register();
    const oldConnect = seam.connects[0]!;
    presence.unregister();
    seam.deferred = null;
    const currentId = await presence.register();
    const currentConnection = seam.connections[1]!;
    oldConnect({} as never);
    if (outcome === 'success') deferred.resolve();
    else deferred.reject(new Error('stale failure'));
    expect(await old).toBeNull();
    await Promise.resolve();
    expect([...seam.active]).toEqual([currentId]);
    expect(currentConnection.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
    presence.unregister();
    presence.unregister();
    expect(seam.active.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  }
  const late = gate();
  seam.deferred = late.promise;
  const stopped = fixture();
  const pending = stopped.register();
  stopped.unregister();
  late.resolve();
  expect(await pending).toBeNull();
  await Promise.resolve();
  expect(seam.active.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
