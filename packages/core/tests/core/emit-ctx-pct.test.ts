import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { AutoCompactionMiddleware } from '../../src/execution/auto-compaction-middleware.js';
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
import type { Compactor } from '../../src/types/compactor.js';
import type { Message } from '../../src/types/messages.js';
import type { Capabilities, Provider, Request, Response } from '../../src/types/provider.js';
import { estimateRequestTokens } from '../../src/utils/token-estimate.js';

// ── Mock provider that echoes back a fixed text response ─────────────────

function mockProvider(maxContext = 200_000): Provider & {
  requests: Request[];
  complete: (req: Request, opts: { signal: AbortSignal }) => Promise<Response>;
} {
  const requests: Request[] = [];
  const capture = (req: Request) => {
    requests.push({ ...req, messages: [...req.messages] });
  };
  return {
    id: 'mock',
    requests,
    capabilities: {
      maxContext,
      streaming: true,
      tools: true,
      vision: false,
      caching: false,
      parallelism: 0,
    } as Capabilities,
    async complete(req: Request): Promise<Response> {
      capture(req);
      return {
        model: req.model,
        content: [{ type: 'text', text: 'I received your message.' }],
        stopReason: 'end_turn',
        usage: { input: 50, output: 10 },
      };
    },
    async *stream(req: Request): AsyncGenerator<import('../../src/types/provider.js').StreamEvent> {
      capture(req);
      yield { type: 'message_start', model: 'mock' };
      yield { type: 'content_block_start', kind: 'text' };
      yield { type: 'text_delta', text: 'I received your message.' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_stop', stopReason: 'end_turn', usage: { input: 50, output: 10 } };
    },
    health: async () => ({ ok: true }),
  };
}

async function buildAgent(
  opts: {
    maxContext?: number | undefined;
    compactor?: Compactor | undefined;
    initialMessages?: Message[] | undefined;
  } = {},
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-ctxpct-'));
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

  const provider = mockProvider(opts.maxContext);
  const tools = new ToolRegistry();
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const pipelines = createDefaultPipelines();

  const sessionStore = new DefaultSessionStore({ dir: sessionDir });
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are a test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
    tools: [],
  });
  if (opts.initialMessages) ctx.state.replaceMessages(opts.initialMessages);
  if (opts.compactor) {
    const autoCompactor = new AutoCompactionMiddleware(
      opts.compactor,
      provider.capabilities.maxContext,
      (c) =>
        estimateRequestTokens(
          c.messages,
          c.systemPrompt,
          c.tools ?? [],
          `${c.provider?.id ?? 'unknown'}/${c.model}`,
        ).total,
      { warn: 0.1, soft: 0.2, hard: 0.3 },
      { events, failureMode: 'throw_on_hard' },
    );
    pipelines.contextWindow.use({ name: 'AutoCompaction', handler: autoCompactor.handler() });
  }

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

  return { agent, events, ctx, tmp, session, provider };
}

