import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeRunner: vi.fn(),
  runner: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../src/integration/acp-subagent-runner.js', () => ({
  makeACPSubagentRunnerWithStop: mocks.makeRunner,
}));

import { runOneAcpTask } from '../src/integration/run-one-acp-task.js';

describe('runOneAcpTask option coverage', () => {
  it('forwards every option, normalizes null output, and tolerates teardown failure', async () => {
    mocks.runner.mockResolvedValueOnce({ result: null, iterations: 2, toolCalls: 3 });
    mocks.stop.mockRejectedValueOnce(new Error('already stopped'));
    mocks.makeRunner.mockResolvedValueOnce({ runner: mocks.runner, stop: mocks.stop });
    const controller = new AbortController();
    const onProgress = vi.fn();
    const permissionPolicy = vi.fn();

    await expect(
      runOneAcpTask({
        command: 'agent',
        args: ['--acp'],
        env: { TOKEN: 'redacted' },
        cwd: '/work',
        projectRoot: '/project',
        role: 'reviewer',
        task: 'review this',
        timeoutMs: 1234,
        signal: controller.signal,
        onProgress,
        permissionPolicy,
      }),
    ).resolves.toEqual({ result: '', iterations: 2, toolCalls: 3 });

    expect(mocks.makeRunner).toHaveBeenCalledWith({
      command: 'agent',
      args: ['--acp'],
      env: { TOKEN: 'redacted' },
      cwd: '/work',
      projectRoot: '/project',
      role: 'reviewer',
      timeoutMs: 1234,
      onProgress,
      permissionPolicy,
    });
    expect(mocks.runner).toHaveBeenCalledWith(
      { id: 'acp-reviewer', description: 'review this' },
      expect.objectContaining({ signal: controller.signal, subagentId: 'reviewer' }),
    );
  });
});
