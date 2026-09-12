/**
 * End-to-end: does a session lane actually reach the wire?
 *
 * The unit tests prove the resolver picks a lane, and the arch test proves no
 * second resolver overwrites it. Neither proves the pair survives the rest of
 * the pipeline — the coordinator handoff, the subagent factory, the provider
 * build. This suite runs a real `MultiAgentHost.spawn` with a plan installed
 * and asserts on the arguments the provider factory was called with, which is
 * the last point before the model id leaves the process.
 */
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wrongstack/providers', () => ({
  makeProviderFromConfig: vi.fn(() => ({
    id: 'mock',
    capabilities: { streaming: false, tools: true, maxContext: 32_000 },
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })),
  })),
  capabilitiesFor: vi.fn(async () => ({ maxContext: 128_000 })),
  withCatalogCapabilities: vi.fn(async (_registry, _providerId, provider) => provider),
}));

import {
  emptySubagentModelPlan,
  resetSessionSubagentModelPlan,
  type SessionSubagentModelPlan,
  type SubagentSlot,
  setSessionSubagentModelPlanForSession,
} from '@wrongstack/core/coordination';
import { DefaultErrorHandler, DefaultRetryPolicy } from '@wrongstack/core/execution';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { Container, EventBus, TOKENS } from '@wrongstack/core/kernel';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import type {
  Config,
  ConfigStore,
  SessionWriter,
  SystemPromptBuilder,
  TokenCounter,
} from '@wrongstack/core/types';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { type MultiAgentDeps, MultiAgentHost } from '../src/multi-agent.js';

const SESSION_ID = 'sess-lane-e2e';

const tmpRoots: string[] = [];

function makeDeps(config: Partial<Config> = {}): MultiAgentDeps {
  const configStore = {
    get: vi.fn(() => ({
      provider: 'anthropic',
      model: 'leader-model',
      apiKey: 'fake',
      // A lane can only target a provider the user actually has: an
      // unconfigured id falls back to the leader provider in
      // `buildHostSubagentProvider`, which is the safety net for a typo, not a
      // routing path. Configure the ones the lanes below name.
      providers: {
        anthropic: { type: 'anthropic', apiKey: 'fake' },
        openai: { type: 'openai', apiKey: 'fake' },
        zai: { type: 'zai', apiKey: 'fake' },
      },
      ...config,
    })),
    watch: vi.fn(() => () => {}),
  } as never as ConfigStore;

  const systemPromptBuilder = {
    build: vi.fn(async () => [{ type: 'text', text: 'sys' }]),
  } as never as SystemPromptBuilder;

  const session = {
    id: SESSION_ID,
    pendingToolUses: [],
    append: vi.fn(async () => undefined),
    appendBatch: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    recordFileChange: vi.fn(() => undefined),
    writeCheckpoint: vi.fn(async () => undefined),
    writeFileSnapshot: vi.fn(async () => undefined),
    truncateToCheckpoint: vi.fn(async () => 0),
    clearSession: vi.fn(async () => undefined),
    writeInFlightMarker: vi.fn(async () => undefined),
    clearInFlightMarker: vi.fn(async () => undefined),
  } as never as SessionWriter;

  const tokenCounter: TokenCounter = {
    account: vi.fn(),
    currentRequestTokens: vi.fn(() => ({ input: 0, cacheRead: 0 })),
    total: vi.fn(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
    estimateCost: vi.fn(() => ({ input: 0, output: 0, total: 0, currency: 'USD' })),
    cacheStats: vi.fn(() => ({ readTokens: 0, writeTokens: 0, hitRatio: 0 })),
    reset: vi.fn(),
  } as never as TokenCounter;

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());

  return {
    container,
    fallbackProfileManager: {} as never,
    toolRegistry: new ToolRegistry(),
    providerRegistry: new ProviderRegistry(),
    configStore,
    events: new EventBus(),
    systemPromptBuilder,
    session,
    tokenCounter,
    projectRoot: '/tmp/proj',
    cwd: '/tmp/proj',
    secretScrubber: new DefaultSecretScrubber(),
  };
}

function installPlan(
  lanes: SubagentSlot[],
  overrides: Partial<SessionSubagentModelPlan> = {},
): void {
  const plan = emptySubagentModelPlan();
  lanes.forEach((lane, i) => {
    plan.slots[i] = lane;
  });
  Object.assign(plan, overrides);
  setSessionSubagentModelPlanForSession(SESSION_ID, plan);
}

/** Every (providerId, model) pair the provider factory was asked to build. */
function builtTargets(): Array<{ provider: string; model: string | undefined }> {
  return vi.mocked(makeProviderFromConfig).mock.calls.map((call) => ({
    provider: call[0] as string,
    model: (call[1] as { model?: string }).model,
  }));
}

beforeEach(() => {
  vi.mocked(makeProviderFromConfig).mockClear();
  resetSessionSubagentModelPlan(SESSION_ID);
});

