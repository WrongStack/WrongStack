/**
 * End-to-end provider-recovery → prompt-journal coverage.
 *
 * Drives the agent loop's provider-error recovery path: the provider throws a
 * plain Error on the first attempt (kind `unknown` → the retry policy does not
 * retry it, so `runProviderWithRetry` rethrows immediately), the loop's catch
 * hands it to `errorHandler.recover()`, which returns `{ action: 'retry' }`,
 * and the loop records a `self_healing_retry` journal entry under
 * `<projectRoot>/.wrongstack/prompts/` before continuing. The second attempt
 * succeeds, so the run completes normally.
 *
 * This pins the one journal category that is a loop-level event rather than a
 * tool call: the CLI recorder's toolCall middleware cannot see it, so it must
 * be verified against the real loop.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import type { AgentExtension } from '../../src/extension/extension-points.js';
import { ExtensionRegistry } from '../../src/extension/registry.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { Container } from '../../src/kernel/container.js';
import { EventBus } from '../../src/kernel/events.js';
import { TOKENS } from '../../src/kernel/tokens.js';
import { getPromptJournalEntries } from '../../src/prompts/prompt-journal.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { ErrorHandler } from '../../src/types/error-handler.js';
import { MockProvider } from '../helpers/mock-provider.js';

/** Provider that fails once, then serves a normal text response. */
class RecoveringProvider extends MockProvider {
  private failuresLeft = 1;
  /** Total `complete()` invocations, including the failed attempt. */
  attemptCount = 0;

  override async complete(
    req: Parameters<MockProvider['complete']>[0],
    opts: Parameters<MockProvider['complete']>[1],
  ) {
    this.attemptCount++;
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('simulated provider outage');
    }
    return super.complete(req, opts);
  }
}

/** ErrorHandler stub: the first recovery attempt retries the turn. */
class RetryOnceErrorHandler implements ErrorHandler {
  private recovered = false;

  async recover(): Promise<{ action: 'retry'; reason: string } | null> {
    if (!this.recovered) {
      this.recovered = true;
      return { action: 'retry', reason: 'simulated provider recovery' };
    }
    return null;
  }

  classify() {
    return { kind: 'unknown' as const, retryable: false };
  }
}

/** ErrorHandler stub that never recovers — proves the extension drove the retry. */
class NeverRetryErrorHandler implements ErrorHandler {
  async recover(): Promise<null> {
    return null;
  }

  classify() {
    return { kind: 'unknown' as const, retryable: false };
  }
}

/** Extension whose onError hook requests a retry exactly once. */
class RetryOnceExtension implements AgentExtension {
  name = 'retry-once-test';
  private retried = false;

  onError(): { action: 'retry' } | void {
    if (!this.retried) {
      this.retried = true;
      return { action: 'retry' };
    }
    return undefined;
  }
}

async function waitFor<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function buildRecoveringAgent(
  provider: MockProvider,
  opts: { extensions?: ExtensionRegistry; errorHandler?: ErrorHandler } = {},
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-pj-recovery-'));
  const trustFile = path.join(tmp, 'trust.json');
  const sessionDir = path.join(tmp, 'sessions');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => opts.errorHandler ?? new RetryOnceErrorHandler());
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
    providers,
    events,
    pipelines,
    context: ctx,
    maxIterations: 10,
    toolExecutor,
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
  });
  return { agent, ctx, tmp };
}

describe('agent-loop provider recovery → self_healing_retry journal entry', () => {
  let cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    cleanupDirs = [];
  });

  it('records a self_healing_retry entry when errorHandler.recover retries the turn', async () => {
    const provider = new RecoveringProvider([
      { content: [{ type: 'text', text: 'recovered ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildRecoveringAgent(provider);
    cleanupDirs.push(tmp);

    const result = await agent.run('hello', { maxIterations: 10 });

    // The retry succeeded and the run completed normally.
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('recovered ok');
    expect(provider.attemptCount).toBe(2);

    // The journal write is fire-and-forget, so poll for it.
    const entries = await waitFor(
      () => getPromptJournalEntries(tmp),
      (list) => list.some((e) => e.category === 'self_healing_retry'),
    );
    const entry = entries.find((e) => e.category === 'self_healing_retry');
    expect(entry).toBeDefined();
    expect(entry?.content).toContain('simulated provider outage');
    expect(entry?.metadata.decisionReason).toBe('simulated provider recovery');
    expect(entry?.metadata.model).toBe('test-model');
    expect(entry?.metadata.provider).toBe('mock');
    expect(entry?.sessionId).toBeTruthy();
    expect(entry?.projectRoot).toBe(tmp);
  });

  it('records a self_healing_retry entry when an onError extension requests a retry', async () => {
    const provider = new RecoveringProvider([
      { content: [{ type: 'text', text: 'extension recovered ok' }], stopReason: 'end_turn' },
    ]);
    const extensions = new ExtensionRegistry();
    extensions.register(new RetryOnceExtension());
    const { agent, tmp } = await buildRecoveringAgent(provider, {
      extensions,
      // The error handler never recovers, so the retry MUST come from the
      // extension's onError hook — proving the second trigger path.
      errorHandler: new NeverRetryErrorHandler(),
    });
    cleanupDirs.push(tmp);

    const result = await agent.run('hello', { maxIterations: 10 });

    expect(result.status).toBe('done');
    expect(result.finalText).toBe('extension recovered ok');
    expect(provider.attemptCount).toBe(2);

    const entries = await waitFor(
      () => getPromptJournalEntries(tmp),
      (list) => list.some((e) => e.category === 'self_healing_retry'),
    );
    const entry = entries.find((e) => e.category === 'self_healing_retry');
    expect(entry).toBeDefined();
    expect(entry?.content).toContain('simulated provider outage');
    expect(entry?.metadata.decisionReason).toBe('extension-requested provider retry');
    expect(entry?.metadata.model).toBe('test-model');
    expect(entry?.metadata.provider).toBe('mock');
    expect(entry?.projectRoot).toBe(tmp);
  });
});
