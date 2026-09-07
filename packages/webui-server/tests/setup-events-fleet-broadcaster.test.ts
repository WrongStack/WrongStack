import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSetupEventsFleetBroadcaster } from '../src/server/setup-events-fleet-broadcaster.js';

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

    // Test subscription event debounced trigger
    broadcast.mockClear();
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
    mocks.mockList.mockRejectedValueOnce(new Error('Registry read failure'));
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

    await onFleetCallback?.();
    dispose?.();
  });

  it('bails out early if disposed', async () => {
    let disposed = true;
    const dispose = registerSetupEventsFleetBroadcaster({
      globalConfigPath: path.join('/fake', 'root', 'config.json'),
      context: { projectRoot: '/project' } as never,
      clients: new Map(),
      broadcast: vi.fn(),
      isDisposed: () => disposed,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    dispose?.();
  });
});
