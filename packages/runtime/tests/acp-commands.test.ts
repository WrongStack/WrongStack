import { beforeEach, describe, expect, it, vi } from 'vitest';

const runOneAcpTask = vi.fn(async (..._args: unknown[]) => ({
  result: 'explained',
  iterations: 2,
  toolCalls: 1,
}));
vi.mock('@wrongstack/acp', () => ({
  resolveAcpAgentCommand: () => ({ command: 'gemini', args: ['--acp'] }),
  runOneAcpTask: (...args: unknown[]) => runOneAcpTask(...args),
  defaultPermissionPolicy: { evaluate: () => ({ permission: 'auto' }) },
}));

const { buildAcpCommand } = await import('../src/portable-commands/acp.js');

const quiet = { write: () => {}, writeInfo: () => {}, writeWarning: () => {} };
const tab = { eventSessionId: () => 'tab-2' } as never;

describe('/acp on an engine', () => {
  beforeEach(() => runOneAcpTask.mockClear());

  it('runs a task in the fleet when no terminal shows its progress', async () => {
    const onSpawn = vi.fn(async () => 'Spawned subagent w1');
    const acp = buildAcpCommand({
      renderer: quiet,
      projectRoot: '/p',
      cwd: '/p',
      onSpawn,
      inlineAcpRuns: false,
    });
    const result = await acp.run('gemini-cli "explain x"', tab);
    expect(onSpawn).toHaveBeenCalledWith('explain x', { provider: 'acp', name: 'gemini-cli' });
    expect(runOneAcpTask).not.toHaveBeenCalled();
    expect(result?.message).toContain('background ACP subagent');
  });

  it('runs inline with the asking conversation and the host’s bridge otherwise', async () => {
    const setup = vi.fn(() => undefined);
    const acp = buildAcpCommand({
      renderer: quiet,
      projectRoot: '/p',
      cwd: '/p',
      inlineAcpRuns: false,
      acpSessionSetup: setup,
    });
    const result = await acp.run('gemini-cli "explain x"', tab);
    expect(setup).toHaveBeenCalledWith('gemini-cli', '/p', undefined);
    expect(runOneAcpTask).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'explain x', sessionId: 'tab-2', cwd: '/p' }),
    );
    expect(result?.message).toContain('=== gemini-cli ===\nexplained');
  });
});