afterEach(async () => {
  resetSessionSubagentModelPlan(SESSION_ID);
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('subagent model lanes reach the provider', () => {
  it('builds the spawned subagent on the lane model, not the leader model', async () => {
    installPlan([{ provider: 'openai', model: 'lane-model-1' }]);
    const host = new MultiAgentHost(makeDeps());

    const { taskId } = await host.spawn('do a thing');
    await host.getDirector()?.awaitTasks([taskId]);

    expect(builtTargets()).toContainEqual({ provider: 'openai', model: 'lane-model-1' });
    await host.stopAll();
  });

  it('gives two concurrent workers two different lanes', async () => {
    installPlan([
      { provider: 'openai', model: 'lane-model-1' },
      { provider: 'zai', model: 'lane-model-2' },
    ]);
    const host = new MultiAgentHost(makeDeps());

    const first = await host.spawn('task one');
    const second = await host.spawn('task two');
    await host.getDirector()?.awaitTasks([first.taskId, second.taskId]);

    const targets = builtTargets();
    expect(targets).toContainEqual({ provider: 'openai', model: 'lane-model-1' });
    expect(targets).toContainEqual({ provider: 'zai', model: 'lane-model-2' });
    await host.stopAll();
  });

  it('overrides the model the LEADER chose', async () => {
    installPlan([{ provider: 'openai', model: 'lane-model-1' }]);
    const host = new MultiAgentHost(makeDeps());
    await host.spawn('warm up the director');
    vi.mocked(makeProviderFromConfig).mockClear();
    const director = host.getDirector();
    if (!director) throw new Error('director not built');

    // The shape `spawn_subagent` produces when the leader fills the fields in.
    const subagentId = await director.spawn({
      name: 'Worker',
      provider: 'anthropic',
      model: 'leader-chosen',
      modelChosenByLeader: true,
    });
    await director.assign({
      id: 'leader-task',
      description: 'do a thing',
      subagentId,
    });
    await director.awaitTasks(['leader-task']);

    const targets = builtTargets();
    expect(targets).toContainEqual({ provider: 'openai', model: 'lane-model-1' });
    expect(targets.some((t) => t.model === 'leader-chosen')).toBe(false);
    await host.stopAll();
  });

  it('keeps a model a PERSON typed on the spawn', async () => {
    // `/spawn --model=…` reaches the host without the leader marker: a one-off
    // someone typed outranks a standing lane.
    installPlan([{ provider: 'openai', model: 'lane-model-1' }]);
    const host = new MultiAgentHost(makeDeps());

    const { taskId } = await host.spawn('do a thing', {
      provider: 'zai',
      model: 'typed-by-hand',
    });
    await host.getDirector()?.awaitTasks([taskId]);

    expect(builtTargets()).toContainEqual({ provider: 'zai', model: 'typed-by-hand' });
    await host.stopAll();
  });

  it('runs the worker on the session model when asked to', async () => {
    installPlan([{ provider: 'openai', model: 'lane-model-1' }], { followSessionModel: true });
    const host = new MultiAgentHost(makeDeps());

    const { taskId } = await host.spawn('do a thing');
    await host.getDirector()?.awaitTasks([taskId]);

    expect(builtTargets()).toContainEqual({ provider: 'anthropic', model: 'leader-model' });
    await host.stopAll();
  });

  it('leaves a /setmodel role route to routing', async () => {
    installPlan([{ provider: 'openai', model: 'lane-model-1' }]);
    const host = new MultiAgentHost(
      makeDeps({ modelMatrix: { reviewer: { provider: 'zai', model: 'routed-model' } } }),
    );

    // `host.spawn()` hard-codes role 'general', so go through the Director the
    // way `spawn_subagent` does when the leader names a role.
    await host.spawn('warm up the director');
    vi.mocked(makeProviderFromConfig).mockClear();
    const director = host.getDirector();
    if (!director) throw new Error('director not built');
    const subagentId = await director.spawn({ name: 'Reviewer', role: 'reviewer' });
    await director.assign({
      id: 'review-task',
      description: 'review it',
      subagentId,
    });
    await director.awaitTasks(['review-task']);

    const targets = builtTargets();
    expect(targets).toContainEqual({ provider: 'zai', model: 'routed-model' });
    // The lane stayed free: a routed spawn never claims one.
    expect(targets.some((t) => t.model === 'lane-model-1')).toBe(false);
    await host.stopAll();
  });

  it('falls back to the leader provider when the lane names one with no key', async () => {
    // Documented, not desired: `buildHostSubagentProvider` refuses to build a
    // provider the user has not configured and drops to the leader's. The lane
    // MODEL still travels, so the pair is bogus and the first call fails —
    // recovered by the startup-target chain, which retries on the leader pair.
    // The pickers only offer configured providers; `/subagent-models set`
    // warns. This test exists so the behaviour cannot change silently.
    installPlan([{ provider: 'not-configured', model: 'lane-model-1' }]);
    const host = new MultiAgentHost(makeDeps());

    const { taskId } = await host.spawn('do a thing');
    await host.getDirector()?.awaitTasks([taskId]);

    const targets = builtTargets();
    expect(targets.some((t) => t.provider === 'not-configured')).toBe(false);
    expect(targets[0]?.provider).toBe('anthropic');
    await host.stopAll();
  });

  it('changes nothing when no plan is installed', async () => {
    const host = new MultiAgentHost(makeDeps());

    const { taskId } = await host.spawn('do a thing');
    await host.getDirector()?.awaitTasks([taskId]);

    expect(builtTargets()).toContainEqual({ provider: 'anthropic', model: 'leader-model' });
    await host.stopAll();
  });
});
