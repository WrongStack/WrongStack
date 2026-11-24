import { AGENTS_CATALOG, acpRuntimeOptions, resolveAcpClientProfile } from '@wrongstack/acp';
import type { SubagentRunContext } from '@wrongstack/contracts/types';
import { SubagentBudget } from '@wrongstack/coordination';
import { describe, expect, it } from 'vitest';
import { buildAcpPreflightContext } from '../src/acp-preflight-context.js';
import { wrongstackBridgeSetup } from '../src/acp-wrongstack-bridge.js';

describe('P3.1 buildAcpPreflightContext', () => {
  it('renders budgeted SAGE memories and Kanban card checklist into a preflight block', async () => {
    const block = await buildAcpPreflightContext({
      taskDescription: 'Fix ACP permission bridge for Codex',
      kanbanCardId: 'card-77',
      sources: {
        fetchMemories: async () => [
          {
            title: 'ACP MCP Naming',
            content: 'Non-Claude clients send server/tool titles instead of mcp__server__tool.',
            scope: 'project',
          },
        ],
        fetchKanbanCard: async (id) => ({
          id,
          title: 'Normalize non-Claude MCP permissions',
          status: 'in_progress',
          checks: [
            { label: 'Handle slash/colon formats', done: true },
            { label: 'Keep fail-closed default', done: false },
          ],
        }),
      },
    });

    expect(block).toContain('<wrongstack-preflight-context>');
    expect(block).toContain('## Kanban Card (card-77)');
    expect(block).toContain('- [x] Handle slash/colon formats');
    expect(block).toContain('- [ ] Keep fail-closed default');
    expect(block).toContain('## Relevant Project Memories (SAGE)');
    expect(block).toContain('**ACP MCP Naming**');
  });

  it('fails open and returns undefined when sources time out or throw', async () => {
    const block = await buildAcpPreflightContext({
      taskDescription: 'anything',
      kanbanCardId: 'card-1',
      options: { timeoutMs: 100 },
      sources: {
        fetchMemories: async () => {
          throw new Error('daemon offline');
        },
        fetchKanbanCard: async (_id, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      },
    });

    expect(block).toBeUndefined();
  });

  it('fails open when a source never settles and ignores its signal', async () => {
    // A lookup that ignores its abort signal takes this shape (a dead
    // transport); the block must still fail open at its own deadline instead
    // of holding the ACP task start forever.
    const never = new Promise<never>(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hang = new Promise<'hang'>((resolve) => {
      timer = setTimeout(() => resolve('hang'), 600);
      timer.unref?.();
    });
    try {
      const settled = await Promise.race([
        buildAcpPreflightContext({
          taskDescription: 'anything',
          options: { timeoutMs: 50 },
          sources: { fetchMemories: () => never },
        }),
        hang,
      ]);
      expect(settled).not.toBe('hang');
      expect(settled).toBeUndefined();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
});

describe('P3.3 & P3.4 ACP Client Conformance Matrix & boolean configOptions', () => {
  it('parses boolean configOptions alongside select options in acpRuntimeOptions', () => {
    const opts = acpRuntimeOptions([
      {
        id: 'thinking',
        name: 'Extended Thinking',
        type: 'boolean',
        category: 'thinking',
        currentValue: true,
      },
    ]);
    expect(opts).toHaveLength(1);
    expect(opts[0]?.id).toBe('thinking');
    expect(opts[0]?.currentValue).toBe('true');
    expect(opts[0]?.options).toEqual([
      { value: 'true', name: 'Enabled' },
      { value: 'false', name: 'Disabled' },
    ]);
  });

  it('produces valid bridge MCP setup for every default-bridged catalog ACP client', () => {
    const ctx: SubagentRunContext = {
      subagentId: 'conformance-worker',
      sessionId: 'sess-conf',
      config: {
        id: 'conformance-worker',
        name: 'conformance-worker',
        role: 'executor',
        provider: 'acp',
        prompt: '',
      },
      budget: new SubagentBudget({ timeoutMs: 60_000, maxIterations: 5, maxToolCalls: 5 }),
      signal: new AbortController().signal,
      bridge: null,
    };

    const bridgedAgents = AGENTS_CATALOG.filter(
      (a) => resolveAcpClientProfile(a.id).bridgeByDefault,
    );
    expect(bridgedAgents.length).toBeGreaterThanOrEqual(20);

    for (const agent of bridgedAgents) {
      const factory = wrongstackBridgeSetup(agent.id, '/repo', undefined);
      expect(factory, `Expected bridge setup for ${agent.id}`).toBeDefined();
      const setup = factory!({ id: 't1', description: 'check' }, ctx);
      const serverNames = (setup.mcpServers ?? []).map((s) => s.name);
      const profile = resolveAcpClientProfile(agent.id);
      const expectedServers =
        profile.supportsSessionMcp === false
          ? []
          : profile.preferCliIndexSurface
            ? ['wrongstack-sage', 'wrongstack-mailbox', 'wrongstack-kanban']
            : ['wrongstack-index', 'wrongstack-sage', 'wrongstack-mailbox', 'wrongstack-kanban'];
      expect(serverNames).toEqual(expectedServers);
      expect(setup.promptPrefix).toBeTruthy();
      if (profile.systemPromptChannel === 'first-turn-context-block') {
        expect(setup.promptPrefix).toContain('<wrongstack-project-context>');
      } else {
        expect(
          (setup.meta as { systemPrompt?: { append?: string } })?.systemPrompt?.append,
        ).toContain('wrongstack-sage');
      }
    }
  });
});
