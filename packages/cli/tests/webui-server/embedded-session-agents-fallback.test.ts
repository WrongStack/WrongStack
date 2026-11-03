/**
 * The CLI-hosted WebUI gives every tab its own Agent through
 * `createEmbeddedSessionAgents`. Like the standalone engine's conversations, each of those
 * agents needs its OWN `fallback-model` extension, or a configured `fallbackModels` chain never
 * engages in a second tab: a retryable primary failure just ends the turn.
 *
 * Real Agent, Context, EventBus, registries and session agent registry; only the providers are
 * in-memory fakes.
 */

import { Container, EventBus, type EventMap, TOKENS } from '@wrongstack/contracts/kernel';
import {
  type Config,
  type Provider,
  ProviderError,
  type Request,
  type Response,
} from '@wrongstack/contracts/types';
import {
  Agent,
  type Context,
  Context as ContextClass,
  createDefaultPipelines,
} from '@wrongstack/core/agent';
import { DefaultErrorHandler, DefaultRetryPolicy, ToolExecutor } from '@wrongstack/core/execution';
import { DefaultLogger, DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultPermissionPolicy, DefaultSecretScrubber } from '@wrongstack/core/security';
import { describe, expect, it } from 'vitest';
import { createEmbeddedSessionAgents } from '../../src/webui-server/session-agents.js';

function fakeProvider(id: string): Provider {
  return {
    id,
    // The backup model has a smaller window than the primary.
    capabilities: {
      maxContext: id === 'backup' ? 128_000 : 1_000_000,
      streaming: false,
      tools: true,
    } as never,
    complete: async () => {
      throw new Error('not called directly');
    },
    // biome-ignore lint/correctness/useYield: never streamed in this test
    stream: async function* () {
      throw new Error('not streamed');
    },
  } as unknown as Provider;
}

/** The `primary` provider always fails retryably; every other one answers. */
async function innerRunner(ctx: Context, _req: Request): Promise<Response> {
  if (ctx.provider.id === 'primary')
    throw new ProviderError('overloaded', 529, true, 'primary', { kind: 'overloaded' });
  return {
    content: [{ type: 'text', text: `answered by ${ctx.provider.id}/${ctx.model}` }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 1 },
    model: ctx.model,
  } as Response;
}

function harness(appConfig: Config | undefined) {
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
  for (const type of ['primary', 'backup'])
    providers.register({ type, family: 'openai', create: () => fakeProvider(type) } as never);
  const tools = new ToolRegistry();
  const events = new EventBus();
  const context = new ContextClass({
    systemPrompt: [{ type: 'text', text: 'test' }],
    provider: fakeProvider('primary'),
    session: { id: 'leader-session', traceId: 't' } as never,
    signal: new AbortController().signal,
    tokenCounter: new DefaultTokenCounter(),
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    model: 'p-model',
  });
  // The leader's resolved window, which every new tab copies as a host-level fact.
  context.meta['effectiveMaxContext'] = 1_000_000;
  const template = new Agent({
    container,
    tools,
    providers,
    events,
    pipelines: createDefaultPipelines(),
    context,
    maxIterations: 5,
    toolExecutor: new ToolExecutor(tools, {
      permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: 300_000,
      perIterationOutputCapBytes: 100_000,
      tracer: undefined,
    }),
  });
  const pending: Array<EventMap['provider.fallback_pending']> = [];
  events.on('provider.fallback_pending', (payload) => {
    pending.push(payload);
    setImmediate(() =>
      events.emit('provider.fallback_choice', { requestId: payload.requestId, autoSwitch: true }),
    );
  });
  const { sessionAgents } = createEmbeddedSessionAgents(
    { agent: template, events, appConfig } as never,
    new Map(),
    new Map(),
  );
  return { sessionAgents, template, pending };
}

const config = {
  provider: 'primary',
  model: 'p-model',
  providers: {
    primary: { type: 'primary', models: ['p-model'] },
    backup: { type: 'backup', models: ['b-model'] },
  },
  fallbackModels: ['backup/b-model'],
  features: {},
  tools: {},
} as unknown as Config;
const request = { model: 'p-model', messages: [] } as unknown as Request;

describe('CLI-hosted WebUI tabs carry their own fallback-model extension', () => {
  it('a second tab falls back through the gate on a retryable primary failure', async () => {
    const { sessionAgents, pending } = harness(config);
    const tab = sessionAgents.get('tab-2');
    expect(tab.extensions.list()).toContain('fallback-model');
    const response = await tab.extensions.wrapProviderRunner(innerRunner)(tab.ctx, request);
    expect(pending[0]?.['sessionId']).toBe('tab-2');
    expect((response.content[0] as { text: string }).text).toBe('answered by backup/b-model');
    expect(tab.ctx.provider.id).toBe('backup');
  });
  it("a hop moves the tab's own context window, not the leader's", async () => {
    // The compaction threshold reads the context's own `effectiveMaxContext` before the
    // provider's window, so a tab that kept the copied 1M window would compact far too late
    // on the 128k backup.
    const { sessionAgents, template } = harness(config);
    const tab = sessionAgents.get('tab-2');
    expect(tab.ctx.meta['effectiveMaxContext']).toBe(1_000_000);
    await tab.extensions.wrapProviderRunner(innerRunner)(tab.ctx, request);
    expect(tab.ctx.meta['effectiveMaxContext']).toBe(128_000);
    expect(template.ctx.meta['effectiveMaxContext']).toBe(1_000_000);
  });
  it('tabs fail over independently', async () => {
    const { sessionAgents } = harness(config);
    const a = sessionAgents.get('tab-a'),
      b = sessionAgents.get('tab-b');
    await a.extensions.wrapProviderRunner(innerRunner)(a.ctx, request);
    expect(a.ctx.provider.id).toBe('backup');
    expect(b.ctx.provider.id).toBe('primary');
  });
});
