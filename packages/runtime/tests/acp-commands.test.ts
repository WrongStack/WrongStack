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
  REGISTRY_ID_ALIASES: {},
}));

const { buildAcpCommand } = await import('../src/portable-commands/acp.js');
const { buildDelegateCommand } = await import('../src/portable-commands/delegate.js');

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

  it('forwards originSessionId for background single/parallel ACP runs and preserves hyphen flags in /delegate task', async () => {
    const onSpawn = vi.fn(async () => 'Spawned subagent w2');
    const acp = buildAcpCommand({
      renderer: quiet,
      projectRoot: '/p',
      cwd: '/p',
      onSpawn,
      inlineAcpRuns: false,
    });
    const sessionCtx = { session: { id: 'tab-7' } } as never;
    await acp.run('gemini-cli --bg "explain x"', sessionCtx);
    expect(onSpawn).toHaveBeenCalledWith('explain x', {
      provider: 'acp',
      name: 'gemini-cli',
      originSessionId: 'tab-7',
    });

    await acp.run('parallel gemini-cli "explain parallel"', sessionCtx);
    expect(onSpawn).toHaveBeenCalledWith('explain parallel', {
      provider: 'acp',
      name: 'gemini-cli',
      originSessionId: 'tab-7',
    });

    const onDispatchClassify = vi.fn(async () => ({
      role: 'debugger',
      confidence: 0.9,
      reason: 'test',
    }));
    const delegate = buildDelegateCommand({
      renderer: quiet,
      onDispatchClassify,
      onFleetSpawn: async () => 'w-del',
    });
    await delegate.run('--name="My Worker" fix -v and --frozen-lockfile flags', sessionCtx);
    expect(onDispatchClassify).toHaveBeenCalledWith(
      'fix -v and --frozen-lockfile flags',
      expect.any(Array),
    );
  });

  it('filters malformed entries in loadCachedAcpRegistry and guards non-finite usage in summarizeVariantUsage (F156)', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { loadCachedAcpRegistry } = await import(
      '../src/portable-commands/acp-registry-cache.js'
    );
    const { formatAcpAgentList } = await import('../src/portable-commands/acp-agent-list.js');
    const { summarizeVariantUsage } = await import('../src/portable-commands/scout-stats.js');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-f156-'));
    try {
      await fs.writeFile(
        path.join(tmpDir, 'acp-registry.json'),
        JSON.stringify({
          fetchedAt: '2026-11-08T00:00:00Z',
          agents: [
            null,
            { id: 'broken', displayName: 'Broken' },
            {
              id: 'codex',
              displayName: 'Codex',
              acp: { command: 'npx', args: ['-y', '@openai/codex'] },
            },
          ],
        }),
        'utf8',
      );
      const loaded = await loadCachedAcpRegistry({ cacheDir: tmpDir } as never);
      expect(loaded?.agents).toHaveLength(1);
      expect(formatAcpAgentList({ live: loaded, detected: [] })).toContain('Codex');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
    const usage = summarizeVariantUsage([
      [
        { type: 'user_input', ts: 't', text: 'hi' } as never,
        { type: 'llm_request', ts: 't', systemVariant: 'scout' } as never,
        { type: 'llm_response', ts: 't', usage: { input: 100, output: 50 } } as never,
        { type: 'llm_response', ts: 't', usage: { input: undefined, output: Number.NaN } } as never,
      ],
    ]);
    expect(usage[0]?.inputTokens).toBe(100);
    expect(usage[0]?.outputTokens).toBe(50);
  });
});
