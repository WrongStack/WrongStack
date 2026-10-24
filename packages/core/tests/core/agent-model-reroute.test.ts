/**
 * A provider-reported server-side reroute (`Response.rerouted`) reaches the
 * event bus as `provider.model_rerouted` — once per change, not per request.
 * Every request of a rerouted ChatGPT account comes back rerouted; a notice
 * each time would bury the conversation, while silence hides that a weaker
 * model is answering.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { Provider, Request, Response } from '@wrongstack/contracts/types/provider';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { streamProviderToResponse } from '../../src/core/streaming-response-builder.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { MockProvider } from '../helpers/mock-provider.js';

const REROUTE = { requested: 'test-model', served: 'fallback-model', reason: 'flagged' };

/** MockProvider whose Nth response carries `rerouted[N]`. */
class ReroutingProvider extends MockProvider {
  constructor(private readonly rerouted: Array<Response['rerouted']>) {
    super(rerouted.map(() => ({ content: [{ type: 'text', text: 'ok' }] })));
  }

  override async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    const index = this.calls;
    const response = await super.complete(req, opts);
    const rerouted = this.rerouted[index];
    return rerouted ? { ...response, rerouted } : response;
  }
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function buildAgent(provider: MockProvider) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-reroute-'));
  dirs.push(tmp);
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: true }),
  );
  const tools = new ToolRegistry();
  const events = new EventBus();
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await sessionStore.create({ id: '', model: 'test-model', provider: 'mock' });
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'test agent' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
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
    providers: new ProviderRegistry(),
    events,
    pipelines: createDefaultPipelines(),
    context: ctx,
    maxIterations: 5,
    toolExecutor,
  });
  return { agent, events, session };
}

describe('provider.model_rerouted', () => {
  it('fires once per change and again after the reroute stops and restarts', async () => {
    const provider = new ReroutingProvider([REROUTE, REROUTE, undefined, REROUTE]);
    const { agent, events, session } = await buildAgent(provider);
    const seen: Array<Record<string, unknown>> = [];
    events.on('provider.model_rerouted', (e) => seen.push(e as never));

    for (const prompt of ['one', 'two', 'three', 'four']) {
      expect((await agent.run(prompt)).status).toBe('done');
    }

    expect(provider.calls).toBe(4);
    // Turns 1 and 4 changed the served model; turn 2 restated it, turn 3 cleared it.
    expect(seen).toHaveLength(2);
    for (const event of seen) {
      expect(event).toMatchObject({
        sessionId: session.id,
        providerId: 'mock',
        requested: 'test-model',
        served: 'fallback-model',
        reason: 'flagged',
      });
    }
  });

  it('never fires for a response the requested model served', async () => {
    const provider = new ReroutingProvider([undefined, undefined]);
    const { agent, events } = await buildAgent(provider);
    let fired = 0;
    events.on('provider.model_rerouted', () => {
      fired += 1;
    });
    await agent.run('one');
    await agent.run('two');
    expect(fired).toBe(0);
  });
});

describe('streamProviderToResponse carries model_rerouted onto the Response', () => {
  it('copies the reroute and leaves the served content intact', async () => {
    const provider: Provider = {
      id: 'fake',
      capabilities: { streaming: true, tools: true, vision: false, reasoning: true },
      async complete() {
        throw new Error('not used');
      },
      async *stream() {
        yield { type: 'message_start', model: 'test-model' };
        yield { type: 'model_rerouted', ...REROUTE };
        yield { type: 'text_delta', text: 'hi' };
        yield { type: 'message_stop', stopReason: 'end_turn', usage: { input: 1, output: 1 } };
      },
    } as never;
    const ctx = { messages: [], activeRunSessionId: '2026-09-30/sess_01REROUTE0000000000000000' };
    const quiet = {
      level: 'info' as const,
      error() {},
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return quiet;
      },
    };
    const response = await streamProviderToResponse(
      provider,
      { model: 'test-model', messages: [] } as Request,
      new AbortController().signal,
      ctx as never,
      new EventBus(),
      quiet,
    );
    expect(response.rerouted).toEqual(REROUTE);
    expect(response.content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});
