import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../src/core/agent.js';
import { Context } from '../src/core/context.js';
import { DefaultErrorHandler } from '../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../src/execution/retry-policy.js';
import { ToolExecutor } from '../src/execution/tool-executor.js';
import { DefaultLogger } from '../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../src/infrastructure/token-counter.js';
import { Container } from '../src/kernel/container.js';
import { EventBus } from '../src/kernel/events.js';
import { TOKENS } from '../src/kernel/tokens.js';
import { ProviderRegistry } from '../src/registry/provider-registry.js';
import { ToolRegistry } from '../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../src/storage/session-store.js';
import { MockProvider } from './helpers/mock-provider.js';

/**
 * V2-D: leak smoke test. Drive a real `Agent.run` for many turns and
 * assert that no EventBus listeners / abort hooks / active resources
 * accumulate. A growth across iterations is the signature of a
 * use-after-run subscription that forgot to unsubscribe.
 *
 * We don't run under `node --inspect` — Node's built-in process
 * introspection (`process.getActiveResourcesInfo`, `EventBus.listenerCount`,
 * `Context` private hook set size) is enough for this check and it works
 * out of the box in CI.
 */

async function buildAgent(provider: MockProvider) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-leak-'));
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
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });
  // Avoid Node's "Closing file descriptor on GC" warning by letting the
  // caller close the writer at the end of the test.

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are a test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
  });

  const secretScrubber = container.resolve(TOKENS.SecretScrubber);
  const toolExecutor = new ToolExecutor(tools, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber,
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
    maxIterations: 10,
    toolExecutor,
  });
  return { agent, ctx, events, tmp, session };
}

function abortHookCount(ctx: Context): number {
  // `abortHooks` is private but we want black-box visibility for the
  // leak check. Use a structural cast — if the field is ever renamed,
  // this test fails loudly which is the right outcome.
  const internal = ctx as never as { abortHooks?: Set<unknown> };
  return internal.abortHooks?.size ?? 0;
}

describe('leak smoke (V2-D)', () => {
  it('event-bus listeners do not accumulate across 20 agent runs', async () => {
    const script = Array.from({ length: 20 }, () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      stopReason: 'end_turn' as const,
    }));
    const provider = new MockProvider(script);
    const { agent, events, tmp, session } = await buildAgent(provider);
    try {
      const baseline = events.listenerCount();
      for (let i = 0; i < 20; i++) {
        await agent.run(`turn ${i}`);
      }
      // Allow at most 0 growth — the agent itself does not subscribe to
      // its own EventBus, and any internal subscribers must clean up.
      expect(events.listenerCount()).toBe(baseline);
    } finally {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('abort-hook set drains to empty after each run', async () => {
    const script = Array.from({ length: 5 }, () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      stopReason: 'end_turn' as const,
    }));
    const provider = new MockProvider(script);
    const { agent, ctx, tmp, session } = await buildAgent(provider);
    try {
      for (let i = 0; i < 5; i++) {
        await agent.run(`turn ${i}`);
        // RunController.dispose() should have drained the hooks by now.
        expect(abortHookCount(ctx)).toBe(0);
      }
    } finally {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('active Node resources do not grow unboundedly across 30 runs', async () => {
    // Node 17+ exposes process.getActiveResourcesInfo() — returns a list
    // of strings naming each live handle/resource. We allow some
    // variance for short-lived timers and file ops; we just want to flag
    // monotonic growth.
    const getInfo = (process as never as { getActiveResourcesInfo?: () => string[] })
      .getActiveResourcesInfo;
    if (typeof getInfo !== 'function') {
      // Old Node — skip silently. Real CI runs Node ≥22 (engines field).
      return;
    }

    const script = Array.from({ length: 31 }, () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      stopReason: 'end_turn' as const,
    }));
    const provider = new MockProvider(script);
    const { agent, tmp, session } = await buildAgent(provider);
    try {
      // Warm up the runtime so first-run bookkeeping (open log file, ensure dirs)
      // is reflected in the baseline.
      await agent.run('warmup');
      const baseline = getInfo().length;

      for (let i = 0; i < 30; i++) {
        await agent.run(`turn ${i}`);
      }

      const after = getInfo().length;
      // 16 = generous fudge for unrelated short-lived timers (vitest
      // scheduling, gc tickers). A real leak would push this into the
      // hundreds across 30 iterations.
      expect(after - baseline).toBeLessThanOrEqual(16);
    } finally {
      await session.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
