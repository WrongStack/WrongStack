import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createApprovalRegistry: vi.fn(() => ({
    list: vi.fn(() => []),
    resolve: vi.fn(() => false),
    dispose: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  })),
  startApprovalTelemetryBridge: vi.fn(),
  createHqCommandDispatcher: vi.fn(),
  createProjectKanbanAssignHandler: vi.fn(),
  createProjectKanbanTransitionHandler: vi.fn(),
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
  createApprovalRegistry: mocks.createApprovalRegistry,
  startApprovalTelemetryBridge: mocks.startApprovalTelemetryBridge,
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
  createProjectKanbanAssignHandler: mocks.createProjectKanbanAssignHandler,
  createProjectKanbanTransitionHandler: mocks.createProjectKanbanTransitionHandler,
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
    const initialPublisher = { publishEvent: vi.fn(), onConnected: vi.fn(() => vi.fn()) };
    const connectedPublisher = { publishEvent: vi.fn(), onConnected: vi.fn(() => vi.fn()) };
    const reconnectedPublisher = { publishEvent: vi.fn(), onConnected: vi.fn(() => vi.fn()) };
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
    const kanbanTransition = vi.fn();
    const kanbanAssign = vi.fn();
    mocks.createHqCommandDispatcher.mockReturnValue(hqOnCommand);
    mocks.createProjectKanbanTransitionHandler.mockReturnValue(kanbanTransition);
    mocks.createProjectKanbanAssignHandler.mockReturnValue(kanbanAssign);

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
      // Use the HOST path separator so path.basename() behaves identically on
      // every platform: a Windows-style literal ('D:\\work\\repo') is only one
      // path segment to Linux's basename (no '\\' separator there), which
      // previously made this assertion platform-dependent (CI is Linux).
      projectRoot: path.join('/work', 'repo'),
      globalRoot: path.join('/global'),
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
        projectRoot: path.join('/work', 'repo'),
        projectName: 'repo',
        onCommand: hqOnCommand,
        capabilities: expect.arrayContaining(['control.receive', 'kanban.dispatch']),
      }),
    );
    expect(result.hqOnCommand).toBe(hqOnCommand);
    expect(result.hqCommandController.sessionTag()).toBe('tag:session-1');
    expect(result.hqCommandController.allowRunCommand()).toBe(true);
    // Kanban handlers are resolved against the LIVE project root per command.
    void result.hqCommandController.kanbanTransition?.({ taskId: 't' } as never);
    void result.hqCommandController.kanbanAssign?.({ taskId: 't' } as never);
    expect(kanbanTransition).toHaveBeenCalledWith({ taskId: 't' });
    expect(kanbanAssign).toHaveBeenCalledWith({ taskId: 't' });
    expect(mocks.createProjectKanbanAssignHandler).toHaveBeenCalledWith(path.join('/work', 'repo'));
    expect(mocks.createProjectKanbanTransitionHandler).toHaveBeenCalledWith(
      path.join('/work', 'repo'),
    );
    expect(hqPublisherRef.current).toBe(initialPublisher);
    expect(hqPublisherRef.getKanbanSyncStats?.()).toEqual({ pushed: 3 });

    onConnect?.(connectedPublisher);
    expect(hqPublisherRef.current).toBe(connectedPublisher);
    expect(connectedPublisher.publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mcp.health.snapshot', sessionId: 'session-1' }),
    );
    // HQ keeps MCP health per socket: it must be re-seeded on every reconnect.
    expect(connectedPublisher.onConnected).toHaveBeenCalledOnce();
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

  it('re-binds session bridges when the live writer changes and reconnects on a project switch', () => {
    vi.useFakeTimers();
    try {
      const events = { on: vi.fn(() => () => undefined) };
      const publisherA = { publishEvent: vi.fn(), onConnected: vi.fn(() => vi.fn()) };
      const publisherB = { publishEvent: vi.fn(), onConnected: vi.fn(() => vi.fn()) };
      const connections: Array<{ stop: ReturnType<typeof vi.fn>; root: string }> = [];
      mocks.startCliHqConnection.mockImplementation((options) => {
        const publisher = connections.length === 0 ? publisherA : publisherB;
        const connection = {
          root: options.projectRoot as string,
          stop: vi.fn(),
          getPublisher: () => publisher,
          getKanbanSyncStats: () => undefined,
        };
        connections.push(connection);
        options.onConnect(publisher);
        return connection;
      });
      mocks.createHqCommandDispatcher.mockReturnValue(vi.fn());
      for (const bridge of [
        mocks.startSessionTelemetryBridge,
        mocks.startFleetTelemetryBridge,
        mocks.startGovernanceHqTelemetry,
        mocks.startBrainTelemetryBridge,
        mocks.startWorktreeTelemetryBridge,
        mocks.startToolTelemetryBridge,
        mocks.startCostTelemetryBridge,
        mocks.startApprovalTelemetryBridge,
      ]) {
        bridge.mockImplementation(() => vi.fn());
      }
      const live = { session: { id: 'boot' }, root: path.join('/work', 'repo') };
      const teardownHandlers: Array<() => void> = [];
      const result = setupHqTelemetry({
        events: events as never,
        session: { id: 'boot' } as never,
        config: {} as never,
        flags: {},
        tuiOwnsScreen: true,
        projectRoot: live.root,
        globalRoot: path.join('/global'),
        tracker: undefined,
        agentMonitor: undefined,
        brainMailbox: {} as never,
        teardownHandlers,
        mailboxSessionTag: (id) => `tag:${id}`,
        hqPublisherRef: { current: undefined } as never,
        mcpRegistry: {
          operationalHealth: () => [],
          onOperation: () => () => undefined,
        } as never,
        liveSession: () => live.session as never,
        liveProjectRoot: () => live.root,
        scopeCheckIntervalMs: 100,
      });

      const sessionIds = () =>
        mocks.startSessionTelemetryBridge.mock.calls.map(
          (call) => (call[0] as { sessionId: string }).sessionId,
        );
      expect(sessionIds()).toEqual(['boot']);

      // `/resume` swaps the writer: bridges follow within one tick, and the
      // old session bridge is stopped (which publishes session.ended).
      const bootSessionStop = mocks.startSessionTelemetryBridge.mock.results[0]
        ?.value as ReturnType<typeof vi.fn>;
      live.session = { id: 'resumed' };
      vi.advanceTimersByTime(150);
      expect(sessionIds()).toEqual(['boot', 'resumed']);
      expect(bootSessionStop).toHaveBeenCalledOnce();
      expect(result.hqCommandController.sessionId?.()).toBe('resumed');
      expect(result.hqCommandController.sessionTag()).toBe('tag:resumed');
      expect(connections).toHaveLength(1);

      // An in-place project switch changes the publisher identity: the old
      // connection is stopped and a new one carries the new project.
      live.root = path.join('/work', 'other');
      live.session = { id: 'fresh' };
      vi.advanceTimersByTime(150);
      expect(connections).toHaveLength(2);
      expect(connections[0]?.stop).toHaveBeenCalledOnce();
      expect(connections[1]?.root).toBe(path.join('/work', 'other'));
      expect(sessionIds().at(-1)).toBe('fresh');

      for (const teardown of teardownHandlers) teardown();
      expect(connections[1]?.stop).toHaveBeenCalledOnce();
      // No further re-scoping after teardown.
      live.session = { id: 'after-teardown' };
      vi.advanceTimersByTime(500);
      expect(sessionIds()).not.toContain('after-teardown');
    } finally {
      vi.useRealTimers();
    }
  });
});
