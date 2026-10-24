import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
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

/**
 * Layering smoke test — verifies that the *minimum viable WrongStack*
 * runs end-to-end without any feature-pack subsystem: no models.dev,
 * no MCP, no plugins, no skills, no memory tools.
 *
 * If this test fails, something has crept into the core path that should
 * have been opt-in. Lock that down before the feature gates rot.
 */
describe('Layering: minimal core path', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-min-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('runs a turn with only the strictly-required defaults bound', async () => {
    const trustFile = path.join(tmp, 'trust.json');
    const sessionDir = path.join(tmp, 'sessions');

    const container = new Container();
    container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
    container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
    container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
    container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
    container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
    container.bind(
      TOKENS.PermissionPolicy,
      () => new DefaultPermissionPolicy({ trustFile, yolo: true }),
    );

    // No ModelsRegistry, no MemoryStore, no SkillLoader, no Compactor,
    // no MCP, no plugins — just the engine.

    const tools = new ToolRegistry();
    const providers = new ProviderRegistry();
    const events = new EventBus();
    const pipelines = createDefaultPipelines();

    const sessionStore = new DefaultSessionStore({ dir: sessionDir });
    const session = await sessionStore.create({ id: '', model: 'mock', provider: 'mock' });

    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'pong' }], stopReason: 'end_turn' },
    ]);

    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'minimal' }],
      provider,
      session,
      signal: new AbortController().signal,
      tokenCounter: container.resolve(TOKENS.TokenCounter),
      cwd: tmp,
      projectRoot: tmp,
      model: 'mock',
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
      toolExecutor,
    });

    const result = await agent.run('ping');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('pong');
    expect(provider.calls).toBe(1);
  });
});
