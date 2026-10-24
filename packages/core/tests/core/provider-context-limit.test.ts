import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { NextFn } from '@wrongstack/contracts/kernel/pipeline';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type {
  Capabilities,
  Provider,
  Request,
  Response,
} from '@wrongstack/contracts/types/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import { createAgentLoopContextManager } from '../../src/core/agent-loop-context.js';
import { Context } from '../../src/core/context.js';
import { AutoCompactionMiddleware } from '../../src/execution/auto-compaction-middleware.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { createStrategyCompactor } from '../../src/execution/strategy-compactor.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import {
  estimateRequestTokens,
  getCalibrationState,
  resetCalibration,
} from '../../src/utils/token-estimate.js';

function mockProviderWithProbe(opts: {
  id?: string;
  maxContext?: number;
  probeResult?: number | undefined;
  probeThrow?: boolean;
}): Provider & {
  probeCalls: number;
  probeModels: string[];
} {
  const probeCalls = { count: 0, models: [] as string[] };
  const maxContext = opts.maxContext ?? 1_000_000;
  return {
    id: opts.id ?? 'codex',
    capabilities: {
      maxContext,
      streaming: true,
      tools: true,
      vision: false,
      caching: false,
      parallelism: 0,
    } as unknown as Capabilities,
    async complete(): Promise<Response> {
      return {
        model: 'test',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 50, output: 5 },
      };
    },
    async *stream(): AsyncGenerator<{
      type: string;
      [key: string]: unknown;
    }> {
      yield { type: 'message_start', model: 'test' };
      yield { type: 'content_block_start', kind: 'text' } as never;
      yield { type: 'text_delta', text: 'ok' } as never;
      yield { type: 'content_block_stop', index: 0 } as never;
      yield {
        type: 'message_stop',
        stopReason: 'end_turn',
        usage: { input: 50, output: 5 },
      } as never;
    },
    health: async () => ({ ok: true }),
    ...(opts.probeResult !== undefined || opts.probeThrow
      ? {
          async refreshContextLimit(
            model: string,
          ): Promise<{ maxContext: number; source: 'provider' } | undefined> {
            probeCalls.count += 1;
            probeCalls.models.push(model);
            if (opts.probeThrow) throw new Error('metadata unavailable');
            return opts.probeResult !== undefined
              ? { maxContext: opts.probeResult, source: 'provider' }
              : undefined;
          },
        }
      : {}),
    get probeCalls() {
      return probeCalls.count;
    },
    get probeModels() {
      return probeCalls.models;
    },
  } as never;
}

async function buildAgentWithProbe(
  provider: Provider,
  model = 'test-model',
): Promise<{
  agent: Agent;
  events: EventBus;
  ctx: Context;
  pipelines: ReturnType<typeof createDefaultPipelines>;
  tmp: string;
  session: { close: () => Promise<void> };
}> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-pcl-'));
  const trustFile = path.join(tmp, 'trust.json');
  const sessionDir = path.join(tmp, 'sessions');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile, yolo: true }),
  );

  const tools = new ToolRegistry();
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const pipelines = createDefaultPipelines();

  const sessionStore = new DefaultSessionStore({ dir: sessionDir });
  const session = await sessionStore.create({ id: '', model, provider: provider.id });

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are a test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model,
    tools: [],
  });

  const toolExecutor = new ToolExecutor(tools, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber: container.resolve(TOKENS.SecretScrubber),
    events,
    confirmAwaiter: undefined,
    iterationTimeoutMs: 300_000,
    perIterationOutputCapBytes: 100_000,
    tracer: undefined,
  });

  const agent = new Agent({
    container,
    tools,
    providers,
    events,
    pipelines,
    context: ctx,
    toolExecutor,
    maxIterations: 10,
  });

  return { agent, events, ctx, pipelines, tmp, session };
}

