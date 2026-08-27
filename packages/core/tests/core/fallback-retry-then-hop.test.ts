/**
 * The end-to-end contract every agent surface must honour:
 *
 *   try the model MODEL_RETRIES times → move to the next entry of the
 *   fallback chain (explicit list, then the selected named profile) → repeat.
 *
 * This composes the two halves the way the agent loop does
 * (`agent-loop.ts`: `extensions.wrapProviderRunner(baseRunner)`, where
 * `baseRunner` is `runProviderWithRetry` using `agent.retry`), so a change to
 * either half that breaks the combined behavior fails here.
 *
 * The leader, host subagents (Chimera reviewers included, since they are
 * spawned through the same subagent factory) and SDD light subagents all build
 * their Agent with the shared DI container, so they resolve the same
 * `TOKENS.RetryPolicy` and register the same fallback extension — one contract,
 * not three.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFallbackModelExtension } from '../../src/core/fallback-model.js';
import { runProviderWithRetry } from '../../src/core/provider-runner.js';
import { DefaultRetryPolicy, MODEL_RETRIES } from '../../src/execution/retry-policy.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Config } from '../../src/types/config.js';
import { ProviderError } from '../../src/types/provider.js';

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

const config = {
  version: 1,
  provider: 'p1',
  model: 'm1',
  fallbackAuto: false,
  fallbackProfiles: { strong: ['p2/m2', 'p3/m3'] },
  fallbackProfile: 'strong',
  providers: {
    p1: { type: 'openai', apiKey: 'k1', models: ['m1'] },
    p2: { type: 'openai', apiKey: 'k2', models: ['m2'] },
    p3: { type: 'openai', apiKey: 'k3', models: ['m3'] },
  },
} as unknown as Config;

/**
 * Provider whose `complete` always fails, except for the ids in `healthy`.
 * Records one entry per wire call so the test can count attempts per model.
 */
function makeProviders(healthy: Set<string>, calls: string[]) {
  return (id: string) =>
    ({
      id,
      capabilities: { maxContext: 200_000, streaming: false },
      complete: async (req: { model: string }) => {
        calls.push(`${id}/${req.model}`);
        if (healthy.has(id)) return { content: [{ type: 'text', text: 'ok' }], usage: {} };
        throw new ProviderError('overloaded', 529, true, id, { kind: 'overloaded' });
      },
    }) as never;
}

async function runTurn(healthy: Set<string>) {
  const calls: string[] = [];
  const build = makeProviders(healthy, calls);
  const events = new EventBus();
  const retry = new DefaultRetryPolicy();
  // No backoff sleeping in the test — the schedule itself is covered by the
  // retry-policy unit tests.
  vi.spyOn(retry, 'delayMs').mockReturnValue(0);

  const ext = createFallbackModelExtension({
    getConfig: () => config,
    buildProvider: (id) => build(id),
    events,
    logger,
  });

  const ctx = {
    provider: build('p1'),
    model: 'm1',
    session: { id: 's1' },
  } as never as { provider: { id: string }; model: string };

  const inner = (c: typeof ctx, request: { model: string }) =>
    runProviderWithRetry({
      provider: c.provider as never,
      request: { ...request, messages: [] } as never,
      signal: new AbortController().signal,
      ctx: c as never,
      events,
      retry,
      logger,
    });

  const result = await (ext.wrapProviderRunner as any)(ctx, { model: 'm1' }, inner);
  return { calls, result, ctx };
}

describe('retry MODEL_RETRIES times, then the next model in the chain', () => {
  it('spends exactly MODEL_RETRIES+1 calls per model before failing over', async () => {
    const { calls, ctx } = await runTurn(new Set(['p3']));
    const perModel = calls.reduce<Record<string, number>>((acc, ref) => {
      acc[ref] = (acc[ref] ?? 0) + 1;
      return acc;
    }, {});

    // MODEL_RETRIES retries on top of the initial call.
    const budget = MODEL_RETRIES + 1;
    expect(perModel['p1/m1']).toBe(budget);
    expect(perModel['p2/m2']).toBe(budget);
    // p3 answers on its first call.
    expect(perModel['p3/m3']).toBe(1);

    // Order: primary exhausted, then the profile's entries in order.
    expect(calls[0]).toBe('p1/m1');
    expect(calls[budget]).toBe('p2/m2');
    expect(calls[budget * 2]).toBe('p3/m3');
    expect(ctx.model).toBe('m3');
    expect((ctx as { activeLogicalRequestId?: string }).activeLogicalRequestId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect((ctx as { activePromptManifestId?: string }).activePromptManifestId).toMatch(
      /^prompt_[0-9a-f]{64}$/,
    );
  });

  it('gives every chain entry its full budget before surfacing the failure', async () => {
    const calls: string[] = [];
    const build = makeProviders(new Set(), calls);
    const events = new EventBus();
    const retry = new DefaultRetryPolicy();
    vi.spyOn(retry, 'delayMs').mockReturnValue(0);
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider: (id) => build(id),
      events,
      logger,
    });
    const ctx = {
      provider: build('p1'),
      model: 'm1',
      activeRunSessionId: '2026-08-26/sess_01TESTRETRYTHENHOP0000000',
    } as never as {
      provider: { id: string };
      model: string;
    };
    const inner = (c: typeof ctx, request: { model: string }) =>
      runProviderWithRetry({
        provider: c.provider as never,
        request: { ...request, messages: [] } as never,
        signal: new AbortController().signal,
        ctx: c as never,
        events,
        retry,
        logger,
      });
    await expect((ext.wrapProviderRunner as any)(ctx, { model: 'm1' }, inner)).rejects.toThrow();

    const budget = MODEL_RETRIES + 1;
    expect(calls.filter((c) => c === 'p1/m1')).toHaveLength(budget);
    expect(calls.filter((c) => c === 'p2/m2')).toHaveLength(budget);
    expect(calls.filter((c) => c === 'p3/m3')).toHaveLength(budget);
  });
});
