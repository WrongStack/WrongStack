/**
 * Regression coverage for the Agent.run() input-dedup burst window.
 *
 * User-visible bug this pins: the old dedup skipped ANY byte-identical
 * consecutive input forever. A deliberate "continue" nudge typed after a
 * model switch — or retyping the same instruction after a failed or stopped
 * run — was silently swallowed with `{ status: 'done', iterations: 0 }`,
 * leaving the session looking dead until the user happened to type something
 * different. Reported against TUI and WebUI alike because the guard lives in
 * core Agent.run().
 *
 * Contract under test:
 *   1. An accidental back-to-back duplicate (inside INPUT_DEDUP_WINDOW_MS)
 *      is still suppressed — terminal \r\n re-entrancy, stuck-key bursts,
 *      client auto-resubmit loops.
 *   2. The same text submitted AFTER the window executes again.
 *   3. Retrying the identical input after a FAILED run always executes
 *      (the catch path releases the committed hash).
 *   4. Resubmitting the identical input after an ABORTED run always executes
 *      (a resolved failed/aborted result releases the hash too).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import type { ErrorHandler } from '../../src/types/error-handler.js';
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
import { MockProvider } from '../helpers/mock-provider.js';

/** ErrorHandler stub that never recovers — errors propagate out of the loop. */
class NeverRetryErrorHandler implements ErrorHandler {
  async recover(): Promise<null> {
    return null;
  }

  classify() {
    return { kind: 'unknown' as const, retryable: false };
  }
}

/** MockProvider that counts every complete() attempt, optionally failing first. */
class CountingProvider extends MockProvider {
  /** Total `complete()` invocations, including failed attempts. */
  attemptCount = 0;
  private failuresLeft: number;

  constructor(
    failFirst: number,
    responses: ConstructorParameters<typeof MockProvider>[0],
  ) {
    super(responses);
    this.failuresLeft = failFirst;
  }

  override async complete(
    req: Parameters<MockProvider['complete']>[0],
    opts: Parameters<MockProvider['complete']>[1],
  ) {
    this.attemptCount++;
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('simulated provider failure');
    }
    return super.complete(req, opts);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function buildDedupAgent(provider: MockProvider): Promise<{ agent: Agent; tmp: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-input-dedup-'));
  const trustFile = path.join(tmp, 'trust.json');
  const sessionDir = path.join(tmp, 'sessions');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  // No internal recovery anywhere: attempt counts stay 1:1 with runs.
  container.bind(TOKENS.ErrorHandler, () => new NeverRetryErrorHandler());
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
  });
  return { agent, tmp };
}

describe('Agent.run input-dedup burst window', () => {
  let cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    cleanupDirs = [];
  });

  it('still suppresses an accidental back-to-back duplicate inside the burst window', async () => {
    const provider = new CountingProvider(0, [
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildDedupAgent(provider);
    cleanupDirs.push(tmp);

    const first = await agent.run('continue');
    const second = await agent.run('continue');

    expect(first.status).toBe('done');
    // The immediate repeat lands inside the dedup window: no second run.
    expect(second.status).toBe('done');
    expect(second.iterations).toBe(0);
    expect(provider.attemptCount).toBe(1);
  });

  it('executes the same input again once the burst window has passed', async () => {
    // Two scripted responses: one per executed run.
    const provider = new CountingProvider(0, [
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildDedupAgent(provider);
    cleanupDirs.push(tmp);

    await agent.run('continue');
    // A deliberate re-send ("continue" after a model switch) arrives well
    // after the burst window; the unbounded dedup used to swallow it here.
    await sleep(Agent.INPUT_DEDUP_WINDOW_MS + 250);
    const second = await agent.run('continue');

    expect(second.status).toBe('done');
    expect(second.iterations).toBeGreaterThan(0);
    expect(provider.attemptCount).toBe(2);
  });

  it('does not extend the burst window when the wall clock steps backward', async () => {
    // Two scripted responses: one per executed run.
    const provider = new CountingProvider(0, [
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildDedupAgent(provider);
    cleanupDirs.push(tmp);

    await agent.run('continue');

    // Simulate an NTP/manual clock step backward right after the first
    // submission: a negative elapsed time must never extend the burst window,
    // or the deliberate repeat stays suppressed until the wall clock catches up.
    const committedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(committedAt - 5_000);
    try {
      const second = await agent.run('continue');
      expect(second.status).toBe('done');
      expect(second.iterations).toBeGreaterThan(0);
    } finally {
      clock.mockRestore();
    }
    expect(provider.attemptCount).toBe(2);
  });

  it('does not swallow an identical retry after a failed run', async () => {
    const provider = new CountingProvider(1, [
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildDedupAgent(provider);
    cleanupDirs.push(tmp);

    const failed = await agent.run('continue');
    expect(failed.status).toBe('failed');

    // Retyping the same instruction after an error is a retry, not a
    // duplicate: the catch path must have released the committed hash.
    const retried = await agent.run('continue');
    expect(retried.status).toBe('done');
    expect(provider.attemptCount).toBe(2);
  });

  it('does not swallow the identical input after an aborted run', async () => {
    const provider = new CountingProvider(0, [
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildDedupAgent(provider);
    cleanupDirs.push(tmp);

    // A pre-aborted parent signal ends the run without a provider call but
    // AFTER setup committed the hash — exercising the resolved-'aborted'
    // release path in Agent.run().
    const controller = new AbortController();
    controller.abort();
    const aborted = await agent.run('continue', { signal: controller.signal });
    expect(['aborted', 'failed']).toContain(aborted.status);

    const resumed = await agent.run('continue');
    expect(resumed.status).toBe('done');
    expect(provider.attemptCount).toBe(1);
  });
});