describe('refreshProviderContextLimit state machine', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('sets effectiveMaxContext to provider probe value on first decrease', async () => {
    const provider = mockProviderWithProbe({
      maxContext: 1_000_000,
      probeResult: 272_000,
    });

    const { agent, events, ctx, tmp, session } = await buildAgentWithProbe(provider);
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    const maxCtxEvents: Array<{
      maxContext: number;
      source?: string;
      decreased?: boolean;
    }> = [];
    events.on('ctx.max_context', (e) => {
      maxCtxEvents.push({
        maxContext: e.maxContext,
        ...(e.source !== undefined ? { source: e.source } : {}),
        ...(e.decreased !== undefined ? { decreased: e.decreased } : {}),
      });
    });

    await agent.run('hello', {});

    // The probe should have been called.
    expect(provider.probeCalls).toBeGreaterThan(0);

    // The effective ceiling must be 272K (the probe value), not the
    // provider's native 1M.
    expect(ctx.meta['effectiveMaxContext']).toBe(272_000);
    expect(ctx.meta['effectiveMaxContextSource']).toBe('provider');

    // At least one event with source=provider should have been emitted.
    const providerEvents = maxCtxEvents.filter((e) => e.source === 'provider');
    expect(providerEvents.length).toBeGreaterThan(0);
    expect(providerEvents[0]!.maxContext).toBe(272_000);
  });

  it('does not emit on an unchanged re-probe (same value)', async () => {
    const provider = mockProviderWithProbe({
      maxContext: 272_000,
      probeResult: 272_000,
    });

    const { agent, events, tmp, session } = await buildAgentWithProbe(provider);
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    const maxCtxEvents: Array<{ maxContext: number; source?: string }> = [];
    events.on('ctx.max_context', (e) => {
      if (e.source === 'provider') {
        maxCtxEvents.push({ maxContext: e.maxContext, ...(e.source ? { source: e.source } : {}) });
      }
    });

    await agent.run('hello', {});
    const firstCount = maxCtxEvents.length;

    await agent.run('world', {});

    // No new provider-sourced decrease event because the limit didn't change.
    expect(maxCtxEvents.length).toBe(firstCount);
  });

  it('fail-open: probe failure does not crash the agent run', async () => {
    const provider = mockProviderWithProbe({
      maxContext: 500_000,
      probeThrow: true,
    });

    const { agent, events, tmp, session } = await buildAgentWithProbe(provider);
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    const errors: string[] = [];
    events.on('session.damaged', (e) => {
      errors.push(e.detail);
    });

    // Should complete without throwing.
    await agent.run('hello', {});

    expect(errors.length).toBe(0);
  });

  it('overflow-learned ceiling wins over provider probe and stamps provider_overflow', async () => {
    // Provider reports 272K, but a prior overflow learned 200K. The effective
    // should remain 200K (overflow wins) even after the probe discovers 272K,
    // and the externally learned source/value must be broadcast once.
    const provider = mockProviderWithProbe({
      maxContext: 1_000_000,
      probeResult: 272_000,
    });

    const { agent, events, ctx, tmp, session } = await buildAgentWithProbe(provider);
    // Simulate overflow learning before the probe runs.
    ctx.meta['providerOverflowMaxContext'] = 200_000;
    ctx.meta['effectiveMaxContext'] = 200_000;
    ctx.meta['effectiveMaxContextSource'] = 'provider_overflow';

    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    const emittedDuringRun: Array<{ maxContext: number; source?: string }> = [];
    events.on('ctx.max_context', (event) => {
      emittedDuringRun.push({
        maxContext: event.maxContext,
        ...(event.source !== undefined ? { source: event.source } : {}),
      });
    });

    await agent.run('hello', {});

    expect(emittedDuringRun).toEqual([{ maxContext: 200_000, source: 'provider_overflow' }]);
    // But the overflow ceiling must still be in force, not overwritten by
    // the provider's 272K.
    expect(ctx.meta['effectiveMaxContext']).toBe(200_000);
    expect(ctx.meta['effectiveMaxContextSource']).toBe('provider_overflow');
  });

  it('route change resets to new provider native, not old route effective', async () => {
    // Provider A reports 272K via probe (native capability 1M). After the
    // first run, switch to Provider B with a native capability of 500K and no
    // probe. The effective should be 500K (Provider B's native), not 272K
    // (Provider A's probe-discovered effective).
    const providerA = mockProviderWithProbe({
      id: 'codex',
      maxContext: 1_000_000,
      probeResult: 272_000,
    });

    const {
      agent: agentA,
      events,
      ctx,
      tmp,
      session,
    } = await buildAgentWithProbe(providerA, 'codex-model');
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    await agentA.run('hello', {});

    // After first run: effective is 272K from the probe.
    expect(ctx.meta['effectiveMaxContext']).toBe(272_000);

    // Now simulate a route switch to Provider B (500K native, no probe).
    ctx.meta['contextLimitRouteKey'] = 'codex/codex-model'; // current route
    const providerB = {
      id: 'other',
      capabilities: {
        maxContext: 500_000,
        streaming: true,
        tools: true,
        vision: false,
        caching: false,
        parallelism: 0,
      } as unknown as Capabilities,
      async complete(): Promise<Response> {
        return {
          model: 'other-model',
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: { input: 30, output: 3 },
        };
      },
      async *stream(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        yield { type: 'message_start', model: 'other-model' };
        yield { type: 'content_block_start', kind: 'text' } as never;
        yield { type: 'text_delta', text: 'ok' } as never;
        yield { type: 'content_block_stop', index: 0 } as never;
        yield {
          type: 'message_stop',
          stopReason: 'end_turn',
          usage: { input: 30, output: 3 },
        } as never;
      },
      health: async () => ({ ok: true }),
    };
    ctx.provider = providerB as never;
    ctx.model = 'other-model';

    const maxCtxEvents: Array<{ maxContext: number; source?: string }> = [];
    events.on('ctx.max_context', (event) => {
      maxCtxEvents.push({
        maxContext: event.maxContext,
        ...(event.source !== undefined ? { source: event.source } : {}),
      });
    });

    await agentA.run('route changed', {});

    // The native ceiling (500K) is now persisted in meta so currentMaxContext()
    // stays consistent even before ctx.provider catches up.
    expect(ctx.meta['effectiveMaxContext']).toBe(500_000);
    expect(ctx.meta['effectiveMaxContextSource']).toBe('configured');
    expect(maxCtxEvents).toContainEqual({ maxContext: 500_000, source: 'configured' });
  });

  it('route change to new provider WITH probe stamps provider source, not old effective', async () => {
    // Provider A (codex): native 1M, probe discovers 272K.
    // After the first run, switch to Provider B (other): native 800K,
    // probe discovers 150K.
    // The effective should be 150K with source=provider, not 272K (A's old
    // effective) or 800K (B's native).
    const providerA = mockProviderWithProbe({
      id: 'codex',
      maxContext: 1_000_000,
      probeResult: 272_000,
    });

    const {
      agent: agentA,
      events,
      ctx,
      tmp,
      session,
    } = await buildAgentWithProbe(providerA, 'codex-model');
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    await agentA.run('first', {});

    // After first run: effective is 272K from Provider A's probe.
    expect(ctx.meta['effectiveMaxContext']).toBe(272_000);
    expect(ctx.meta['effectiveMaxContextSource']).toBe('provider');

    // Now switch to Provider B which also has a probe, discovering 150K.
    ctx.meta['contextLimitRouteKey'] = 'codex/codex-model';
    const providerB = mockProviderWithProbe({
      id: 'other',
      maxContext: 800_000,
      probeResult: 150_000,
    });
    ctx.provider = providerB as never;
    ctx.model = 'other-model';

    const maxCtxEvents: Array<{ maxContext: number; source?: string }> = [];
    events.on('ctx.max_context', (event) => {
      maxCtxEvents.push({
        maxContext: event.maxContext,
        ...(event.source !== undefined ? { source: event.source } : {}),
      });
    });

    await agentA.run('second', {});

    // Provider B's probe (150K) should win over its native (800K) and
    // over Provider A's stale effective (272K).
    expect(ctx.meta['effectiveMaxContext']).toBe(150_000);
    expect(ctx.meta['effectiveMaxContextSource']).toBe('provider');

    // The event should carry source=provider for the new route's probe.
    const providerEvents = maxCtxEvents.filter((e) => e.source === 'provider');
    expect(providerEvents.length).toBeGreaterThan(0);
    expect(providerEvents[0]!.maxContext).toBe(150_000);

    // Provider A's stale baseline must NOT be in force.
    expect(ctx.meta['contextLimitBaseline']).not.toBe(272_000);
  });

  it('fallback to provider WITHOUT probe syncs to new native ceiling', async () => {
    // Provider A (codex): native 1M, probe discovers 272K.
    // Simulate a fallback to Provider B (other): native 500K, NO probe.
    // The effective should sync to 500K with source=configured, and the
    // stale 272K from Provider A must be cleared.
    const providerA = mockProviderWithProbe({
      id: 'codex',
      maxContext: 1_000_000,
      probeResult: 272_000,
    });

    const {
      agent: agentA,
      events,
      ctx,
      tmp,
      session,
    } = await buildAgentWithProbe(providerA, 'codex-model');
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    await agentA.run('first', {});

    // After first run: effective is 272K from Provider A's probe.
    expect(ctx.meta['effectiveMaxContext']).toBe(272_000);

    // Simulate fallback: switch to Provider B (no probe, native 500K).
    ctx.meta['contextLimitRouteKey'] = 'codex/codex-model';
    const providerB = {
      id: 'other',
      capabilities: {
        maxContext: 500_000,
        streaming: true,
        tools: true,
        vision: false,
        caching: false,
        parallelism: 0,
      } as unknown as Capabilities,
      async complete(): Promise<Response> {
        return {
          model: 'other-model',
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: { input: 30, output: 3 },
        };
      },
      async *stream(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        yield { type: 'message_start', model: 'other-model' };
        yield { type: 'content_block_start', kind: 'text' } as never;
        yield { type: 'text_delta', text: 'ok' } as never;
        yield { type: 'content_block_stop', index: 0 } as never;
        yield {
          type: 'message_stop',
          stopReason: 'end_turn',
          usage: { input: 30, output: 3 },
        } as never;
      },
      health: async () => ({ ok: true }),
    };
    ctx.provider = providerB as never;
    ctx.model = 'other-model';

    const maxCtxEvents: Array<{ maxContext: number; source?: string }> = [];
    events.on('ctx.max_context', (event) => {
      maxCtxEvents.push({
        maxContext: event.maxContext,
        ...(event.source !== undefined ? { source: event.source } : {}),
      });
    });

    await agentA.run('second', {});

    // Effective must be Provider B's native 500K, not stale 272K.
    expect(ctx.meta['effectiveMaxContext']).toBe(500_000);
    expect(ctx.meta['effectiveMaxContextSource']).toBe('configured');

    // A configured-sourced event must have been emitted.
    const configuredEvents = maxCtxEvents.filter((e) => e.source === 'configured');
    expect(configuredEvents.length).toBeGreaterThan(0);
    expect(configuredEvents[0]!.maxContext).toBe(500_000);
  });
});

