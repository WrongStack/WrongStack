import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSnapshotGate,
  registerSetupEventsFleetBroadcaster,
} from '../src/server/setup-events-fleet-broadcaster.js';

const mocks = vi.hoisted(() => {
  const mockList = vi.fn();
  const mockSubscribeProject = vi.fn();
  const mockGetSessionRegistry = vi.fn(() => ({
    list: mockList,
    subscribeProject: mockSubscribeProject,
  }));
  return {
    mockList,
    mockSubscribeProject,
    mockGetSessionRegistry,
  };
});

vi.mock('@wrongstack/core/storage', () => ({
  getSessionRegistry: mocks.mockGetSessionRegistry,
}));

describe('registerSetupEventsFleetBroadcaster', () => {
  beforeEach(() => {
    mocks.mockList.mockReset();
    mocks.mockSubscribeProject.mockReset();
    mocks.mockSubscribeProject.mockResolvedValue(vi.fn().mockResolvedValue(undefined));
  });

  it('returns undefined if globalConfigPath is undefined', () => {
    const result = registerSetupEventsFleetBroadcaster({
      globalConfigPath: undefined,
      context: { projectRoot: '/project' } as never,
      clients: new Map(),
      broadcast: vi.fn(),
      isDisposed: () => false,
    });
    expect(result).toBeUndefined();
  });

  it('broadcasts filtered active/idle sessions and maps agents correctly', async () => {
    const broadcast = vi.fn();
    const clients = new Map();
    let onFleetCallback: (() => Promise<void>) | undefined;
    let subscribeCallback: (() => void) | undefined;
    const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);

    mocks.mockSubscribeProject.mockImplementation(
      async (_slug: string, _root: string, cb: () => void) => {
        subscribeCallback = cb;
        return mockUnsubscribe;
      },
    );

    const testSessions = [
      {
        sessionId: 'sess-own',
        projectName: 'My Project',
        projectSlug: 'my-project',
        projectRoot: '/project',
        workingDir: '/project/src',
        gitBranch: 'main',
        clientType: 'webui',
        status: 'active',
        pid: process.pid,
        startedAt: 1000,
        lastHeartbeatAt: 2000,
        agentCount: 1,
        agents: [
          {
            id: 'agent-1',
            name: 'Coder',
            status: 'working',
            currentTool: 'edit',
            currentTask: 'fix bug',
            taskId: 'task-1',
            iterations: 2,
            toolCalls: 5,
            costUsd: 0.05,
            tokensIn: 100,
            tokensOut: 200,
            ctxPct: 40,
            model: 'gpt-4o',
            partialText: 'thinking',
            recentTools: ['edit'],
            recentMail: [],
            todos: [],
            latestPrompt: 'fix this',
            latestPromptAt: 1500,
            activity: 'active',
            lastActivityAt: 1900,
          },
        ],
      },
      {
        sessionId: 'sess-other-project',
        projectName: 'Other Project',
        projectSlug: 'other-project',
        projectRoot: '/other',
        status: 'active',
        pid: 99999,
      },
      {
        sessionId: 'sess-terminated',
        projectName: 'My Project',
        projectSlug: 'my-project',
        projectRoot: '/project',
        status: 'terminated',
        pid: 88888,
      },
    ];

    mocks.mockList.mockResolvedValue(testSessions);

    const dispose = registerSetupEventsFleetBroadcaster({
      globalConfigPath: path.join('/fake', 'root', 'config.json'),
      wpaths: { projectSlug: 'my-project' } as never,
      context: { projectRoot: '/project' } as never,
      clients,
      broadcast,
      onFleetBroadcaster: (fn) => {
        onFleetCallback = fn;
      },
      isDisposed: () => false,
    });

    expect(dispose).toBeDefined();

    // Allow initial broadcastSessions and subscribeProject to complete
    await new Promise((resolve) => setTimeout(resolve, 50));
    await onFleetCallback?.();

    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'sessions.status_update',
      payload: {
        sessions: [
          expect.objectContaining({
            sessionId: 'sess-own',
            projectSlug: 'my-project',
            status: 'active',
            agentCount: 1,
            agents: [expect.objectContaining({ id: 'agent-1', name: 'Coder' })],
          }),
        ],
      },
    });

    // Test onFleetBroadcaster trigger
    broadcast.mockClear();
    await onFleetCallback?.();
    expect(broadcast).toHaveBeenCalledWith(clients, expect.anything());

    // Test subscription event debounced trigger (a snapshot with news goes out at once)
    broadcast.mockClear();
    mocks.mockList.mockResolvedValue([{ ...testSessions[0], status: 'idle' }]);
    subscribeCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(broadcast).toHaveBeenCalledWith(clients, expect.anything());

    // Test dispose
    dispose?.();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it('filters by projectRoot when projectSlug is not available', async () => {
    const broadcast = vi.fn();
    const resolvedRoot = path.resolve('/matched/project');

    const matchedList = [
      {
        sessionId: 'sess-matched',
        projectName: 'Matched',
        projectRoot: resolvedRoot,
        workingDir: resolvedRoot,
        status: 'idle',
        pid: 12345,
        startedAt: 1000,
        lastHeartbeatAt: 2000,
        agentCount: 0,
        agents: [],
      },
      {
        sessionId: 'sess-different',
        projectName: 'Different',
        projectRoot: '/different/dir',
        status: 'idle',
        pid: 12346,
      },
    ];
    mocks.mockList.mockResolvedValue(matchedList);

    let onFleetCallback: (() => Promise<void>) | undefined;
    const dispose = registerSetupEventsFleetBroadcaster({
      globalConfigPath: path.join('/fake', 'root', 'config.json'),
      wpaths: undefined,
      context: { projectRoot: resolvedRoot } as never,
      clients: new Map(),
      broadcast,
      onFleetBroadcaster: (fn) => {
        onFleetCallback = fn;
      },
      isDisposed: () => false,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await onFleetCallback?.();

    expect(broadcast).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'sessions.status_update',
        payload: {
          sessions: [
            expect.objectContaining({
              sessionId: 'sess-matched',
              agents: [],
            }),
          ],
        },
      }),
    );

    dispose?.();
  });

  it('handles list errors gracefully', async () => {
    const resolvedRoot = path.resolve('/matched/project');
    // Every read fails: registration fires its own initial broadcast, so a
    // `…Once` rejection was consumed there and the callback read succeeded.
    mocks.mockList.mockRejectedValue(new Error('Registry read failure'));
    let onFleetCallback: (() => Promise<void>) | undefined;
    const broadcast = vi.fn();
    const dispose = registerSetupEventsFleetBroadcaster({
      globalConfigPath: path.join('/fake', 'root', 'config.json'),
      context: { projectRoot: resolvedRoot } as never,
      clients: new Map(),
      broadcast,
      onFleetBroadcaster: (fn) => {
        onFleetCallback = fn;
      },
      isDisposed: () => false,
    });

    expect(onFleetCallback).toBeTypeOf('function');
    // Imports issued during registration can resolve to the real core module
    // (it read a non-existent /fake root and broadcast `[]`), so the old test
    // never reached the mocked failing `list`. Settle, drop that startup
    // broadcast, then exercise the error path through the mock.
    await new Promise((resolve) => setTimeout(resolve, 50));
    broadcast.mockClear();
    mocks.mockList.mockClear();
    await expect(onFleetCallback?.()).resolves.toBeUndefined();
    expect(mocks.mockList).toHaveBeenCalled();
    // A registry read failure must not push a (wrong, empty) status update.
    expect(broadcast).not.toHaveBeenCalled();
    dispose?.();
  });

  it('the snapshot gate drops beats that only moved heartbeats, but never news or a ping', () => {
    const shouldSend = createSnapshotGate(10_000);
    const session = (beat: number, status = 'idle') => ({
      sessionId: 's',
      status,
      lastHeartbeatAt: beat,
    });
    expect(shouldSend([session(1000)], { now: 0 })).toBe(true);
    // Heartbeats every few seconds: only the beat time moved.
    expect(shouldSend([session(6000)], { now: 5000 })).toBe(false);
    expect(shouldSend([session(9000)], { now: 9000 })).toBe(false);
    // Real news goes out at once.
    expect(shouldSend([session(9500, 'active')], { now: 9500 })).toBe(true);
    // An explicit ping is always answered.
    expect(shouldSend([session(9600, 'active')], { now: 9600, force: true })).toBe(true);
    // An unchanged snapshot is still re-sent once the window has passed, as a keepalive.
    expect(shouldSend([session(15000, 'active')], { now: 15000 })).toBe(false);
    expect(shouldSend([session(20000, 'active')], { now: 19700 })).toBe(true);
  });

  it('bails out early if disposed', async () => {
    const disposed = true;
    const broadcast = vi.fn();
    // A readable registry, so a missing disposal guard WOULD broadcast.
    mocks.mockList.mockResolvedValue([]);
    let onFleetCallback: (() => Promise<void>) | undefined;
    const dispose = registerSetupEventsFleetBroadcaster({
      globalConfigPath: path.join('/fake', 'root', 'config.json'),
      context: { projectRoot: '/project' } as never,
      clients: new Map(),
      broadcast,
      onFleetBroadcaster: (fn) => {
        onFleetCallback = fn;
      },
      isDisposed: () => disposed,
    });

    // Await the broadcast path itself instead of racing a short sleep against
    // the registration-time import (which let this pass with no guard at all).
    await new Promise((resolve) => setTimeout(resolve, 50));
    await onFleetCallback?.();
    expect(broadcast).not.toHaveBeenCalled();
    expect(mocks.mockList).not.toHaveBeenCalled();
    dispose?.();
  });
});
