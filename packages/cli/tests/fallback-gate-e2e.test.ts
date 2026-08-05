/**
 * End-to-end integration test: fallback gate + extension.
 *
 * Verifies the full round-trip:
 * 1. Primary model fails with 529 (overloaded)
 * 2. Extension enters runFallbackChain
 * 3. Gate fires (fallbackGate dep) → emits provider.fallback_pending
 * 4. A listener (simulating the UI) captures requestId and sends
 *    provider.fallback_choice with a manual pick
 * 5. Gate resolves with the chosen model
 * 6. Extension reorders the chain to front-load the chosen entry
 * 7. The chosen model succeeds → response returned
 *
 * Also tests the auto-switch path: no choice sent → safety deadline
 * resolves null → extension proceeds with the chain head.
 */
import { type Config, type Provider, ProviderError } from '@wrongstack/core/types';
import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it, vi } from 'vitest';
import { createFallbackModelExtension } from '@wrongstack/core/agent';
import { createFallbackGate } from '../src/wiring/fallback-gate.js';

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function fakeProvider(id: string): Provider {
  return {
    id,
    capabilities: { maxContext: 200_000 } as never,
    complete: vi.fn(),
    stream: vi.fn(),
  } as Provider;
}

function makeCtx(providerId: string, model: string) {
  return { provider: fakeProvider(providerId), model, session: { id: 's1' } } as never as import('@wrongstack/core/agent').Context;
}

function overload(providerId: string) {
  return new ProviderError('overloaded', 529, true, providerId, { kind: 'overloaded' });
}

function cfg(over: Partial<Config>): Config {
  return {
    provider: 'anthropic',
    model: 'opus',
    fallbackModels: ['haiku', 'openai/gpt-4o'],
    providers: {
      anthropic: { type: 'anthropic', apiKey: 'x', models: ['opus', 'haiku'] },
      openai: { type: 'openai', apiKey: 'y', models: ['gpt-4o'] },
    },
    ...over,
  } as never as Config;
}

describe('fallback gate e2e integration', () => {
  it('emits provider.fallback_pending, accepts a manual choice, and succeeds on the chosen model', async () => {
    const events = new EventBus();

    // Capture the pending event to simulate the UI picking a model.
    let capturedRequestId = '';
    events.on('provider.fallback_pending', (e) => {
      capturedRequestId = (e as Record<string, unknown>)['requestId'] as string;
      // Simulate the UI immediately sending back a choice for gpt-4o
      // (the second candidate — not the chain head).
      setImmediate(() => {
        events.emit('provider.fallback_choice', {
          requestId: capturedRequestId,
          providerId: 'openai',
          model: 'gpt-4o',
        });
      });
    });

    const ext = createFallbackModelExtension({
      getConfig: () => cfg({}),
      buildProvider: fakeProvider,
      events,
      logger,
      fallbackGate: createFallbackGate(events),
      fallbackGateSeconds: 5,
    })!;

    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    const inner = vi.fn(async () => {
      call++;
      if (call === 1) throw overload('anthropic'); // primary fails
      return { stopReason: 'end_turn', usage: { input: 1, output: 1 } } as never;
    });

    const res = await ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never);

    // The response succeeded.
    expect(res).toBeTruthy();
    // Only 2 calls: primary (failed) + chosen fallback (succeeded).
    expect(call).toBe(2);
    // The chosen model was gpt-4o, not the chain head (haiku).
    expect(ctx.model).toBe('gpt-4o');
    expect(ctx.provider.id).toBe('openai');
    // A pending event was emitted.
    expect(capturedRequestId.length).toBeGreaterThan(0);
  });

  it('auto-switches to the chain head when no choice is sent (countdown deadline)', async () => {
    const events = new EventBus();

    // No listener sends a choice — the gate's safety deadline should
    // resolve null (auto-switch to chain head).
    const pendingEvents: unknown[] = [];
    events.on('provider.fallback_pending', (e) => pendingEvents.push(e));

    const ext = createFallbackModelExtension({
      getConfig: () => cfg({}),
      buildProvider: fakeProvider,
      events,
      logger,
      fallbackGate: createFallbackGate(events),
      fallbackGateSeconds: 1, // short deadline for fast test
    })!;

    const ctx = makeCtx('anthropic', 'opus');
    let call = 0;
    const inner = vi.fn(async () => {
      call++;
      if (call === 1) throw overload('anthropic');
      return { stopReason: 'end_turn', usage: { input: 1, output: 1 } } as never;
    });

    const res = await ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never);

    expect(res).toBeTruthy();
    expect(call).toBe(2);
    // Chain head (haiku) was used since no manual choice was sent.
    expect(ctx.model).toBe('haiku');
    // A pending event was emitted.
    expect(pendingEvents).toHaveLength(1);
  }, 10_000);

  it('does not fire the gate when the error is not fallback-worthy (e.g. auth)', async () => {
    const events = new EventBus();
    const pendingEvents: unknown[] = [];
    events.on('provider.fallback_pending', (e) => pendingEvents.push(e));

    const ext = createFallbackModelExtension({
      getConfig: () => cfg({}),
      buildProvider: fakeProvider,
      events,
      logger,
      fallbackGate: createFallbackGate(events),
      fallbackGateSeconds: 5,
    })!;

    const ctx = makeCtx('anthropic', 'opus');
    const authErr = new ProviderError('invalid key', 401, false, 'anthropic', { kind: 'auth' });
    const inner = vi.fn(async () => {
      throw authErr;
    });

    // Auth errors are NOT fallback-worthy — the extension rethrows.
    await expect(
      ext.wrapProviderRunner!(ctx, { model: 'opus' } as never, inner as never),
    ).rejects.toBe(authErr);

    // No pending event should have been emitted.
    expect(pendingEvents).toHaveLength(0);
  });
});
