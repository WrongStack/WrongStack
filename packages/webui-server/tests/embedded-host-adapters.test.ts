import { describe, it, expect, vi } from 'vitest';
vi.mock('ws', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocket: MockWebSocket };
});

vi.mock('@wrongstack/providers', () => ({ makeProviderFromConfig: vi.fn(() => ({ id: 'openai', capabilities: { maxContext: 128000 } })) }));

import {
  applyEmbeddedModelSwitch,
  createEmbeddedSessionRoutes,
  createEmbeddedProjectRoutes,
  createEmbeddedConversationRoutes,
  type EmbeddedAgentConfigContext,
} from '../src/server/embedded-host-adapters.js';

function mockAgent(): any {
  return {
    ctx: {
      projectRoot: '/tmp/proj',
      provider: { id: 'openai', capabilities: { maxContext: 128000, tools: true, vision: false, reasoning: false } },
      model: 'gpt-4o',
      session: { id: 'sess-1' },
      meta: {},
      tools: [],
      runModelTransition: vi.fn(async (fn: () => Promise<void>) => fn()),
    },
  };
}

describe('embedded-host-adapters', () => {
  describe('applyEmbeddedModelSwitch', () => {
    it('switches model and broadcasts ctx.max_context', async () => {
      const agent = mockAgent();
      const ctx: EmbeddedAgentConfigContext = {
        agent,
        modeStore: undefined,
        buildSessionStart: vi.fn(async () => ({})),
        loadSavedProviders: vi.fn(async () => ({ openai: { type: 'openai' } })),
        modelsRegistry: { refresh: vi.fn(async () => undefined), getModel: vi.fn(async () => ({ capabilities: { maxContext: 200000 } })) } as any,
        send: vi.fn(),
        broadcast: vi.fn(),
        log: vi.fn(),
      };
      await applyEmbeddedModelSwitch(ctx, 'openai', 'gpt-4o-mini');
      expect(agent.ctx.model).toBe('gpt-4o-mini');
      expect(agent.ctx.provider).toBeDefined();
      expect(ctx.broadcast).toHaveBeenCalled();
    });

    it('calls onMaxContextResolved when provided', async () => {
      const agent = mockAgent();
      const onMaxContextResolved = vi.fn();
      await applyEmbeddedModelSwitch(
        {
          agent, modeStore: undefined, buildSessionStart: vi.fn(), loadSavedProviders: vi.fn(async () => ({})),
          modelsRegistry: { refresh: vi.fn(async () => undefined), getModel: vi.fn(async () => ({ capabilities: { maxContext: 999 } })) } as any,
          send: vi.fn(), broadcast: vi.fn(), log: vi.fn(), onMaxContextResolved,
        } as any,
        'anthropic', 'claude-3',
      );
      expect(onMaxContextResolved).toHaveBeenCalledWith('anthropic', 'claude-3', 999);
    });

    it('handles modelsRegistry refresh failure gracefully', async () => {
      const agent = mockAgent();
      await applyEmbeddedModelSwitch(
        {
          agent, modeStore: undefined, buildSessionStart: vi.fn(), loadSavedProviders: vi.fn(async () => ({})),
          modelsRegistry: { refresh: vi.fn(async () => { throw new Error('net'); }), getModel: vi.fn(async () => undefined) } as any,
          send: vi.fn(), broadcast: vi.fn(), log: vi.fn(),
        } as any,
        'openai', 'gpt-4',
      );
      expect(agent.ctx.model).toBe('gpt-4');
    });
  });

  describe('createEmbeddedSessionRoutes', () => {
    it('returns route handler object', () => {
      const routes = createEmbeddedSessionRoutes({
        opts: { agent: mockAgent(), projectRoot: '/tmp/proj', profileConfigPath: '/tmp/cfg.json' },
        getSessionHistory: vi.fn(async () => []),
        saveSession: vi.fn(async () => undefined),
        sessionIdentity: { fingerprint: vi.fn(() => 'fp'), mark: vi.fn(), clear: vi.fn() } as any,
        send: vi.fn(),
        abortControllers: new Map(),
      } as any);
      expect(typeof routes).toBe('object');
    });
  });

  describe('createEmbeddedProjectRoutes', () => {
    it('returns route handler object', () => {
      const routes = createEmbeddedProjectRoutes({
        opts: { agent: mockAgent(), projectRoot: '/tmp/proj', profileConfigPath: '/tmp/cfg.json' },
        send: vi.fn(),
        getProjectRoot: () => '/tmp/proj',
      } as any);
      expect(typeof routes).toBe('object');
    });
  });

  describe('createEmbeddedConversationRoutes', () => {
    it('returns route handler object', () => {
      const routes = createEmbeddedConversationRoutes({
        abortControllers: new Map(),
        send: vi.fn(),
        broadcast: vi.fn(),
      } as any);
      expect(typeof routes).toBe('object');
    });
  });
});
