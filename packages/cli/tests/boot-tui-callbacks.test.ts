import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setDebugStreamCallback: vi.fn(),
  defaultDebugStreamCallback: vi.fn(),
  getActiveSDDContext: vi.fn(),
  trySaveSpecFromAIOutput: vi.fn(),
  trySaveImplementationPlan: vi.fn(),
  trySaveTasksFromAIOutput: vi.fn(),
  autoDetectTaskCompletion: vi.fn(),
  getTaskProgress: vi.fn(),
  getActiveSDDPhase: vi.fn(),
  registryList: vi.fn(),
  registryRoots: [] as string[],
}));

vi.mock('@wrongstack/providers', () => ({
  setDebugStreamCallback: mocks.setDebugStreamCallback,
  defaultDebugStreamCallback: mocks.defaultDebugStreamCallback,
}));

vi.mock('../src/services/sdd-runtime.js', () => ({
  getActiveSDDContext: mocks.getActiveSDDContext,
  trySaveSpecFromAIOutput: mocks.trySaveSpecFromAIOutput,
  trySaveImplementationPlan: mocks.trySaveImplementationPlan,
  trySaveTasksFromAIOutput: mocks.trySaveTasksFromAIOutput,
  autoDetectTaskCompletion: mocks.autoDetectTaskCompletion,
  getTaskProgress: mocks.getTaskProgress,
  getActiveSDDPhase: mocks.getActiveSDDPhase,
}));

vi.mock('@wrongstack/core/storage', () => ({
  SessionRegistry: class {
    constructor(root: string) {
      mocks.registryRoots.push(root);
    }

    list() {
      return mocks.registryList();
    }
  },
  getSessionRegistry: (root: string) => {
    mocks.registryRoots.push(root);
    return { list: () => mocks.registryList() };
  },
}));

import {
  registerDebugStreamCallback,
  restoreDebugStreamCallback,
} from '../src/boot/tui-debug-stream.js';
import { getLiveSessions, onSwitchToSession } from '../src/boot/tui-live-sessions.js';
import { getSDDContext, onSDDOutput } from '../src/boot/tui-sdd-callback.js';

afterEach(() => {
  vi.clearAllMocks();
  mocks.registryRoots.length = 0;
});

