import { describe, expect, it, vi } from 'vitest';

/**
 * Background delegation results are drained into a conversation only by its
 * LEADER (`isLeaderAgentId`: agentId `leader` or a mailbox leader address).
 * Every WebUI tab runs on an Agent this registry builds; if those contexts
 * carried any other agentId, the drain would silently never run for WebUI
 * leaders and results would pile up in the hub — the bug the ACP agent had.
 */

const contextOptions: Array<Record<string, unknown>> = [];
const counterOptions: Array<Record<string, unknown>> = [];
const counterAccountCalls: Array<{ usage: unknown; model: unknown; providerId: unknown }> = [];

vi.mock('@wrongstack/core/agent', () => {
  class Context {
    meta: Record<string, unknown> = {};
    session: unknown;
    agentId: unknown;
    provider: { id?: string } | undefined;
    tokenCounter: unknown;
    constructor(opts: Record<string, unknown>) {
      contextOptions.push(opts);
      this.session = opts['session'];
      this.agentId = opts['agentId'];
      this.provider = opts['provider'] as { id?: string } | undefined;
      this.tokenCounter = opts['tokenCounter'];
    }
  }
  class Agent {
    ctx: unknown;
    constructor(opts: Record<string, unknown>) {
      this.ctx = opts['context'];
    }
  }
  return { Agent, Context, providerToolsForVariant: () => [] };
});

vi.mock('@wrongstack/core/infrastructure', () => ({
  DefaultTokenCounter: class {
    private readonly opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown> = {}) {
      this.opts = opts;
      counterOptions.push(opts);
    }
    account(usage: unknown, model?: unknown, providerId?: unknown) {
      const fn = this.opts['providerId'] as (() => string | undefined) | undefined;
      counterAccountCalls.push({
        usage,
        model,
        providerId: providerId ?? fn?.(),
      });
    }
    total() {
      return { input: 0, output: 0 };
    }
  },
}));

// This file's Agent double has no extension registry; the per-tab fallback
// wiring is proven against a real Agent in session-agent-fallback-model.test.ts.
vi.mock('../src/server/conversation-fallback.js', () => ({
  installConversationFallback: vi.fn(),
}));

const { createSessionAgentRegistry } = await import('../src/server/session-agent-registry.js');
const { createSessionAgentManager } = await import('../src/server/create-session-agent-manager.js');
const { isLeaderAgentId } = await import('../../coordination/src/leader-delivery-attach.js');

describe('WebUI per-tab agents are leaders', () => {
  it('builds every tab context with agentId `leader`, which the delivery drain accepts', () => {
    const template = {
      ctx: {
        projectRoot: '/repo',
        cwd: '/repo',
        model: 'm',
        provider: { id: 'p' },
        session: { id: 'sess_boot' },
        traceId: 't',
        systemPrompt: '',
        meta: {},
        tokenCounter: {
          account: () => {},
          total: () => ({ input: 0, output: 0 }),
          estimateCost: () => ({ total: 0 }),
        },
        tools: [],
      },
    };
    const registry = createSessionAgentRegistry({ template: template as never });

    const agent = registry.get('sess_tab_2');

    expect(contextOptions.at(-1)?.['agentId']).toBe('leader');
    expect((agent.ctx as { agentId?: unknown }).agentId).toBe('leader');
    expect(isLeaderAgentId((agent.ctx as { agentId?: unknown }).agentId)).toBe(true);
  });

  it('binds per-tab token counters to the tab context provider and strips session-scoped meta in createSessionAgentManager', () => {
    const rootAccountCalls: Array<{ model: unknown; providerId: unknown }> = [];
    const templateContext = {
      projectRoot: '/repo',
      cwd: '/repo',
      model: 'claude-sonnet-4',
      provider: { id: 'anthropic' },
      session: { id: 'sess_boot' },
      traceId: 't',
      systemPrompt: '',
      meta: {
        mode: 'code',
        yolo: true,
        yoloPlus: true,
        autonomy: 'eternal',
        maxIterations: 50,
      },
      tokenCounter: {
        account: (_u: unknown, model: unknown, providerId: unknown) => {
          rootAccountCalls.push({ model, providerId });
        },
        total: () => ({ input: 0, output: 0 }),
        estimateCost: () => ({ total: 0 }),
      },
      tools: [],
    };
    const registry = createSessionAgentRegistry({
      template: { ctx: templateContext } as never,
    });
    const tab2 = registry.get('sess_tab_2');
    (tab2.ctx as { provider: { id: string } }).provider = { id: 'openai' };
    counterAccountCalls.length = 0;
    (
      tab2.ctx as {
        tokenCounter: { account: (u: unknown, m: string) => void };
      }
    ).tokenCounter.account({ input: 10, output: 5 }, 'gpt-4o');

    expect(counterAccountCalls.at(-1)?.providerId).toBe('openai');
    expect(rootAccountCalls.at(-1)?.providerId).toBe('openai');

    const { sessionAgents } = createSessionAgentManager({
      agent: { ctx: templateContext } as never,
      MAX_CONCURRENT_SESSION_AGENTS: 4,
      input: { tokenCounter: templateContext.tokenCounter as never },
      projectRoot: '/repo',
      workingDir: '/repo',
      context: templateContext as never,
      modelsRegistry: {} as never,
      container: {} as never,
      toolRegistry: {} as never,
      providerRegistry: {} as never,
      events: {} as never,
      pipelines: {} as never,
      config: {} as never,
      toolExecutor: {} as never,
    });
    const managerTab = sessionAgents.get('sess_tab_3');
    expect(managerTab.ctx.meta['mode']).toBe('code');
    expect(managerTab.ctx.meta['yolo']).toBeUndefined();
    expect(managerTab.ctx.meta['yoloPlus']).toBeUndefined();
    expect(managerTab.ctx.meta['autonomy']).toBeUndefined();
    expect(managerTab.ctx.meta['maxIterations']).toBeUndefined();

    (managerTab.ctx as { provider: { id: string } }).provider = { id: 'google' };
    (
      managerTab.ctx as {
        tokenCounter: { account: (u: unknown, m: string) => void };
      }
    ).tokenCounter.account({ input: 20, output: 5 }, 'gemini-2.5-pro');
    expect(counterAccountCalls.at(-1)?.providerId).toBe('google');
    expect(rootAccountCalls.at(-1)?.providerId).toBe('google');
  });
});
