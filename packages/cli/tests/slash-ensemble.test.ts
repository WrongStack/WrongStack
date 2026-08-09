import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @wrongstack/acp so we can drive runEnsemble deterministically.
const mockRunEnsemble = vi.fn();
const mockRenderEnsembleText = vi.fn(
  (result: {
    summary: { succeeded: number; failed: number; skipped: number; cancelled: number };
  }) => {
    return `RENDERED: ok=${result.summary.succeeded} fail=${result.summary.failed} skip=${result.summary.skipped} cancel=${result.summary.cancelled}`;
  },
);

vi.mock('@wrongstack/acp', () => ({
  runEnsemble: mockRunEnsemble,
  renderEnsembleText: mockRenderEnsembleText,
}));

const { buildEnsembleCommand } = await import('../src/slash-commands/ensemble.js');

function ctx(extra: Record<string, unknown> = {}) {
  return {
    renderer: { write: () => {} },
    cwd: '/tmp',
    projectRoot: '/tmp',
    ...extra,
  } as never;
}

function okEnsemble(succeeded = 2, failed = 0, skipped = 0, cancelled = 0) {
  return {
    task: 'do thing',
    requested: ['a', 'b'],
    results: [],
    summary: { succeeded, failed, skipped, cancelled },
  };
}

describe('buildEnsembleCommand', () => {
  beforeEach(() => {
    mockRunEnsemble.mockReset();
    mockRenderEnsembleText.mockClear();
  });

  it('shows usage when no args', async () => {
    const cmd = buildEnsembleCommand(ctx());
    const res = await cmd.run('');
    expect(res?.message).toContain('Usage: /ensemble');
    expect(res?.message).toContain('agent-ids-csv');
    expect(mockRunEnsemble).not.toHaveBeenCalled();
  });

  it('shows usage when only the agent list is given (no task)', async () => {
    const cmd = buildEnsembleCommand(ctx());
    const res = await cmd.run('claude-code,gemini-cli');
    expect(res?.message).toContain('Task description is required');
    expect(mockRunEnsemble).not.toHaveBeenCalled();
  });

  it('rejects empty task after the agent list', async () => {
    const cmd = buildEnsembleCommand(ctx());
    const res = await cmd.run('claude-code,gemini-cli    ');
    expect(res?.message).toContain('Task description is required');
    expect(mockRunEnsemble).not.toHaveBeenCalled();
  });

  it('parses agent csv + task and calls runEnsemble with them', async () => {
    mockRunEnsemble.mockResolvedValueOnce(okEnsemble(2));
    const cmd = buildEnsembleCommand(ctx());
    const res = await cmd.run('claude-code,gemini-cli "review this diff"');
    expect(mockRunEnsemble).toHaveBeenCalledWith({
      agentIds: 'claude-code,gemini-cli',
      task: 'review this diff',
    });
    expect(res?.message).toContain('RENDERED: ok=2 fail=0 skip=0 cancel=0');
  });

  it('handles three+ agents', async () => {
    mockRunEnsemble.mockResolvedValueOnce(okEnsemble(3));
    const cmd = buildEnsembleCommand(ctx());
    await cmd.run('claude-code,gemini-cli,codex-cli "explain v1 protocol"');
    expect(mockRunEnsemble).toHaveBeenCalledWith({
      agentIds: 'claude-code,gemini-cli,codex-cli',
      task: 'explain v1 protocol',
    });
  });

  it('preserves internal spaces in the task description', async () => {
    mockRunEnsemble.mockResolvedValueOnce(okEnsemble(1));
    const cmd = buildEnsembleCommand(ctx());
    await cmd.run('claude-code "fix  the   auth bug  in session.ts"');
    expect(mockRunEnsemble).toHaveBeenCalledWith({
      agentIds: 'claude-code',
      task: 'fix  the   auth bug  in session.ts',
    });
  });

  it('surfaces a per-agent failure summary', async () => {
    mockRunEnsemble.mockResolvedValueOnce(okEnsemble(1, 1, 1));
    const cmd = buildEnsembleCommand(ctx());
    const res = await cmd.run('a,b,c "x"');
    expect(res?.message).toContain('ok=1 fail=1 skip=1');
  });

  it('surfaces a fully-skipped summary (all agents missing)', async () => {
    mockRunEnsemble.mockResolvedValueOnce(okEnsemble(0, 0, 3));
    const cmd = buildEnsembleCommand(ctx());
    const res = await cmd.run('a,b,c "x"');
    expect(res?.message).toContain('ok=0 fail=0 skip=3');
  });

  it('catches runEnsemble throws and returns a readable error', async () => {
    mockRunEnsemble.mockRejectedValueOnce(new Error('boom'));
    const cmd = buildEnsembleCommand(ctx());
    const res = await cmd.run('claude-code "do thing"');
    expect(res?.message).toContain('Ensemble failed');
    expect(res?.message).toContain('boom');
  });

  it('exposes a description and help', () => {
    const cmd = buildEnsembleCommand(ctx());
    expect(cmd.name).toBe('ensemble');
    expect(cmd.category).toBe('Agent');
    expect(cmd.description).toContain('ACP agents');
    expect(cmd.help).toContain('Usage:');
    expect(cmd.help).toContain('claude-code,gemini-cli');
    expect(cmd.help).toContain('wstack acp list');
  });
});