describe('TUI boot callbacks', () => {
  it('registers and restores provider debug stream callbacks', async () => {
    const callback = vi.fn();

    await registerDebugStreamCallback(callback);
    await restoreDebugStreamCallback();

    expect(mocks.setDebugStreamCallback).toHaveBeenNthCalledWith(1, callback);
    expect(mocks.setDebugStreamCallback).toHaveBeenNthCalledWith(
      2,
      mocks.defaultDebugStreamCallback,
    );
  });

  it('logs structured register and restore failures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.setDebugStreamCallback
      .mockImplementationOnce(() => {
        throw new Error('register failed');
      })
      .mockImplementationOnce(() => {
        throw 'restore failed';
      });

    await registerDebugStreamCallback(vi.fn());
    await restoreDebugStreamCallback();

    const records = error.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records).toEqual([
      expect.objectContaining({
        level: 'error',
        event: 'execution.debug_stream_register_failed',
        message: 'register failed',
      }),
      expect.objectContaining({
        level: 'error',
        event: 'execution.debug_stream_restore_failed',
        message: 'restore failed',
      }),
    ]);

    mocks.setDebugStreamCallback
      .mockImplementationOnce(() => {
        throw 'register string failure';
      })
      .mockImplementationOnce(() => {
        throw new Error('restore error failure');
      });

    await registerDebugStreamCallback(vi.fn());
    await restoreDebugStreamCallback();
    const additionalRecords = error.mock.calls.slice(2).map(([line]) => JSON.parse(String(line)));
    expect(additionalRecords).toEqual([
      expect.objectContaining({ message: 'register string failure' }),
      expect.objectContaining({ message: 'restore error failure' }),
    ]);
  });

  it('returns the active SDD context', async () => {
    const active = { phase: 'planning' };
    mocks.getActiveSDDContext.mockReturnValue(active);

    await expect(getSDDContext()).resolves.toBe(active);
  });

  it('saves every detected SDD artifact and reports execution progress', async () => {
    mocks.trySaveSpecFromAIOutput.mockResolvedValue(true);
    mocks.trySaveImplementationPlan.mockReturnValue(true);
    mocks.trySaveTasksFromAIOutput.mockResolvedValue(true);
    mocks.getActiveSDDPhase.mockReturnValue('executing');
    mocks.autoDetectTaskCompletion.mockReturnValue(2);
    mocks.getTaskProgress
      .mockReturnValueOnce({ total: 5 })
      .mockReturnValueOnce({ completed: 2, total: 5, percentComplete: 40 });

    await expect(onSDDOutput('assistant output')).resolves.toEqual([
      '✓ Spec detected and saved! Use /sdd approve to continue.',
      '✓ Implementation plan saved!',
      '✓ 5 tasks detected and saved! Use /sdd approve to execute.',
      '✓ 2 task(s) auto-completed! Progress: 2/5 (40%)',
    ]);
  });

  it('handles absent SDD artifacts, progress, and completion', async () => {
    mocks.trySaveSpecFromAIOutput.mockResolvedValue(false);
    mocks.trySaveImplementationPlan.mockReturnValue(false);
    mocks.trySaveTasksFromAIOutput
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    mocks.getTaskProgress.mockReturnValue(undefined);
    mocks.getActiveSDDPhase
      .mockReturnValueOnce('planning')
      .mockReturnValueOnce('executing')
      .mockReturnValueOnce('executing');
    mocks.autoDetectTaskCompletion.mockReturnValueOnce(0).mockReturnValueOnce(1);

    await expect(onSDDOutput('tasks only')).resolves.toEqual([
      '✓ 0 tasks detected and saved! Use /sdd approve to execute.',
    ]);
    await expect(onSDDOutput('no completion')).resolves.toEqual([]);
    await expect(onSDDOutput('completion without progress')).resolves.toEqual([]);
  });

  it('filters stale live sessions and projects agent details', async () => {
    const active = {
      sessionId: 'session-1',
      projectName: 'Project',
      projectSlug: 'project',
      projectRoot: 'C:/project',
      workingDir: 'C:/project/work',
      gitBranch: 'main',
      status: 'live',
      pid: 123,
      startedAt: '2026-01-01T00:00:00.000Z',
      agentCount: 1,
      agents: [
        {
          id: 'agent-1',
          name: 'Agent',
          status: 'running',
          currentTool: 'read',
          iterations: 2,
          toolCalls: 3,
          lastActivityAt: '2026-01-01T00:01:00.000Z',
          ignored: true,
        },
      ],
      ignored: true,
    };
    mocks.registryList.mockResolvedValue([
      active,
      { ...active, sessionId: 'stale', status: 'stale' },
    ]);
    const state = {
      wpaths: { globalConfig: path.join('C:/global', 'config.json') },
    };

    await expect(getLiveSessions({ state } as never)).resolves.toEqual([
      {
        sessionId: 'session-1',
        projectName: 'Project',
        projectSlug: 'project',
        projectRoot: 'C:/project',
        workingDir: 'C:/project/work',
        gitBranch: 'main',
        status: 'live',
        pid: 123,
        startedAt: '2026-01-01T00:00:00.000Z',
        agentCount: 1,
        agents: [
          {
            id: 'agent-1',
            name: 'Agent',
            status: 'running',
            currentTool: 'read',
            iterations: 2,
            toolCalls: 3,
            lastActivityAt: '2026-01-01T00:01:00.000Z',
          },
        ],
      },
    ]);
    expect(mocks.registryRoots).toEqual([path.dirname(state.wpaths.globalConfig)]);
  });

  it('records a fresh project switch without resuming the live session', () => {
    const state = { pendingProjectSwitch: null };

    onSwitchToSession({ state } as never, 'ignored-live-session', 'C:/target', 'Target');

    expect(state.pendingProjectSwitch).toEqual({
      root: 'C:/target',
      name: 'Target',
    });
  });
});
