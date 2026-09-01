import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { Container } from '../../src/kernel/container.js';
import { EventBus } from '../../src/kernel/events.js';
import { TOKENS } from '../../src/kernel/tokens.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { Capabilities, Provider, Response } from '../../src/types/provider.js';

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

  return { agent, events, ctx, tmp, session };
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
