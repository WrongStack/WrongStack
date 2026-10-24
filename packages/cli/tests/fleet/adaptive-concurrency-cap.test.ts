/**
 * Regression: AdaptiveConcurrencyController seeds its limit from its own
 * ceiling (adaptiveConcurrency.maxConcurrent, default 16) and applies it at
 * construction. The host passed the adaptive config verbatim, so enabling the
 * feature (which `wstack tuneup` recommends as backpressure) raised the fleet
 * cap from the user's 4 — or 2 — to 16 before any 429, and the first 429 only
 * dropped it to 8. The host now defaults the ceiling to the fleet's own cap.
 */

import { Container, EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import { DefaultErrorHandler, DefaultRetryPolicy } from '@wrongstack/core/execution';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { describe, expect, it, vi } from 'vitest';
import { type MultiAgentDeps, MultiAgentHost } from '../../src/multi-agent.js';

function makeDeps(adaptiveConcurrency: Record<string, unknown>): MultiAgentDeps {
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  return {
    container,
    fallbackProfileManager: {} as never,
    toolRegistry: new ToolRegistry(),
    providerRegistry: new ProviderRegistry(),
    configStore: {
      get: vi.fn(() => ({
        provider: 'anthropic',
        model: 'claude',
        apiKey: 'fake',
        adaptiveConcurrency,
      })),
      watch: vi.fn(() => () => {}),
    } as never,
    events: new EventBus(),
    systemPromptBuilder: { build: vi.fn(async () => [{ type: 'text', text: 'sys' }]) } as never,
    session: {
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
    } as never,
    tokenCounter: {
      account: vi.fn(),
      currentRequestTokens: vi.fn(() => ({ input: 0, cacheRead: 0 })),
      total: vi.fn(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
      estimateCost: vi.fn(() => ({ input: 0, output: 0, total: 0, currency: 'USD' })),
      cacheStats: vi.fn(() => ({ readTokens: 0, writeTokens: 0, hitRatio: 0 })),
      reset: vi.fn(),
    } as never,
    projectRoot: '/tmp/proj',
    cwd: '/tmp/proj',
    secretScrubber: new DefaultSecretScrubber(),
  };
}

async function capsAfterEnableAnd429(userCap: number, adaptive: Record<string, unknown>) {
  const host = new MultiAgentHost(makeDeps(adaptive), { maxConcurrent: userCap });
  try {
    const director = await host.ensureDirector();
    const afterEnable = host.getMaxConcurrent();
    (director as unknown as { fleet: { emit(event: unknown): void } }).fleet.emit({
      subagentId: 's',
      ts: Date.now(),
      type: 'provider.attempt.failed',
      payload: { status: 429 },
    });
    return { afterEnable, after429: host.getMaxConcurrent() };
  } finally {
    await host.dispose();
  }
}

describe('adaptive concurrency respects the fleet cap', () => {
  it.each([4, 2])('keeps a fleet cap of %i and only lowers it on a 429', async (cap) => {
    const caps = await capsAfterEnableAnd429(cap, { enabled: true });
    expect(caps.afterEnable).toBe(cap);
    expect(caps.after429).toBe(Math.max(1, Math.floor(cap / 2)));
  });

  it('still honours an explicit adaptive ceiling', async () => {
    expect(await capsAfterEnableAnd429(4, { enabled: true, maxConcurrent: 6 })).toEqual({
      afterEnable: 6,
      after429: 3,
    });
  });

  it('leaves the cap alone when the controller is disabled', async () => {
    expect(await capsAfterEnableAnd429(4, { enabled: false })).toEqual({
      afterEnable: 4,
      after429: 4,
    });
  });
});
