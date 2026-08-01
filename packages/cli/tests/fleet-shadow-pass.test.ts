import { describe, expect, it, vi } from 'vitest';

vi.mock('@wrongstack/providers', () => ({
  // Mirror multi-agent.test.ts: a minimal mock provider so host.spawn()
  // can build a real Director + subagent without touching the network.
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
}));

import { DefaultErrorHandler, DefaultRetryPolicy } from '@wrongstack/core/execution';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import type { ConfigStore } from '@wrongstack/core/types';
import { Container, EventBus, TOKENS } from '@wrongstack/core/kernel';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type { SessionWriter, SystemPromptBuilder, TokenCounter } from '@wrongstack/core/types';
import type { MultiAgentDeps } from '../src/multi-agent.js';
import { MultiAgentHost } from '../src/multi-agent.js';

function makeDeps(): MultiAgentDeps {
  const configStore = {
    get: vi.fn(() => ({
      provider: 'anthropic',
      model: 'claude',
      apiKey: 'fake',
    })),
    watch: vi.fn(() => ({})),
  } as unknown as ConfigStore;

  const systemPromptBuilder = {
    build: vi.fn(async () => [{ type: 'text', text: 'sys' }]),
  } as unknown as SystemPromptBuilder;

  const session = {
    id: 'sess-test',
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
  } as unknown as SessionWriter;

  const tokenCounter: TokenCounter = {
    account: vi.fn(),
    currentRequestTokens: vi.fn(() => ({ input: 0, cacheRead: 0 })),
    total: vi.fn(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
    estimateCost: vi.fn(() => ({ input: 0, output: 0, total: 0, currency: 'USD' })),
    cacheStats: vi.fn(() => ({ readTokens: 0, writeTokens: 0, hitRatio: 0 })),
    reset: vi.fn(),
  } as unknown as TokenCounter;

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());

  return {
    container,
    toolRegistry: new ToolRegistry(),
    fallbackProfileManager: {} as never,
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

describe('MultiAgentHost shadow pass shutdown race', () => {
  it('runShadowPass() after workComplete() resolves without throwing', async () => {
    const host = new MultiAgentHost(makeDeps());

    // Build a real Director by spawning one subagent through the public API.
    const subagentId = await host.spawn('do a thing');
    expect(subagentId).toBeTruthy();

    const director = host.getDirector();
    expect(director).toBeDefined();

    // Simulate the leader signalling it is done: spawning is now closed and
    // Director.spawn() will throw FleetSpawnBudgetError.
    director!.workComplete();
    expect(director!.isWorkComplete()).toBe(true);

    // A heartbeat-scheduled shadow pass landing after workComplete() must not
    // crash the process. Before the guard this rejected with
    // FleetSpawnBudgetError (which, as an unhandled microtask rejection,
    // tore the process down).
    await expect(
      (host as unknown as { runShadowPass(reason: string): Promise<void> }).runShadowPass(
        'post-workComplete heartbeat',
      ),
    ).resolves.toBeUndefined();

    await host.stopAll();
  });

  it('runShadowPass() bails before spawning once director is work-complete', async () => {
    const deps = makeDeps();
    const host = new MultiAgentHost(deps);

    await host.spawn('seed');
    const director = host.getDirector()!;

    // Spy on the director's spawn so we can prove the early bail (Layer 1)
    // short-circuits before any spawn attempt is made.
    const spawnSpy = vi.spyOn(director, 'spawn');
    director.workComplete();

    await expect(
      (host as unknown as { runShadowPass(reason: string): Promise<void> }).runShadowPass(
        'should be skipped',
      ),
    ).resolves.toBeUndefined();

    expect(spawnSpy).not.toHaveBeenCalled();

    await host.stopAll();
  });
});
