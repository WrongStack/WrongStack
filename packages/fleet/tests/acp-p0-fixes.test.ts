import type { Config, PermissionDecision, Tool } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { wrongstackAcpPermissionPolicy } from '../src/acp-permission-bridge.js';
import { acpBtwBlock } from '../src/acp-turn-reminders.js';
import { HostAcpRunnerCache } from '../src/host-acp-runner-cache.js';
import { runHostShadowPass } from '../src/host-shadow-pass.js';

describe('P0.1 acp-permission-bridge non-Claude MCP normalization', () => {
  const makePolicy = (registeredMcpServers?: string[]) => {
    const evaluated: string[] = [];
    const refused: Array<{ tool: string; reason: string }> = [];
    const policy = wrongstackAcpPermissionPolicy({
      projectRoot: '/repo',
      allowMcp: true,
      ...(registeredMcpServers ? { registeredMcpServers } : {}),
      getTool: () => undefined,
      evaluate: async (tool: Tool): Promise<PermissionDecision> => {
        evaluated.push(tool.name);
        return { permission: 'auto', source: 'default' };
      },
      onRefused: (call, reason) => refused.push({ tool: call.tool, reason }),
    });
    return { policy, evaluated, refused };
  };

  const makeReq = (title: string, _meta?: Record<string, unknown>) => ({
    sessionId: 's1',
    toolCall: {
      toolCallId: 'tc1',
      title,
      kind: 'other' as const,
      rawInput: { query: 'test' },
      ...(_meta ? { _meta } : {}),
    },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
    ],
    signal: new AbortController().signal,
  });

  it('normalizes slash, colon, dot, on-syntax, and _meta.mcp formats for known servers', async () => {
    const { policy, evaluated, refused } = makePolicy(['custom-mcp']);
    const cases: Array<[string, Record<string, unknown> | undefined, string]> = [
      ['wrongstack-sage/memory_search', undefined, 'mcp__wrongstack-sage__memory_search'],
      ['wrongstack-index:codebase_search', undefined, 'mcp__wrongstack-index__codebase_search'],
      ['mcp.wrongstack-index.codebase_stats', undefined, 'mcp__wrongstack-index__codebase_stats'],
      ['wrongstack-index-codebase_stats', undefined, 'mcp__wrongstack-index__codebase_stats'],
      ['codebase_stats', undefined, 'mcp__wrongstack-index__codebase_stats'],
      ['wrongstack-sage: memory search · ACP', undefined, 'mcp__wrongstack-sage__memory_search'],
      ['wrongstack-index: codebase stats', undefined, 'mcp__wrongstack-index__codebase_stats'],
      [
        'memory_search (wrongstack-sage MCP Server): {"limit":2,"query":"ACP"}',
        undefined,
        'mcp__wrongstack-sage__memory_search',
      ],
      ['wrongstack-kanban.kanban_read', undefined, 'mcp__wrongstack-kanban__kanban_read'],
      ['mailbox_read on wrongstack-mailbox', undefined, 'mcp__wrongstack-mailbox__mailbox_read'],
      ['custom-mcp/my_tool', undefined, 'mcp__custom-mcp__my_tool'],
      [
        'Some Display Title',
        { mcp: { serverName: 'wrongstack-intake', toolName: 'requirement_intake_list' } },
        'mcp__wrongstack-intake__requirement_intake_list',
      ],
    ];

    for (const [title, meta, expected] of cases) {
      const res = await policy(makeReq(title, meta));
      expect(res).toEqual({ outcome: 'selected', optionId: 'allow' });
      expect(evaluated.at(-1)).toBe(expected);
    }
    expect(refused).toHaveLength(0);
  });

  it('normalizes Kimi-style Bash tool calls with kind=other and rawInput.command', async () => {
    const evaluated: string[] = [];
    const policy = wrongstackAcpPermissionPolicy({
      projectRoot: '/repo',
      allowMcp: true,
      getTool: (name) =>
        name === 'bash' ? ({ name: 'bash', capabilities: [] } as unknown as Tool) : undefined,
      evaluate: async (tool: Tool): Promise<PermissionDecision> => {
        evaluated.push(tool.name);
        return { permission: 'auto', source: 'default' };
      },
    });
    const res = await policy({
      sessionId: 's1',
      toolCall: {
        toolCallId: 'tc-kimi',
        title: 'Bash',
        kind: 'other',
        rawInput: { command: 'wstack tools run codebase-stats' },
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ outcome: 'selected', optionId: 'allow' });
    const resContent = await policy({
      sessionId: 's1',
      toolCall: {
        toolCallId: 'tc-kimi-content',
        title: 'Bash',
        kind: 'other',
        rawInput: {},
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Running: wstack tools run codebase-stats' },
          },
        ],
      } as never,
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
      signal: new AbortController().signal,
    });
    expect(resContent).toEqual({ outcome: 'selected', optionId: 'allow' });
    expect(evaluated).toEqual(['bash', 'bash']);
  });

  it('still fails closed for unknown non-MCP slash/dot strings', async () => {
    const { policy, evaluated, refused } = makePolicy();
    const res = await policy(makeReq('unregistered-server/evil_tool'));
    expect(res).toEqual({ outcome: 'selected', optionId: 'reject' });
    expect(evaluated).toHaveLength(0);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toContain('no WrongStack counterpart');
  });
});

