import {
  AGENTS_CATALOG,
  filterMcpServers,
  findAgentDescriptor,
  REGISTRY_ID_ALIASES,
  resolveAcpClientProfile,
} from '@wrongstack/acp';
import type { SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import { SubagentBudget, subagentNeedsWorktree } from '@wrongstack/coordination';
import { describe, expect, it } from 'vitest';
import { wrongstackBridgeSetup } from '../src/acp-wrongstack-bridge.js';

function makeCtx(overrides: Partial<SubagentRunContext> = {}): SubagentRunContext {
  return {
    subagentId: 'worker-1',
    sessionId: 'sess-42',
    config: {
      id: 'worker-1',
      name: 'worker-1',
      role: 'executor',
      provider: 'acp',
      prompt: '',
    },
    budget: new SubagentBudget({ timeoutMs: 60_000, maxIterations: 10, maxToolCalls: 10 }),
    signal: new AbortController().signal,
    bridge: null,
    ...overrides,
  };
}

describe('P1.1 & P1.2 AcpClientProfile & updated catalog', () => {
  it('resolves profiles for Claude, Copilot, Pi, native clients, and unknown live-registry ids', () => {
    expect(resolveAcpClientProfile('claude-code').systemPromptChannel).toBe(
      'meta-system-prompt-append',
    );
    expect(resolveAcpClientProfile('copilot').mcpInjection).toBe('copilot-temp-json');
    expect(resolveAcpClientProfile('pi-acp').mcpInjection).toBe('pi-env-json');
    expect(resolveAcpClientProfile('codex-cli').systemPromptChannel).toBe(
      'first-turn-context-block',
    );
    expect(resolveAcpClientProfile('codex-cli').bridgeByDefault).toBe(true);
    expect(resolveAcpClientProfile('some-future-registry-agent').bridgeByDefault).toBe(true);
    expect(resolveAcpClientProfile('openhands').bridgeByDefault).toBe(false);
  });

  it('includes updated live-registry entries (kiro-cli, kimi-code, pi-acp, antigravity-acp, etc.)', () => {
    expect(findAgentDescriptor('kiro-cli')?.acp).toEqual({
      command: 'kiro-cli',
      args: ['acp', '--agent-engine=v3'],
    });
    expect(REGISTRY_ID_ALIASES['kiro-cli']).toBe('kiro');
    expect(findAgentDescriptor('kimi-code')?.integration).toBe('native');
    expect(findAgentDescriptor('pi-acp')?.acp.command).toBe('npx');
    expect(findAgentDescriptor('antigravity-acp')?.vendor).toBe('google');
    expect(AGENTS_CATALOG.length).toBeGreaterThanOrEqual(20);
  });
});

describe('P1.1, P1.3 & P1.4 wrongstackBridgeSetup for all ACP clients & worktrees', () => {
  it('attaches WrongStack MCP bridge to non-Claude clients by default with first-turn context block', () => {
    const factory = wrongstackBridgeSetup('codex-cli', '/repo', undefined);
    expect(factory).toBeDefined();
    const setup = factory!({ id: 't1', description: 'fix bug' }, makeCtx());
    const names = (setup.mcpServers ?? []).map((s) => s.name);
    expect(names).toEqual([
      'wrongstack-index',
      'wrongstack-sage',
      'wrongstack-mailbox',
      'wrongstack-kanban',
    ]);
    // Non-Claude clients receive full service guide in promptPrefix since they ignore _meta.systemPrompt.append
    expect(setup.promptPrefix).toContain('<wrongstack-project-context>');
    expect(setup.promptPrefix).toContain('codebase_context on wrongstack-index');
    expect(setup.promptPrefix).not.toContain('mcp__wrongstack-index__codebase_context');
  });

  it('keeps Claude promptPrefix compact (system prompt stays in _meta.systemPrompt.append)', () => {
    const factory = wrongstackBridgeSetup('claude-code', '/repo', undefined);
    expect(factory).toBeDefined();
    const setup = factory!({ id: 't1', description: 'fix bug' }, makeCtx());
    expect(setup.promptPrefix).not.toContain('<wrongstack-project-context>');
    expect(setup.promptPrefix).toContain('mcp__wrongstack-index__codebase_context');
    expect((setup.meta as { systemPrompt?: { append?: string } })?.systemPrompt?.append).toContain(
      'wrongstack-sage',
    );
  });

  it('binds codebase-index to worktree cwd and forwards --session-id to kanban', () => {
    const factory = wrongstackBridgeSetup('gemini-cli', '/repo', undefined);
    const ctx = makeCtx({
      sessionId: 'sess-99',
      config: {
        id: 'worker-1',
        name: 'worker-1',
        role: 'planner',
        provider: 'acp',
        prompt: '',
        cwd: '/repo/.worktrees/wt-1',
      },
    });
    const task = {
      id: 't1',
      description: 'implement feature',
      metadata: { kanbanTaskId: 'card-123' },
    } as unknown as TaskSpec;
    const setup = factory!(task, ctx);
    const indexSrv = setup.mcpServers?.find((s) => s.name === 'wrongstack-index');
    const kanbanSrv = setup.mcpServers?.find((s) => s.name === 'wrongstack-kanban');
    const intakeSrv = setup.mcpServers?.find((s) => s.name === 'wrongstack-intake');

    expect(indexSrv && 'args' in indexSrv ? indexSrv.args : []).toContain(
      '--project-root=/repo/.worktrees/wt-1',
    );
    expect(kanbanSrv && 'args' in kanbanSrv ? kanbanSrv.args : []).toContain(
      '--session-id=sess-99',
    );
    // Planner role gets requirement-intake automatically
    expect(intakeSrv).toBeDefined();
    // Kanban card cue is included
    expect(setup.promptPrefix).toContain('[Kanban Card: card-123]');
  });

  it('prefers HTTP gateway descriptors over stdio when agent advertises mcpCapabilities.http and revokes on cleanup', async () => {
    let revoked = false;
    const factory = wrongstackBridgeSetup('codex-cli', '/repo', undefined, 'worker', {
      httpGrant: ({ servers }) => ({
        mcpServers: servers.map((s) => ({
          type: 'http' as const,
          name: s === 'codebase-index' ? 'wrongstack-index' : `wrongstack-${s}`,
          url: `http://127.0.0.1:9999/mcp/${s}`,
          headers: [{ name: 'Authorization', value: 'Bearer tok' }],
        })),
        revoke: () => {
          revoked = true;
        },
      }),
    });
    const setup = factory!({ id: 't1', description: 'check' }, makeCtx());
    // HTTP-capable ACP agent gets 4 HTTP servers (0 stdio child processes)
    const forHttpAgent = filterMcpServers({ mcpCapabilities: { http: true } }, setup.mcpServers);
    expect(forHttpAgent).toHaveLength(4);
    expect(forHttpAgent.every((s) => 'type' in s && s.type === 'http')).toBe(true);

    // Stdio-only ACP agent seamlessly falls back to the 4 stdio servers
    const forStdioAgent = filterMcpServers({ mcpCapabilities: { http: false } }, setup.mcpServers);
    expect(forStdioAgent).toHaveLength(4);
    expect(forStdioAgent.every((s) => !('type' in s))).toBe(true);

    expect(revoked).toBe(false);
    await setup.cleanup?.();
    expect(revoked).toBe(true);
  });

  it('allows worktree isolation for local ACP workers while excluding remote WrongForge workers', () => {
    expect(
      subagentNeedsWorktree({
        id: 'w1',
        name: 'w1',
        role: 'executor',
        provider: 'acp',
        prompt: '',
      }),
    ).toBe(true);
    expect(
      subagentNeedsWorktree({
        id: 'w2',
        name: 'w2',
        role: 'executor',
        provider: 'wrongforge',
        prompt: '',
      }),
    ).toBe(false);
  });
});