describe('B5 — emitContextPct elision on idle loops', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it('emits ctx.pct on first iteration (initial emit)', async () => {
    const { agent, events, tmp, session } = await buildAgent();
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    const ctxPctEvents: Array<{ load: number; tokens: number }> = [];
    events.on('ctx.pct', (payload) => {
      ctxPctEvents.push({ load: payload.load, tokens: payload.tokens });
    });

    await agent.run('hello', {});

    // After one user turn, ctx.pct should fire exactly once (at end of iteration)
    expect(ctxPctEvents.length).toBe(1);
    expect(ctxPctEvents[0]!.tokens).toBeGreaterThan(0);
    expect(ctxPctEvents[0]!.load).toBeGreaterThan(0);
  });

  it('caps ctx.pct load at 100% while preserving over-budget diagnostics', async () => {
    const { agent, events, tmp, session } = await buildAgent({ maxContext: 100 });
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    const ctxPctEvents: Array<{
      load: number;
      rawLoad?: number;
      tokens: number;
      maxContext: number;
    }> = [];
    events.on('ctx.pct', (payload) => {
      ctxPctEvents.push({
        load: payload.load,
        ...(payload.rawLoad !== undefined ? { rawLoad: payload.rawLoad } : {}),
        tokens: payload.tokens,
        maxContext: payload.maxContext,
      });
    });

    await agent.run('x'.repeat(2_000), {});

    expect(ctxPctEvents.length).toBe(1);
    expect(ctxPctEvents[0]!.tokens).toBeGreaterThan(ctxPctEvents[0]!.maxContext);
    expect(ctxPctEvents[0]!.load).toBe(1);
    expect(ctxPctEvents[0]!.rawLoad).toBeGreaterThan(1);
  });

  it('emits ctx.pct again when messages grow (new user turn)', async () => {
    const { agent, events, tmp, session } = await buildAgent();
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    const ctxPctEvents: Array<{ tokens: number }> = [];
    events.on('ctx.pct', (payload) => {
      ctxPctEvents.push({ tokens: payload.tokens });
    });

    // First turn
    await agent.run('first message', {});
    expect(ctxPctEvents.length).toBe(1);

    // Second turn — messages grew (new user + new assistant)
    await agent.run('second message', {});
    expect(ctxPctEvents.length).toBe(2);

    // Token count should have increased (more messages)
    expect(ctxPctEvents[1]!.tokens).toBeGreaterThan(ctxPctEvents[0]!.tokens);
  });

  it('uses the live provider maxContext after a model switch', async () => {
    const { agent, events, ctx, tmp, session } = await buildAgent();
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    const ctxPctEvents: Array<{ maxContext: number }> = [];
    events.on('ctx.pct', (payload) => {
      ctxPctEvents.push({ maxContext: payload.maxContext });
    });

    await agent.run('first model', {});
    expect(ctxPctEvents[ctxPctEvents.length - 1]?.maxContext).toBe(200_000);

    ctx.provider.capabilities.maxContext = 1_000_000;
    ctx.model = 'larger-context-model';

    await agent.run('second model', {});
    expect(ctxPctEvents[ctxPctEvents.length - 1]?.maxContext).toBe(1_000_000);
  });

  it('emits ctx.pct for each consecutive turn when messages grow', async () => {
    const { agent, events, tmp, session } = await buildAgent();
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    const ctxPctEvents: Array<{ tokens: number }> = [];
    events.on('ctx.pct', (payload) => {
      ctxPctEvents.push({ tokens: payload.tokens });
    });

    // Run three consecutive turns. Each turn adds user + assistant messages,
    // so the message count grows. ctx.pct should fire on every turn.
    await agent.run('turn 1', {});
    await agent.run('turn 2', {});
    await agent.run('turn 3', {});

    // All three turns emitted ctx.pct (because messages grew each time)
    expect(ctxPctEvents.length).toBe(3);

    // Token counts should be strictly increasing
    expect(ctxPctEvents[1]!.tokens).toBeGreaterThan(ctxPctEvents[0]!.tokens);
    expect(ctxPctEvents[2]!.tokens).toBeGreaterThan(ctxPctEvents[1]!.tokens);
  });

  it('rebuilds a request after a same-length compaction rewrite', async () => {
    // These messages exercise replaceMessages mechanics only; production system prompts
    // live on ctx.systemPrompt and never appear in ctx.messages.
    const replacement: Message[] = [
      { role: 'user', content: 'compacted context' },
      { role: 'user', content: 'fresh question' },
    ];
    const compactCalls: number[] = [];
    const compactor: Compactor = {
      async compact(ctx) {
        compactCalls.push(ctx.messages.length);
        const before = estimateRequestTokens(ctx.messages, ctx.systemPrompt, ctx.tools ?? []).total;
        ctx.state.replaceMessages(replacement);
        expect(ctx.messages).toHaveLength(replacement.length);
        const after = estimateRequestTokens(ctx.messages, ctx.systemPrompt, ctx.tools ?? []).total;
        return {
          before,
          after,
          fullRequestTokensBefore: before,
          fullRequestTokensAfter: after,
          reductions: [{ phase: 'summary', saved: Math.max(0, before - after) }],
        };
      },
    };
    const { agent, provider, ctx, tmp, session } = await buildAgent({
      maxContext: 1_000,
      compactor,
      initialMessages: [{ role: 'user', content: `old context ${'x'.repeat(8000)}` }],
    });
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    await agent.run('fresh question', {});

    // The contract is that preflight compaction runs before the single provider request;
    // follow-up loop iterations may legitimately compact again after a successful reduction.
    expect(compactCalls.length).toBeGreaterThanOrEqual(1);
    expect(provider.requests).toHaveLength(1);
    // The request reflects the compaction rewrite; the trailing user message
    // additionally carries the appended live-context tail, so compare the
    // durable content rather than exact array identity.
    const sent = provider.requests[0]!.messages;
    expect(sent).toHaveLength(replacement.length);
    expect(sent[0]).toEqual(replacement[0]);
    const sentLast = sent[1]! as { role: string; content: Array<{ type: string; text?: string }> };
    expect(sentLast.role).toBe('user');
    expect(sentLast.content[0]).toMatchObject({ type: 'text', text: 'fresh question' });
    expect(JSON.stringify(sent)).not.toContain('old context');
    expect(ctx.lastRequestTokens).toBe(
      estimateRequestTokens(ctx.messages, ctx.systemPrompt, ctx.tools ?? []).total,
    );
    expect(ctx.meta['lastRequestTokensAt']).toMatchObject({
      msgCount: ctx.messages.length,
      toolCount: ctx.tools.length,
      revision: ctx.state.revision,
    });
  });

  it('compacts and rebuilds an oversized request before the provider call', async () => {
    const compactCalls: number[] = [];
    const compactor: Compactor = {
      async compact(ctx) {
        compactCalls.push(ctx.messages.length);
        const before = estimateRequestTokens(ctx.messages, ctx.systemPrompt, ctx.tools ?? []).total;
        ctx.state.replaceMessages(ctx.messages.slice(-1));
        const after = estimateRequestTokens(ctx.messages, ctx.systemPrompt, ctx.tools ?? []).total;
        return {
          before,
          after,
          fullRequestTokensBefore: before,
          fullRequestTokensAfter: after,
          reductions: [{ phase: 'summary', saved: Math.max(0, before - after) }],
        };
      },
    };
    const { agent, provider, tmp, session } = await buildAgent({
      maxContext: 1_000,
      compactor,
      initialMessages: [
        { role: 'user', content: `old context ${'x'.repeat(8000)}` },
        { role: 'assistant', content: 'old answer' },
      ],
    });
    cleanup = async () => {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    };

    await agent.run('fresh question', {});

    expect(compactCalls.length).toBeGreaterThan(0);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.messages).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0]!.messages[0]!.content)).toContain('fresh question');
    expect(JSON.stringify(provider.requests[0]!.messages[0]!.content)).not.toContain('old context');
  });
});
