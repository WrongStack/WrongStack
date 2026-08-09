import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createHqCommandDispatcher: vi.fn(),
  startCliHqConnection: vi.fn(),
  startBrainTelemetryBridge: vi.fn(),
  startCostTelemetryBridge: vi.fn(),
  startFleetTelemetryBridge: vi.fn(),
  startGovernanceHqTelemetry: vi.fn(),
  startSessionTelemetryBridge: vi.fn(),
  startToolTelemetryBridge: vi.fn(),
  startWorktreeTelemetryBridge: vi.fn(),
}));

vi.mock('@wrongstack/core/hq', () => ({
  startBrainTelemetryBridge: mocks.startBrainTelemetryBridge,
  startCostTelemetryBridge: mocks.startCostTelemetryBridge,
  startFleetTelemetryBridge: mocks.startFleetTelemetryBridge,
  startSessionTelemetryBridge: mocks.startSessionTelemetryBridge,
  startToolTelemetryBridge: mocks.startToolTelemetryBridge,
  startWorktreeTelemetryBridge: mocks.startWorktreeTelemetryBridge,
}));
vi.mock('../src/governance-hq-telemetry.js', () => ({
  startGovernanceHqTelemetry: mocks.startGovernanceHqTelemetry,
}));
vi.mock('../src/hq-command-controller.js', () => ({
  createHqCommandDispatcher: mocks.createHqCommandDispatcher,
}));
vi.mock('../src/hq-publisher.js', () => ({
  startCliHqConnection: mocks.startCliHqConnection,
}));

import { setupHqTelemetry } from '../src/wiring/hq-telemetry.js';

describe('setupHqTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces reconnect bridges, forwards telemetry, and tears down every owner', () => {
    const eventHandlers = new Map<string, (payload: never) => void>();
    const offMessage = vi.fn();
    const offStatus = vi.fn();
    const events = {
      on: vi.fn((type: string, handler: (payload: never) => void) => {
        eventHandlers.set(type, handler);
        return type === 'agent.timeline.message' ? offMessage : offStatus;
      }),
    };
    const initialPublisher = { publishEvent: vi.fn() };
    const connectedPublisher = { publishEvent: vi.fn() };
    const reconnectedPublisher = { publishEvent: vi.fn() };
    const connectionStop = vi.fn();
    const connection = {
      getPublisher: vi.fn(() => initialPublisher),
      getKanbanSyncStats: vi.fn(() => ({ pushed: 3 })),
      stop: connectionStop,
    };
    let onConnect: ((publisher: typeof connectedPublisher) => void) | undefined;
    mocks.startCliHqConnection.mockImplementation((options) => {
      onConnect = options.onConnect;
      return connection;
    });
    const hqOnCommand = vi.fn();
    mocks.createHqCommandDispatcher.mockReturnValue(hqOnCommand);

    const firstStops = Array.from({ length: 8 }, () => vi.fn());
    const secondStops = Array.from({ length: 8 }, () => vi.fn());
    const bridgeMocks = [
      mocks.startSessionTelemetryBridge,
      mocks.startFleetTelemetryBridge,
      mocks.startGovernanceHqTelemetry,
      mocks.startBrainTelemetryBridge,
      mocks.startWorktreeTelemetryBridge,
      mocks.startToolTelemetryBridge,
      mocks.startCostTelemetryBridge,
    ];
    for (const [index, bridge] of bridgeMocks.entries()) {
      bridge.mockReturnValueOnce(firstStops[index]).mockReturnValueOnce(secondStops[index]);
    }
    let operationHandler: ((operation: unknown) => void) | undefined;
    const mcpRegistry = {
      operationalHealth: vi.fn(() => [{ id: 'filesystem', status: 'ready' }]),
      onOperation: vi
        .fn()
        .mockImplementationOnce((handler) => {
          operationHandler = handler;
          return firstStops[7];
        })
        .mockImplementationOnce((handler) => {
          operationHandler = handler;
          return secondStops[7];
        }),
    };
    const teardownHandlers: Array<() => void> = [];
    const hqPublisherRef: {
      current: typeof initialPublisher | undefined;
      getKanbanSyncStats?: () => unknown;
    } = { current: undefined };

    const result = setupHqTelemetry({
      events: events as never,
      session: { id: 'session-1' } as never,
      config: {} as never,
      flags: { 'hq-allow-exec': true },
      tuiOwnsScreen: true,
      projectRoot: 'D:\\work\\repo',
      globalRoot: 'D:\\global',
      tracker: { getAgents: () => [{ id: 'agent-1' }] },
      agentMonitor: {} as never,
      brainMailbox: {} as never,
      teardownHandlers,
      mailboxSessionTag: (id) => `tag:${id}`,
      hqPublisherRef: hqPublisherRef as never,
      mcpRegistry: mcpRegistry as never,
    });

    expect(mocks.startCliHqConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clientKind: 'tui',
        projectRoot: 'D:\\work\\repo',
        projectName: 'repo',
        onCommand: hqOnCommand,
      }),
    );
    expect(result.hqOnCommand).toBe(hqOnCommand);
    expect(result.hqCommandController.sessionTag()).toBe('tag:session-1');
    expect(result.hqCommandController.allowRunCommand()).toBe(true);
    expect(hqPublisherRef.current).toBe(initialPublisher);
    expect(hqPublisherRef.getKanbanSyncStats?.()).toEqual({ pushed: 3 });

    onConnect?.(connectedPublisher);
    expect(hqPublisherRef.current).toBe(connectedPublisher);
    expect(connectedPublisher.publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mcp.health.snapshot', sessionId: 'session-1' }),
    );
    operationHandler?.({ kind: 'call', serverId: 'filesystem' });
    expect(connectedPublisher.publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mcp.operation', sessionId: 'session-1' }),
    );

    onConnect?.(reconnectedPublisher);
    for (const stop of firstStops) expect(stop).toHaveBeenCalledOnce();

    const message = { ts: '2026-08-09T12:00:00.000Z', text: 'ready' };
    eventHandlers.get('agent.timeline.message')?.(message as never);
    eventHandlers.get('agent.status_changed')?.(message as never);
    expect(reconnectedPublisher.publishEvent).toHaveBeenCalledWith({
      type: 'agent.message',
      payload: message,
      timestamp: message.ts,
    });
    expect(reconnectedPublisher.publishEvent).toHaveBeenCalledWith({
      type: 'agent.status',
      payload: message,
      timestamp: message.ts,
    });

    for (const teardown of teardownHandlers) teardown();
    for (const stop of secondStops) expect(stop).toHaveBeenCalledOnce();
    expect(offMessage).toHaveBeenCalledOnce();
    expect(offStatus).toHaveBeenCalledOnce();
    expect(connectionStop).toHaveBeenCalledOnce();
    expect(hqPublisherRef.getKanbanSyncStats).toBeUndefined();
  });
});
