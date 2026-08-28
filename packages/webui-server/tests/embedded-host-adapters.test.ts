import { describe, expect, it, vi } from 'vitest';

vi.mock('ws', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocket: MockWebSocket };
});

vi.mock('@wrongstack/providers', () => ({
  makeProviderFromConfig: vi.fn(() => ({ id: 'openai', capabilities: { maxContext: 128000 } })),
}));

import {
  applyEmbeddedModelSwitch,
  createEmbeddedConversationRoutes,
  createEmbeddedProjectRoutes,
  createEmbeddedSessionRoutes,
  type EmbeddedAgentConfigContext,
} from '../src/server/embedded-host-adapters.js';

function mockAgent(): any {
  return {
    ctx: {
      projectRoot: '/tmp/proj',
      provider: {
        id: 'openai',
        capabilities: { maxContext: 128000, tools: true, vision: false, reasoning: false },
      },
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
        modelsRegistry: {
          refresh: vi.fn(async () => undefined),
          getModel: vi.fn(async () => ({ capabilities: { maxContext: 200000 } })),
        } as any,
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
          agent,
          modeStore: undefined,
          buildSessionStart: vi.fn(),
          loadSavedProviders: vi.fn(async () => ({})),
          modelsRegistry: {
            refresh: vi.fn(async () => undefined),
            getModel: vi.fn(async () => ({ capabilities: { maxContext: 999 } })),
          } as any,
          send: vi.fn(),
          broadcast: vi.fn(),
          log: vi.fn(),
          onMaxContextResolved,
        } as any,
        'anthropic',
        'claude-3',
      );
      expect(onMaxContextResolved).toHaveBeenCalledWith('anthropic', 'claude-3', 999);
    });

    it('keeps a background tab’s switch off the process-wide hook', async () => {
      // `onMaxContextResolved` rewrites the shared max-context ref, the LEADER
      // context's meta and window policy, the shared auto-compactor and it
      // announces the change under the leader's session. Switching a model in
      // another tab must not reach any of that: that tab writes its own meta
      // and names itself in the broadcast.
      const agent = mockAgent();
      const onMaxContextResolved = vi.fn();
      const broadcast = vi.fn();
      const otherTab: any = {
        provider: { id: 'openai', capabilities: { maxContext: 1000 } },
        model: 'gpt-4o',
        session: { id: 'sess-2' },
        meta: {},
        runModelTransition: vi.fn(async (fn: () => Promise<void>) => fn()),
      };

      await applyEmbeddedModelSwitch(
        {
          agent,
          modeStore: undefined,
          buildSessionStart: vi.fn(async () => ({})),
          loadSavedProviders: vi.fn(async () => ({})),
          modelsRegistry: {
            refresh: vi.fn(async () => undefined),
            getModel: vi.fn(async () => ({ capabilities: { maxContext: 777 } })),
          } as any,
          send: vi.fn(),
          broadcast,
          log: vi.fn(),
          onMaxContextResolved,
        } as any,
        'anthropic',
        'claude-3',
        otherTab,
      );

      expect(onMaxContextResolved).not.toHaveBeenCalled();
      expect(otherTab.meta['effectiveMaxContext']).toBe(777);
      expect(agent.ctx.meta['effectiveMaxContext']).toBeUndefined();
      expect(agent.ctx.model).toBe('gpt-4o');
      const maxContextFrame = broadcast.mock.calls
        .map((call) => call[0])
        .find((message: any) => message.type === 'ctx.max_context');
      expect(maxContextFrame.payload).toMatchObject({ sessionId: 'sess-2', maxContext: 777 });
    });

    it('handles modelsRegistry refresh failure gracefully', async () => {
      const agent = mockAgent();
      await applyEmbeddedModelSwitch(
        {
          agent,
          modeStore: undefined,
          buildSessionStart: vi.fn(),
          loadSavedProviders: vi.fn(async () => ({})),
          modelsRegistry: {
            refresh: vi.fn(async () => {
              throw new Error('net');
            }),
            getModel: vi.fn(async () => undefined),
          } as any,
          send: vi.fn(),
          broadcast: vi.fn(),
          log: vi.fn(),
        } as any,
        'openai',
        'gpt-4',
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

    /**
     * Three seams the standalone host has always wired and this one did not.
     * Each divergence is invisible until four tabs are open, and each one was
     * fixed for the standalone server alone when it was first found.
     */
    describe('parity with the standalone host', () => {
      function conversationCtx(overrides: Record<string, unknown> = {}) {
        const leader = { ctx: { meta: { maxIterations: 11 }, session: { id: 'sess_leader' } } };
        return {
          agent: leader,
          abortControllers: new Map<string, AbortController>(),
          pendingConfirms: new Map(),
          send: vi.fn(),
          broadcast: vi.fn(),
          ...overrides,
        } as any;
      }

      /**
       * `maxIterations` is a session-scoped preference on that tab's context
       * meta. Without this seam the ceiling — and the "3 / 500" readout — came
       * from the leader, i.e. the boot tab, for every tab.
       */
      it('reads maxIterations from the asking session, not the leader', async () => {
        const run = vi.fn(async () => ({ status: 'ok', iterations: 1, finalText: '' }));
        const tab = {
          ctx: {
            meta: { maxIterations: 42 },
            session: { id: 'sess_tab', append: vi.fn() },
            provider: { id: 'p', capabilities: {} },
          },
          run,
        };
        const peekAgent = vi.fn((id?: string) => (id === 'sess_tab' ? tab : undefined));
        const ctx = conversationCtx({
          peekAgent,
          getAgent: () => tab,
          hasSession: () => true,
          getSessionId: () => 'sess_tab',
        });
        const routes = createEmbeddedConversationRoutes(ctx);

        await routes.userMessage(
          {} as never,
          { type: 'user_message', payload: { sessionId: 'sess_tab', content: 'hi' } } as never,
        );

        expect(run).toHaveBeenCalledTimes(1);
        // 42 is the TAB's ceiling; 11 (in conversationCtx) is the leader's.
        const [[, runOptions]] = run.mock.calls as unknown as [
          [unknown, { maxIterations: number }],
        ];
        expect(runOptions).toMatchObject({ maxIterations: 42 });
        // Resolved without materialising an agent for a stale id.
        expect(peekAgent).toHaveBeenCalledWith('sess_tab');
      });

      /** The abort notice belongs to the session, so every page showing that
       *  tab has to clear its spinner — not only the socket that asked. */
      it('broadcasts the abort notice instead of replying to one socket', () => {
        const ctx = conversationCtx({
          getAgent: () => ({ ctx: { meta: {}, session: { id: 'sess_a' } } }),
          hasSession: () => true,
          getSessionId: () => 'sess_a',
        });
        const routes = createEmbeddedConversationRoutes(ctx);
        routes.abort({} as never, { type: 'abort', payload: { sessionId: 'sess_a' } } as never);
        expect(ctx.broadcast).toHaveBeenCalled();
        const [[message]] = ctx.broadcast.mock.calls as unknown as [
          [{ payload: { phase: string } }],
        ];
        expect(message.payload.phase).toBe('abort');
      });

      /** Turn setup must be serialised against session transitions. Passing no
       *  gate leaves createConversationOperations on a pass-through. */
      it('runs turn setup through the gate it is handed', async () => {
        const entered: string[] = [];
        const ctx = conversationCtx({
          getAgent: () => ({
            ctx: { meta: {}, session: { id: 'sess_a', append: vi.fn() }, provider: {} },
          }),
          hasSession: () => true,
          getSessionId: () => 'sess_a',
          withSessionTransition: async <T>(operation: () => Promise<T>) => {
            entered.push('gate');
            return operation();
          },
        });
        const routes = createEmbeddedConversationRoutes(ctx);
        await routes.userMessage(
          {} as never,
          { type: 'user_message', payload: { sessionId: 'sess_a', content: 'hi' } } as never,
        );
        expect(entered).toEqual(['gate']);
      });
    });
  });
});
