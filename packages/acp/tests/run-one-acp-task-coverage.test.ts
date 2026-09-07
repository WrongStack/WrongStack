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

  it('forwards sessionId when provided', async () => {
    mocks.runner.mockResolvedValueOnce({ result: 'done', iterations: 1, toolCalls: 1 });
    mocks.stop.mockResolvedValueOnce(undefined);
    mocks.makeRunner.mockResolvedValueOnce({ runner: mocks.runner, stop: mocks.stop });

    const out = await runOneAcpTask({
      command: 'agent',
      projectRoot: '/project',
      role: 'coder',
      task: 'code something',
      sessionId: 'custom-session-123' as any,
    });
    expect(out.result).toBe('done');
    expect(mocks.runner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'custom-session-123' }),
    );
  });
});