describe('P0.4 acp-turn-reminders agent-aware mailbox nudge', () => {
  it('uses Claude double-underscore name for claude-code and adapted name for other agents', () => {
    const claude = acpBtwBlock(['[MAILBOX BTW] ping'], 'claude-code');
    expect(claude).toContain('mcp__wrongstack-mailbox__mailbox_read');

    const codex = acpBtwBlock(['[MAILBOX BTW] ping'], 'codex-cli');
    expect(codex).toContain('mailbox_read on wrongstack-mailbox');
    expect(codex).not.toContain('mcp__wrongstack-mailbox__mailbox_read');
  });
});

describe('P0.4 host-shadow-pass ACP leader sideModel routing', () => {
  it('routes shadow agent to acp.leader.sideModel in ACP leader mode and deduplicates fleet tool', async () => {
    const spawned: Array<{ provider?: string; model?: string; tools?: string[] }> = [];
    const liveConfig = {
      provider: 'acp',
      model: 'claude-code',
      acp: {
        leader: {
          sideModel: 'anthropic/claude-sonnet-4-6',
        },
      },
    } as unknown as Config;

    await runHostShadowPass(
      {
        getDirector: () => ({ isWorkComplete: () => false }),
        getLiveConfig: () => liveConfig,
        getObservedWorkDepth: () => 0,
        getQueuedProblem: () => null,
        setQueuedProblem: vi.fn(),
        setPassInFlight: vi.fn(),
        getHeartbeatIntervalMs: () => 5000,
        sessionId: 'sess-1',
        spawnAndAssign: async (cfg) => {
          spawned.push({ provider: cfg.provider, model: cfg.model, tools: cfg.tools });
        },
        requestShadowPass: vi.fn(),
      },
      'worker stalled',
    );

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.provider).toBe('anthropic');
    expect(spawned[0]?.model).toBe('claude-sonnet-4-6');
    expect(spawned[0]?.tools).toEqual([
      'fleet',
      'mailbox',
      'mail_inbox',
      'mail_send',
      'terminate_subagent',
    ]);
  });
});

describe('P0.4 HostAcpRunnerCache config invalidation', () => {
  it('builds a fresh runner when bridge config changes', async () => {
    let bridgeEnabled = false;
    const cache = new HostAcpRunnerCache(10, () => ({
      projectRoot: '/repo',
      overrides: { 'test-acp': { command: 'echo', args: ['hi'] } },
      bridge: { projectRoot: '/repo', config: { enabled: bridgeEnabled } },
    }));

    const first = await cache.get('test-acp');
    const second = await cache.get('test-acp');
    expect(second).toBe(first);

    bridgeEnabled = true;
    const third = await cache.get('test-acp');
    expect(third).not.toBe(first);
  });
});
