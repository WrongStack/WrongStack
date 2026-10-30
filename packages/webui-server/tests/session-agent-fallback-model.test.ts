/**
 * The standalone engine (`startWebUI`, what the desktop app runs) builds one
 * Agent per conversation through `createSessionAgentManager`. Every one of
 * those agents must carry its OWN `fallback-model` extension, wired with a
 * fallback gate, or a configured `fallbackModels` chain never engages: a
 * retryable primary failure just kills the turn.
 *
 * Everything here is real (Agent, Context, EventBus, ProviderRegistry,
 * ToolExecutor, the session agent manager) except the providers, which are
 * in-memory fakes so no network is touched.
 */

import { Container, EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import {
  type Config,
  type Provider,
  ProviderError,
  type Request,
  type Response,
} from '@wrongstack/contracts/types';
import { Agent, Context, createDefaultPipelines } from '@wrongstack/core/agent';
import { DefaultErrorHandler, DefaultRetryPolicy, ToolExecutor } from '@wrongstack/core/execution';
import { DefaultLogger, DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultPermissionPolicy, DefaultSecretScrubber } from '@wrongstack/core/security';
import { describe, expect, it } from 'vitest';
import { createSessionAgentManager } from '../src/server/create-session-agent-manager.js';

function fakeProvider(id: string): Provider {
  return {
    id,
    capabilities: { maxContext: 200_000, streaming: false, tools: true } as never,
    complete: async () => {
      throw new Error('not called directly');
    },
    // biome-ignore lint/correctness/useYield: never streamed in this test
    stream: async function* () {
      throw new Error('not streamed');
    },
  } as unknown as Provider;
}

function overloaded(providerId: string): ProviderError {
  return new ProviderError('overloaded', 529, true, providerId, { kind: 'overloaded' });
}

/** Inner runner: the `primary` provider always fails retryably, every other one answers. */
async function innerRunner(ctx: Context, _req: Request): Promise<Response> {
  if (ctx.provider.id === 'primary') throw overloaded('primary');
  return {
    content: [{ type: 'text', text: `answered by ${ctx.provider.id}/${ctx.model}` }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 1 },
    model: ctx.model,
  } as Response;
}

function harness(configOverrides: Partial<Config> = {}) {
  let liveConfig = {
    provider: 'primary',
    model: 'p-model',
    providers: {
      primary: { type: 'primary', models: ['p-model'] },
      backup: { type: 'backup', models: ['b-model'] },
      third: { type: 'third', models: ['t-model'] },
    },
    fallbackModels: ['backup/b-model'],
    features: {},
    tools: {},
    ...configOverrides,
  } as unknown as Config;

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: '/nonexistent/trust.json', yolo: true }),
  );

  const providers = new ProviderRegistry();
  for (const type of ['primary', 'backup', 'third']) {
    providers.register({ type, family: 'openai', create: () => fakeProvider(type) } as never);
  }
  const tools = new ToolRegistry();
  const events = new EventBus();
  const pipelines = createDefaultPipelines();
  const tokenCounter = new DefaultTokenCounter();
  const context = new Context({
    systemPrompt: [{ type: 'text', text: 'test' }],
    provider: fakeProvider('primary'),
    session: { id: 'leader-session', traceId: 't' } as never,
    signal: new AbortController().signal,
    tokenCounter,
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    model: 'p-model',
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
  const template = new Agent({
    container,
    tools,
    providers,
    events,
    pipelines,
    context,
    maxIterations: 5,
    toolExecutor,
  });

  const { sessionAgents } = createSessionAgentManager({
    agent: template,
    MAX_CONCURRENT_SESSION_AGENTS: 4,
    input: { tokenCounter },
    projectRoot: process.cwd(),
    workingDir: process.cwd(),
    context,
    modelsRegistry: undefined as never,
    container,
    toolRegistry: tools,
    providerRegistry: providers,
    events,
    pipelines,
    config: liveConfig,
    getConfig: () => liveConfig,
    toolExecutor,
  });

  // A UI surface: answers every fallback modal with "auto-switch".
  const pending: Array<Record<string, unknown>> = [];
  events.on('provider.fallback_pending', (payload) => {
    const p = payload as Record<string, unknown>;
    pending.push(p);
    setImmediate(() =>
      events.emit('provider.fallback_choice', { requestId: p['requestId'], autoSwitch: true }),
    );
  });

  return {
    sessionAgents,
    setConfig: (next: Partial<Config>) => {
      liveConfig = { ...liveConfig, ...next } as Config;
    },
    pending,
  };
}

const request = { model: 'p-model', messages: [] } as unknown as Request;

describe('standalone session agents carry the fallback-model extension', () => {
  it('a non-leader session agent falls back through the gate on a retryable primary failure', async () => {
    const { sessionAgents, pending } = harness();
    const agent = sessionAgents.get('tab-2');

    expect(agent.extensions.list()).toContain('fallback-model');

    const run = agent.extensions.wrapProviderRunner(innerRunner);
    const response = await run(agent.ctx, request);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.['sessionId']).toBe('tab-2');
    expect(pending[0]?.['candidates']).toEqual([{ providerId: 'backup', model: 'b-model' }]);
    expect((response.content[0] as { text: string }).text).toBe('answered by backup/b-model');
    expect(agent.ctx.provider.id).toBe('backup');
    expect(agent.ctx.model).toBe('b-model');
  });

  it('each conversation agent owns a separate extension instance', async () => {
    const { sessionAgents } = harness();
    const a = sessionAgents.get('tab-a');
    const b = sessionAgents.get('tab-b');

    expect(a.extensions.list()).toContain('fallback-model');
    expect(b.extensions.list()).toContain('fallback-model');

    // Tab A falls back; tab B is untouched and still on its primary.
    await a.extensions.wrapProviderRunner(innerRunner)(a.ctx, request);
    expect(a.ctx.provider.id).toBe('backup');
    expect(b.ctx.provider.id).toBe('primary');
    expect(b.ctx.model).toBe('p-model');
  });

  it("restores the session's OWN chosen primary, not the global config selection", async () => {
    const { sessionAgents, setConfig } = harness({
      fallbackModels: ['third/t-model'],
      // Probe the primary on the very next turn.
      fallbackStickiness: { primaryProbeInterval: 0 },
    } as Partial<Config>);
    const agent = sessionAgents.get('tab-3');
    // This tab picked primary/p-model; then another tab switched the GLOBAL
    // selection to backup/b-model.
    const { recordConversationPrimary } = await import('../src/server/conversation-fallback.js');
    recordConversationPrimary(agent.ctx, 'primary', 'p-model');
    setConfig({ provider: 'backup', model: 'b-model' });

    await agent.extensions.wrapProviderRunner(innerRunner)(agent.ctx, request);
    expect(agent.ctx.provider.id).toBe('third');

    await agent.extensions.runBeforeRun(agent.ctx as never, 'next turn' as never);
    expect(agent.ctx.provider.id).toBe('primary');
    expect(agent.ctx.model).toBe('p-model');
  });
});
