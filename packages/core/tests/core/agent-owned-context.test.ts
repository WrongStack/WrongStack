/**
 * A provider that keeps its own context (an ACP agent leading the session):
 * the context bar shows the agent's own report, not the turn's summed usage
 * or the transcript's size, and WrongStack neither compacts the transcript
 * nor refuses it as an overflow. `/compact` asks the agent instead.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { CompactReport } from '@wrongstack/contracts/types/compactor';
import type { Message } from '@wrongstack/contracts/types/messages';
import type {
  AgentContextUsage,
  Capabilities,
  Provider,
  StreamEvent,
} from '@wrongstack/contracts/types/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { recordAgentContext } from '../../src/core/agent-owned-context.js';
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
import { estimateRequestTokens } from '../../src/utils/token-estimate.js';

const AGENT_CONTEXT: AgentContextUsage = { used: 42_000, size: 200_000 };

function agentProvider(keepsOwnContext: boolean): Provider {
  return {
    id: 'acp',
    // A small window the transcript below overflows: an ordinary provider
    // would compact it; one keeping its own context must leave it alone.
    capabilities: {
      maxContext: 1_000,
      streaming: true,
      tools: true,
      keepsOwnContext,
    } as Capabilities,
    async complete() {
      throw new Error('not used');
    },
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: 'message_start', model: 'claude-code' };
      yield { type: 'content_block_start', kind: 'text' };
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'content_block_stop', index: 0 };
      yield {
        type: 'message_stop',
        stopReason: 'end_turn',
        // A ten-call turn: the summed spend, far above the agent's context.
        usage: { input: 30_000, output: 2_000, cacheRead: 380_000 },
        ...(keepsOwnContext ? { agentContext: AGENT_CONTEXT } : {}),
      };
    },
  };
}

const longTranscript: Message[] = Array.from({ length: 8 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `${'transcript line '.repeat(60)}${i}`,
})) as Message[];

const noopReport = (): CompactReport => ({
  before: 0,
  after: 0,
  fullRequestTokensBefore: 0,
  fullRequestTokensAfter: 0,
  reductions: [],
});

async function buildAgent(keepsOwnContext: boolean) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-owned-ctx-'));
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
  const provider = agentProvider(keepsOwnContext);
  const events = new EventBus();
  const pipelines = createDefaultPipelines();
  const session = await new DefaultSessionStore({ dir: path.join(tmp, 'sessions') }).create({
    id: '',
    model: 'claude-code',
    provider: 'acp',
  });
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are a test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'claude-code',
    tools: [],
  });
  ctx.state.replaceMessages(longTranscript);
  const compact = vi.fn(async () => noopReport());
  const auto = new AutoCompactionMiddleware(
    { compact },
    provider.capabilities.maxContext,
    (c) =>
      estimateRequestTokens(c.messages, c.systemPrompt, c.tools ?? [], 'acp/claude-code').total,
    { warn: 0.1, soft: 0.2, hard: 0.3 },
    { events },
  );
  pipelines.contextWindow.use({ name: 'AutoCompaction', handler: auto.handler() });
  const tools = new ToolRegistry();
  const agent = new Agent({
    container,
    tools,
    providers: new ProviderRegistry(),
    events,
    pipelines,
    context: ctx,
    toolExecutor: new ToolExecutor(tools, {
      permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: 300_000,
      perIterationOutputCapBytes: 100_000,
      tracer: undefined,
    }),
    maxIterations: 4,
  });
  const cleanup = async () => {
    await session.close();
    await fs.rm(tmp, { recursive: true, force: true });
  };
  return { agent, events, ctx, compact, cleanup };
}

describe('a provider that keeps its own context', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('control: an ordinary provider compacts the same transcript', async () => {
    const built = await buildAgent(false);
    cleanup = built.cleanup;
    await built.agent.run('next', {}).catch(() => undefined);
    expect(built.compact).toHaveBeenCalled();
  });

  it("shows the agent's context, never compacts the transcript, and sends it whole", async () => {
    const built = await buildAgent(true);
    cleanup = built.cleanup;
    const fills: Array<{ tokens: number; maxContext: number }> = [];
    built.events.on('ctx.pct', (e) => fills.push({ tokens: e.tokens, maxContext: e.maxContext }));

    const result = await built.agent.run('next', {});

    expect(result.status).toBe('done');
    expect(built.compact).not.toHaveBeenCalled();
    expect(built.ctx.messages.slice(0, longTranscript.length)).toEqual(longTranscript);
    expect(fills.at(-1)).toEqual({ tokens: 42_000, maxContext: 200_000 });
    // The statusline's per-request snapshot: the agent's context, not the summed spend.
    expect(built.ctx.tokenCounter.currentRequestTokens().input).toBe(42_000);
  });

  it('/compact asks the agent and reports what its context kept', async () => {
    const built = await buildAgent(true);
    cleanup = built.cleanup;
    recordAgentContext(built.ctx, AGENT_CONTEXT);
    const compactOwnContext = vi.fn(async () => ({ used: 9_000, size: 200_000 }));
    Object.assign(built.ctx.provider, { compactOwnContext });

    const report = await createStrategyCompactor().compact(built.ctx, { trigger: 'manual' });

    expect(compactOwnContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: built.ctx.session.id }),
    );
    expect(report).toMatchObject({
      before: 42_000,
      after: 9_000,
      reductions: [{ phase: 'summary', saved: 33_000 }],
    });
    expect(built.ctx.messages).toEqual(longTranscript);
  });

  it('/compact says so when the agent cannot compact on request', async () => {
    const built = await buildAgent(true);
    cleanup = built.cleanup;
    await expect(createStrategyCompactor().compact(built.ctx)).rejects.toThrow(
      /manages its own context/,
    );
  });
});