describe('agent-loop usage accounting', () => {
  it('learns actual/raw token ratio without feeding its calibrated estimate back into training', async () => {
    const provider = mockProviderWithProbe({ id: 'usage-calibration-regression' });
    provider.capabilities.streaming = false;
    const key = `${provider.id}/test-model`;
    resetCalibration(key);
    provider.complete = async (req) => {
      const raw = estimateRequestTokens(req.messages, req.system, req.tools ?? [], key).total;
      return {
        model: req.model,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: Math.round(raw * 0.75), output: 1 },
      };
    };
    const { agent, tmp, session } = await buildAgentWithProbe(provider);
    try {
      for (let i = 0; i < 8; i++) await agent.run(`turn ${i} ` + 'x'.repeat(1000), {});
      expect(getCalibrationState(key).count).toBe(8);
      expect(getCalibrationState(key).ratio).toBeCloseTo(0.75, 2);
    } finally {
      resetCalibration(key);
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('advances the consumed-prefix anchor even when authoritative usage stays equal', async () => {
    const provider = mockProviderWithProbe({ id: 'usage-anchor-regression' });
    provider.capabilities.streaming = false;
    let lastRequestCount = 0;
    provider.complete = async (req) => {
      lastRequestCount = req.messages.length;
      return {
        model: req.model,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 1000, output: 1 },
      };
    };
    const { agent, ctx, tmp, session } = await buildAgentWithProbe(provider);
    try {
      await agent.run('first', {});
      await agent.run('second', {});
      expect(ctx.lastRealInputTokens).toBe(1000);
      expect(ctx.meta['realAnchorMsgCount']).toBe(lastRequestCount);
    } finally {
      resetCalibration(`${provider.id}/test-model`);
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('attributes an in-flight response to its captured provider rather than a live switch', async () => {
    const provider = mockProviderWithProbe({ id: 'usage-original-provider' });
    provider.capabilities.streaming = false;
    const replacement = mockProviderWithProbe({ id: 'usage-replacement-provider' });
    const oldKey = `${provider.id}/test-model`;
    const newKey = `${replacement.id}/test-model`;
    resetCalibration(oldKey);
    resetCalibration(newKey);
    const { agent, ctx, tmp, session } = await buildAgentWithProbe(provider);
    provider.complete = async (req) => {
      const raw = estimateRequestTokens(req.messages, req.system, req.tools ?? [], oldKey).total;
      ctx.provider = replacement;
      return {
        model: req.model,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: raw, output: 1 },
      };
    };
    try {
      await agent.run('hello', {});
      expect(getCalibrationState(oldKey).count).toBe(1);
      expect(getCalibrationState(newKey).count).toBe(0);
      expect(ctx.lastRealInputTokens).toBeUndefined();
    } finally {
      resetCalibration(oldKey);
      resetCalibration(newKey);
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('context accounting at async request boundaries', () => {
  it.each(['provider response', 'request pipeline', 'trailing user block'])(
    'does not resurrect an old usage anchor after history replacement during %s',
    async (stage) => {
      const provider = mockProviderWithProbe({ id: 'inflight-history-regression' });
      provider.capabilities.streaming = false;
      const key = `${provider.id}/test-model`;
      resetCalibration(key);
      const { agent, ctx, pipelines, tmp, session } = await buildAgentWithProbe(provider);
      const rewrite = () =>
        ctx.state.replaceMessages([{ role: 'user', content: 'rewritten '.repeat(10000) }]);
      if (stage === 'request pipeline')
        pipelines.request.use({
          name: 'history-rewrite',
          handler: async (req: Request, next: NextFn<Request>) => {
            rewrite();
            return next(req);
          },
        });
      provider.complete = async (req) => {
        const input = estimateRequestTokens(req.messages, req.system, req.tools ?? [], key).total;
        if (stage === 'provider response') rewrite();
        if (stage === 'trailing user block')
          ctx.state.appendBlockToLastUserMessage({ type: 'text', text: 'extra '.repeat(10000) });
        return {
          model: req.model,
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: { input, output: 1 },
        };
      };
      try {
        await agent.run('hello', {});
        expect(getCalibrationState(key).count).toBe(1);
        expect(ctx.lastRealInputTokens).toBeUndefined();
        expect(ctx.meta['realAnchorMsgCount']).toBeUndefined();
      } finally {
        resetCalibration(key);
        await session.close();
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each(['system', 'messages', 'tool schema', 'dense system', 'dense message'])(
    'does not send oversized pipeline %s after compacting only durable history',
    async (field) => {
      const provider = mockProviderWithProbe({
        id: 'request-budget-regression',
        maxContext: 10000,
      });
      provider.capabilities.streaming = false;
      let providerCalls = 0;
      provider.complete = async (req) => {
        providerCalls++;
        return {
          model: req.model,
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: { input: 10, output: 1 },
        };
      };
      const { agent, ctx, pipelines, tmp, session } = await buildAgentWithProbe(provider);
      pipelines.contextWindow.use({
        name: 'AutoCompaction',
        handler: new AutoCompactionMiddleware(createStrategyCompactor(), 10000, undefined, {
          warn: 0.5,
          soft: 0.75,
          hard: 0.9,
        }).handler(),
      });
      pipelines.request.use({
        name: 'oversized-wire-context',
        handler: async (req: Request, next: NextFn<Request>) => {
          const payload = field.startsWith('dense') ? '漢字'.repeat(10000) : 'extra '.repeat(10000);
          if (field === 'system' || field === 'dense system')
            return next({
              ...req,
              system: [...(req.system ?? []), { type: 'text', text: payload }],
            });
          if (field === 'tool schema')
            return next({
              ...req,
              tools: [
                {
                  name: 'large',
                  description: 'test',
                  permission: 'auto',
                  mutating: false,
                  inputSchema: { type: 'object', properties: { value: { enum: [payload] } } },
                  execute: async () => ({}),
                },
              ],
            });
          return next({ ...req, messages: [...req.messages, { role: 'user', content: payload }] });
        },
      });
      try {
        const result = await agent.run('hello', {});
        expect(providerCalls).toBe(0);
        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('AGENT_CONTEXT_OVERFLOW');
        expect(ctx.messages[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
      } finally {
        resetCalibration(`${provider.id}/test-model`);
        await session.close();
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );
});

describe('pre-send overflow rescue', () => {
  it('compacts history to make room for wire-only content instead of failing the turn', async () => {
    const provider = mockProviderWithProbe({ id: 'presend-rescue', maxContext: 10000 });
    provider.capabilities.streaming = false;
    const sent: number[] = [];
    const key = `${provider.id}/test-model`;
    provider.complete = async (req) => {
      sent.push(estimateRequestTokens(req.messages, req.system, req.tools ?? [], key).total);
      return {
        model: req.model,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 10, output: 1 },
      };
    };
    const { agent, ctx, pipelines, tmp, session } = await buildAgentWithProbe(provider);
    // Durable history the compactor measures as below its hard line...
    for (let i = 0; i < 6; i++) {
      ctx.state.appendMessage({ role: 'user', content: `turn ${i} ${'history '.repeat(230)}` });
      ctx.state.appendMessage({
        role: 'assistant',
        content: `reply ${i} ${'answer '.repeat(230)}`,
      });
    }
    pipelines.contextWindow.use({
      name: 'AutoCompaction',
      handler: new AutoCompactionMiddleware(createStrategyCompactor(), 10000, undefined, {
        warn: 0.7,
        soft: 0.8,
        hard: 0.9,
      }).handler(),
    });
    // ...plus wire-only content it never sees pushes the real request over.
    pipelines.request.use({
      name: 'wire-only-system',
      handler: async (req: Request, next: NextFn<Request>) =>
        next({
          ...req,
          system: [...(req.system ?? []), { type: 'text', text: 'injected '.repeat(1500) }],
        }),
    });
    try {
      const historyTokens = estimateRequestTokens(ctx.messages, ctx.systemPrompt, [], key).total;
      expect(historyTokens).toBeLessThan(9000 * 0.7);
      const result = await agent.run('hello', {});
      expect(result.status).not.toBe('failed');
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0]).toBeLessThanOrEqual(9000);
      expect(ctx.messages.at(-1)?.role).toBe('assistant');
    } finally {
      resetCalibration(key);
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('compaction failure does not end the turn', () => {
  it('sends a request that still fits when the compactor fails at hard pressure', async () => {
    const provider = mockProviderWithProbe({ id: 'compactor-failure', maxContext: 10000 });
    provider.capabilities.streaming = false;
    let providerCalls = 0;
    provider.complete = async (req) => {
      providerCalls++;
      return {
        model: req.model,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 10, output: 1 },
      };
    };
    const { agent, ctx, pipelines, tmp, session } = await buildAgentWithProbe(provider);
    for (let i = 0; i < 6; i++) {
      ctx.state.appendMessage({ role: 'user', content: `turn ${i} ${'history '.repeat(330)}` });
      ctx.state.appendMessage({
        role: 'assistant',
        content: `reply ${i} ${'answer '.repeat(330)}`,
      });
    }
    const failing = {
      async compact(): Promise<never> {
        throw new Error('summarizer unavailable');
      },
    };
    pipelines.contextWindow.use({
      name: 'AutoCompaction',
      handler: new AutoCompactionMiddleware(failing as never, 10000, undefined, {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      }).handler(),
    });
    try {
      const key = `${provider.id}/test-model`;
      const historyTokens = estimateRequestTokens(ctx.messages, ctx.systemPrompt, [], key).total;
      // Above the 0.9 hard line of the 9000-token input budget, still under it.
      expect(historyTokens).toBeGreaterThan(9000 * 0.9);
      expect(historyTokens).toBeLessThan(9000);
      const result = await agent.run('hello', {});
      expect(result.status).toBe('done');
      expect(providerCalls).toBe(1);
    } finally {
      resetCalibration(`${provider.id}/test-model`);
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('append-only history while a provider response is pending', () => {
  it('preserves the old request anchor and counts appended messages as its unsent delta', async () => {
    const provider = mockProviderWithProbe({ id: 'inflight-append-regression' });
    provider.capabilities.streaming = false;
    const { agent, ctx, tmp, session } = await buildAgentWithProbe(provider);
    provider.complete = async (req) => {
      ctx.state.appendMessage({ role: 'user', content: 'unsent queued input' });
      return {
        model: req.model,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 1000, output: 1 },
      };
    };
    try {
      const result = await agent.run('hello', {});
      expect(result.status).toBe('done');
      expect(ctx.lastRealInputTokens).toBe(1000);
      expect(ctx.meta['realAnchorMsgCount']).toBe(1);
      expect(ctx.messages[1]?.content).toBe('unsent queued input');
    } finally {
      resetCalibration(`${provider.id}/test-model`);
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('prepared-request budget route identity', () => {
  it('uses the captured route window when a pipeline switches the live provider', async () => {
    const provider = mockProviderWithProbe({ id: 'captured-budget-route', maxContext: 1000000 });
    provider.capabilities.streaming = false;
    const { agent, ctx, pipelines, tmp, session } = await buildAgentWithProbe(provider);
    const replacement = mockProviderWithProbe({ id: 'live-budget-route', maxContext: 1000 });
    let calls = 0;
    provider.complete = async (req) => {
      calls++;
      return {
        model: req.model,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 100, output: 1 },
      };
    };
    pipelines.contextWindow.use({
      name: 'AutoCompaction',
      handler: new AutoCompactionMiddleware(createStrategyCompactor(), 1000000, undefined, {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      }).handler(),
    });
    pipelines.request.use({
      name: 'switch-live-provider',
      handler: async (req: Request, next: NextFn<Request>) => {
        ctx.provider = replacement;
        return next({
          ...req,
          system: [...(req.system ?? []), { type: 'text', text: 'extra '.repeat(10000) }],
        });
      },
    });
    try {
      const result = await agent.run('hello', {});
      expect(calls).toBe(1);
      expect(result.status).toBe('done');
      expect(ctx.lastRealInputTokens).toBeUndefined();
    } finally {
      resetCalibration(`${provider.id}/test-model`);
      resetCalibration(`${replacement.id}/test-model`);
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('usage anchor prompt basis', () => {
  const changePrompt = (ctx: Context, changed: string) => {
    if (changed === 'system') ctx.systemPrompt = [{ type: 'text', text: 'new '.repeat(10000) }];
    else
      ctx.tools = [
        {
          name: 'large',
          description: 'test',
          permission: 'auto',
          mutating: false,
          inputSchema: { type: 'object', properties: { value: { enum: ['new '.repeat(10000)] } } },
          execute: async () => ({}),
        },
      ];
  };

  it.each(['system', 'tools'])(
    'invalidates real usage after the %s basis changes',
    async (changed) => {
      const provider = mockProviderWithProbe({ id: 'usage-basis-regression' });
      provider.capabilities.streaming = false;
      provider.complete = async (req) => ({
        model: req.model,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 1000, output: 1 },
      });
      const { agent, ctx, pipelines, events, tmp, session } = await buildAgentWithProbe(provider);
      try {
        await agent.run('hello', {});
        expect(ctx.lastRealInputTokens).toBe(1000);
        changePrompt(ctx, changed);
        let tokens = 0;
        events.on('ctx.pct', (event) => {
          tokens = event.tokens;
        });
        const m = createAgentLoopContextManager(
          { ctx, events, pipelines } as unknown as AgentInternals,
          { response: {} as never },
        );
        m.emitContextPct();
        expect(tokens).toBeGreaterThan(2000);
        expect(ctx.lastRealInputTokens).toBeUndefined();
      } finally {
        resetCalibration(`${provider.id}/test-model`);
        await session.close();
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each(['system', 'tools'])(
    'does not adopt stale usage when %s changes during the response',
    async (changed) => {
      const provider = mockProviderWithProbe({ id: 'usage-basis-race' });
      provider.capabilities.streaming = false;
      const { agent, ctx, tmp, session } = await buildAgentWithProbe(provider);
      provider.complete = async (req) => {
        changePrompt(ctx, changed);
        return {
          model: req.model,
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: { input: 1000, output: 1 },
        };
      };
      try {
        await agent.run('hello', {});
        expect(ctx.lastRealInputTokens).toBeUndefined();
      } finally {
        resetCalibration(`${provider.id}/test-model`);
        await session.close();
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it('anchors the durable prefix rather than counting wire-only messages', async () => {
    const provider = mockProviderWithProbe({ id: 'usage-wire-prefix' });
    provider.capabilities.streaming = false;
    provider.complete = async (req) => ({
      model: req.model,
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 1000, output: 1 },
    });
    const { agent, ctx, pipelines, events, tmp, session } = await buildAgentWithProbe(provider);
    pipelines.request.use({
      name: 'wire-only-message',
      handler: async (req: Request, next: NextFn<Request>) =>
        next({
          ...req,
          messages: [...req.messages, { role: 'user', content: 'temporary evidence' }],
        }),
    });
    let tokens = 0;
    events.on('ctx.pct', (event) => {
      tokens = event.tokens;
    });
    try {
      await agent.run('hello', {});
      expect(ctx.messages).toHaveLength(2);
      expect(ctx.meta['realAnchorMsgCount']).toBe(1);
      expect(tokens).toBeGreaterThan(1000);
    } finally {
      resetCalibration(`${provider.id}/test-model`);
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('fresh request stash after usage-basis invalidation', () => {
  it('still compacts wire-only additions after a new prompt invalidates the previous usage anchor', async () => {
    const provider = mockProviderWithProbe({ id: 'fresh-wire-stash', maxContext: 10000 });
    provider.capabilities.streaming = false;
    provider.complete = async (req) => ({
      model: req.model,
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 1000, output: 1 },
    });
    const { agent, ctx, events, pipelines, tmp, session } = await buildAgentWithProbe(provider);
    try {
      await agent.run('hello', {});
      ctx.systemPrompt = [{ type: 'text', text: 'new epoch' }];
      const m = createAgentLoopContextManager(
        { ctx, events, pipelines } as unknown as AgentInternals,
        { response: {} as never },
      );
      const prepared = m.stashRequestTokens({
        model: ctx.model,
        messages: ctx.messages,
        tools: ctx.tools,
        system: [...ctx.systemPrompt, { type: 'text', text: 'fresh '.repeat(3000) }],
      });
      expect(prepared.total).toBeGreaterThan(5000);
      const compact = vi.fn(async () => ({
        before: prepared.total,
        after: 4000,
        fullRequestTokensBefore: prepared.total,
        fullRequestTokensAfter: 4000,
        reductions: [],
      }));
      const mw = new AutoCompactionMiddleware({ compact }, 10000, undefined, {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      });
      await mw.handler()(ctx, async (c) => c);
      expect(compact).toHaveBeenCalledOnce();
      expect(ctx.lastRealInputTokens).toBeUndefined();
      expect(ctx.lastRequestTokens).toBe(prepared.total);
    } finally {
      resetCalibration(`${provider.id}/test-model`);
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
