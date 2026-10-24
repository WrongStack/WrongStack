import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, SubagentRunContext } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/core/coordination';
import { describe, expect, it, vi } from 'vitest';
import {
  acpCommandOpts,
  type HostAcpRunnerHost,
  spawnACP,
} from '../../src/fleet/host-acp-runner.js';

function harness() {
  const order: string[] = [];
  const events = new EventBus();
  const emit = vi.spyOn(events, 'emit');
  const getConfig = vi.fn<() => Pick<Config, 'acp'> | undefined>();
  const runner = vi.fn<Awaited<ReturnType<HostAcpRunnerHost['buildACPRunner']>>>();
  const coordinator = {
    setRunner: vi.fn(() => {
      order.push('set-runner');
    }),
    spawn: vi.fn(async () => {
      order.push('spawn');
    }),
    assign: vi.fn(async () => {
      order.push('assign');
    }),
  };
  const host: HostAcpRunnerHost = {
    deps: { events, configStore: { get: getConfig } } as unknown as HostAcpRunnerHost['deps'],
    getDirector: vi.fn<HostAcpRunnerHost['getDirector']>(),
    ensureCoordinator: vi.fn(async () => {
      order.push('ensure');
    }),
    getCoordinator: () => coordinator as unknown as ReturnType<HostAcpRunnerHost['getCoordinator']>,
    buildACPRunner: vi.fn(async () => {
      order.push('build-runner');
      return runner;
    }),
    recordLearningRole: vi.fn(() => {
      order.push('learning-role');
    }),
    directorRunnerSet: false,
    sessionForSubagent: vi.fn(() => 'spawn-owner-session'),
  };
  return { host, events, emit, getConfig, runner, coordinator, order };
}

describe('ACP command options', () => {
  it('uses the current configured agent command overrides', () => {
    const h = harness();
    const overrides = { 'fixture-agent': { command: 'fixture-acp', args: ['--acp'] } };
    h.getConfig.mockReturnValue({ acp: { agents: overrides } });
    expect(acpCommandOpts.call(h.host).overrides).toBe(overrides);
    h.getConfig.mockReturnValue({});
    expect(acpCommandOpts.call(h.host)).not.toHaveProperty('overrides');
  });

  it('provides live progress even when reading configuration fails', () => {
    const h = harness();
    h.getConfig.mockImplementation(() => {
      throw new Error('config unavailable');
    });
    const options = acpCommandOpts.call(h.host);
    expect(options).not.toHaveProperty('overrides');
    expect(options.publishLive).toBeTypeOf('function');
  });

  it.each([
    { name: 'Named worker', role: 'reviewer', expected: 'Named worker' },
    { role: 'reviewer', expected: 'reviewer' },
    { expected: 'worker-1' },
  ])('attributes live tool progress to $expected and the worker session', (names) => {
    const h = harness();
    const fleet = { emit: vi.fn() };
    vi.mocked(h.host.getDirector).mockReturnValue({ fleet } as unknown as Director);
    const ctx = {
      subagentId: 'worker-1',
      sessionId: 'worker-owner-session',
      config: {
        ...('name' in names ? { name: names.name } : {}),
        ...('role' in names ? { role: names.role } : {}),
      },
    } as SubagentRunContext;
    const publish = acpCommandOpts.call(h.host).publishLive!;
    publish(
      ctx,
      { id: 'task-1', description: 'Inspect the change' },
      {
        type: 'tool_call',
        toolCall: {
          toolCallId: 'call-1',
          title: 'Read file',
          kind: 'read',
          status: 'in_progress',
          rawInput: { path: 'src/app.ts' },
        },
      },
    );
    expect(h.emit).toHaveBeenCalledWith('subagent.tool_started', {
      sessionId: 'worker-owner-session',
      subagentId: 'worker-1',
      agentName: names.expected,
      taskId: 'task-1',
      id: 'call-1',
      name: 'Read file',
      input: { path: 'src/app.ts' },
    });
    expect(fleet.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        subagentId: 'worker-1',
        taskId: 'task-1',
        type: 'tool.started',
      }),
    );
  });

  it('publishes host progress when the director is not available', () => {
    const h = harness();
    acpCommandOpts.call(h.host).publishLive!(
      { subagentId: 'worker-1', config: {}, sessionId: 'worker-session' } as SubagentRunContext,
      { id: 'task-1', description: 'Inspect the change' },
      { type: 'diff', diff: { path: 'src/app.ts', oldText: null, newText: 'new file' } },
    );
    expect(h.emit).toHaveBeenCalledWith(
      'file.activity',
      expect.objectContaining({
        filePath: 'src/app.ts',
        operation: 'write',
        sessionId: 'worker-session',
        agentId: 'worker-1',
      }),
    );
  });
});

describe('spawnACP', () => {
  it('prepares the runner, spawns and assigns before announcing the roster session', async () => {
    const h = harness();
    const config = { provider: 'fixture-provider', model: 'fixture-model' } as Config;
    const taskId = await spawnACP.call(h.host, 'fixture-agent', 'Review the change', config);
    expect(taskId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(h.order).toEqual([
      'ensure',
      'build-runner',
      'learning-role',
      'set-runner',
      'spawn',
      'assign',
    ]);
    expect(h.host.ensureCoordinator).toHaveBeenCalledWith(config);
    expect(h.host.buildACPRunner).toHaveBeenCalledWith('fixture-agent');
    expect(h.host.recordLearningRole).toHaveBeenCalledWith('fixture-agent', 'fixture-agent');
    expect(h.coordinator.setRunner).toHaveBeenCalledWith(h.runner);
    expect(h.host.directorRunnerSet).toBe(true);
    expect(h.coordinator.spawn).toHaveBeenCalledWith({
      id: 'fixture-agent',
      name: 'fixture-agent',
      role: 'fixture-agent',
      provider: 'acp',
    });
    expect(h.coordinator.assign).toHaveBeenCalledWith({
      id: taskId,
      description: 'Review the change',
    });
    expect(h.host.sessionForSubagent).toHaveBeenCalledWith('fixture-agent');
    expect(h.emit).toHaveBeenCalledWith('subagent.spawned', {
      sessionId: 'spawn-owner-session',
      subagentId: 'fixture-agent',
      taskId,
      name: 'fixture-agent',
      provider: 'acp',
      model: undefined,
      description: 'Review the change',
    });
    expect(h.emit.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.coordinator.assign.mock.invocationCallOrder[0]!,
    );
  });

  it.each(['ensure', 'build-runner', 'spawn', 'assign'] as const)(
    'propagates a %s failure without announcing a successful spawn',
    async (stage) => {
      const h = harness();
      const failed = {
        ensure: vi.mocked(h.host.ensureCoordinator),
        'build-runner': vi.mocked(h.host.buildACPRunner),
        spawn: h.coordinator.spawn,
        assign: h.coordinator.assign,
      }[stage];
      failed.mockRejectedValueOnce(new Error(`${stage} unavailable`));
      await expect(spawnACP.call(h.host, 'fixture-agent', 'Review', {} as Config)).rejects.toThrow(
        `${stage} unavailable`,
      );
      expect(h.emit).not.toHaveBeenCalled();
      expect(h.host.sessionForSubagent).not.toHaveBeenCalled();
      if (stage !== 'assign') expect(h.coordinator.assign).not.toHaveBeenCalled();
      if (stage === 'ensure' || stage === 'build-runner') {
        expect(h.coordinator.setRunner).not.toHaveBeenCalled();
        expect(h.coordinator.spawn).not.toHaveBeenCalled();
        expect(h.host.directorRunnerSet).toBe(false);
      }
    },
  );
});
