import { afterEach, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  pending: undefined as Promise<void> | undefined,
  active: new Set<string>(),
  connections: [] as Array<{ stop: ReturnType<typeof vi.fn> }>,
  connects: [] as Array<((publisher: never) => void) | undefined>,
  telemetryStarts: 0,
}));
vi.mock('@wrongstack/core/coordination', () => ({
  resolveProjectDir: () => '/fixture',
  getSharedProjectMailbox: () => ({
    registerClient: async (value: { clientId: string }) => {
      const gate = seam.pending;
      if (gate) await gate;
      seam.active.add(value.clientId);
    },
    deregisterClient: async (id: string) => {
      seam.active.delete(id);
    },
    clientHeartbeat: async () => {},
  }),
}));
vi.mock('@wrongstack/core/utils', () => ({ wstackGlobalRoot: () => '/fixture-home' }));
vi.mock('@wrongstack/hq', () => ({
  createApprovalRegistry: () => ({ dispose() {} }),
  startApprovalTelemetryBridge: () => () => {},
}));
vi.mock('../src/server/hq-session-telemetry.js', () => ({
  startWebuiHqSessionTelemetry: () => {
    seam.telemetryStarts++;
    return { stop() {}, sync() {} };
  },
}));
const { createWebuiClientPresence } = await import('../src/server/client-presence.js');
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  seam.pending = undefined;
  seam.connections = [];
  seam.connects = [];
  seam.active.clear();
  seam.telemetryStarts = 0;
});
function setup() {
  return createWebuiClientPresence({
    projectRoot: '/fixture',
    appConfig: undefined,
    events: {} as never,
    hqSessionId: 'session',
    getSessionId: () => 'session',
    startHqConnection: (options) => {
      const value = { stop: vi.fn(), getPublisher: () => undefined };
      seam.connections.push(value);
      seam.connects.push(options.onConnect);
      return value;
    },
  });
}
it('releases replaced registration resources without letting stale success/failure close its successor', async () => {
  vi.useFakeTimers();
  for (const mode of ['late-success', 'late-failure', 'sequential'] as const) {
    seam.connections = [];
    seam.connects = [];
    seam.telemetryStarts = 0;
    const value = setup();
    let release!: () => void;
    let fail!: (error: Error) => void;
    if (mode !== 'sequential')
      seam.pending = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    const old = value.register();
    if (mode === 'sequential') await old;
    seam.pending = undefined;
    const currentId = await value.register();
    expect(seam.connections[0]?.stop).toHaveBeenCalledOnce();
    seam.connects[0]?.({} as never);
    expect(seam.telemetryStarts).toBe(0);
    if (mode === 'late-success') release();
    if (mode === 'late-failure') fail(new Error('stale registration failed'));
    if (mode !== 'sequential') expect(await old).toBeNull();
    expect([...seam.active]).toEqual([currentId]);
    expect(seam.connections[1]?.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
    value.unregister();
    value.unregister();
    expect(seam.active.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(seam.connections.every((connection) => connection.stop.mock.calls.length === 1)).toBe(
      true,
    );
  }
});
