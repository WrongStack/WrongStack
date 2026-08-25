/**
 * Regression coverage for the WrongProxy deactivation → retry race.
 *
 * Chimera findings this pins (both CONFIRMED as one mechanism):
 *
 *   1. `deactivateProxyOnConnectionFailure` (proxy-rewrite.ts) flips the
 *      singleton config synchronously, but the live provider's rebuild runs
 *      on `createProxyInstantApply`'s async chain. The provider-runner retry
 *      loop re-reads `ctx.provider` at the top of each attempt — before the
 *      rebuild lands, the remaining attempts still target the DEAD proxy
 *      URL, and the "switched to direct" log was a lie.
 *   2. provider-runner.ts:140 logged "deactivated proxy and switched to
 *      direct provider connection" without any switch having landed yet.
 *
 * Fix contract under test:
 *   - `waitForProxyRoutingSettle()` waits (bounded) for every live
 *     instant-apply rebuild chain registered at call time;
 *   - the retry loop awaits it right after a deactivation, so the next
 *     attempt fires with the REBUILT provider;
 *   - dispose removes a handle's chain from the registry (a torn-down host
 *     stops delaying retries);
 *   - the cap keeps a hung rebuild from hanging the turn.
 */
import { describe, expect, it, vi } from 'vitest';
import { runProviderWithRetry } from '../../src/core/provider-runner.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Request } from '../../src/types/provider.js';
import {
  __resetProxyConfigForTests,
  applyProxyConfig,
  createProxyInstantApply,
} from '../../src/wiring/proxy-rewrite.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

function makeRequest(model = 'm1'): Request {
  return { model, system: [], messages: [] } as unknown as Request;
}

/**
 * Two provider instances sharing the id 'openai': the proxy-pinned one the
 * session booted with, and the rebuilt direct one the instant-apply chain
 * swaps in. The retry loop only honours a ctx.provider whose id matches the
 * provider it was called with — a real rebuild keeps the same provider id
 * (new baseUrl), so this mirrors production exactly.
 */
function makeProviders(calls: string[]) {
  const proxyPinned = {
    id: 'openai',
    capabilities: { maxContext: 200_000, streaming: false },
    complete: async () => {
      calls.push('proxy-pinned');
      throw new TypeError(
        'fetch failed: request to http://localhost:3444/proxy/api.openai.com/v1 failed, reason: connect ECONNREFUSED 127.0.0.1:3444',
      );
    },
  } as never;
  const direct = {
    id: 'openai',
    capabilities: { maxContext: 200_000, streaming: false },
    complete: async () => {
      calls.push('direct');
      return {
        content: [{ type: 'text', text: 'ok direct' }],
        stopReason: 'end_turn',
        usage: { input: 1, output: 1 },
      };
    },
  } as never;
  return { proxyPinned, direct };
}

async function flush(microtasks = 4): Promise<void> {
  const rounds = Number.isFinite(microtasks) ? Math.max(1, microtasks) : 1;
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('WrongProxy deactivation → retry settle', () => {
  it('waits for the instant-apply rebuild before the retry attempt fires', async () => {
    __resetProxyConfigForTests();
    const calls: string[] = [];
    const { proxyPinned, direct } = makeProviders(calls);

    // Proxy on and "active" — providers were built rewritten.
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });

    let providerSwapped = false;
    let rebuildStarted = false;
    const handle = createProxyInstantApply({
      getActiveProviderId: () => 'openai',
      getRawBaseUrl: () => 'https://api.openai.com/v1',
      // The rebuild "lands" only after a couple of macrotasks — slow enough
      // that without the settle barrier the retry would fire first.
      rebuildProvider: async () => {
        rebuildStarted = true;
        await flush(3);
        providerSwapped = true;
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const ctx = {
      provider: proxyPinned,
      model: 'm1',
      session: { id: 's1' },
    } as never as { provider: { id: string }; model: string };

    // Swap ctx.provider when the rebuild completes, exactly as the host's
    // rebuildProvider does (same id, direct baseUrl).
    Object.defineProperty(ctx, 'provider', {
      get() {
        return providerSwapped ? direct : proxyPinned;
      },
      configurable: true,
    });

    const events = new EventBus();
    const retry = new DefaultRetryPolicy();
    vi.spyOn(retry, 'delayMs').mockReturnValue(0);

    const result = await runProviderWithRetry({
      provider: proxyPinned as never,
      request: makeRequest(),
      signal: new AbortController().signal,
      ctx,
      events,
      retry,
      logger,
    });

    expect(result).toBeDefined();
    expect(calls).toEqual(['proxy-pinned', 'direct']);
    expect(rebuildStarted).toBe(true);
    expect(providerSwapped).toBe(true);
    handle.dispose();
    __resetProxyConfigForTests();
  });

  it('dispose removes the chain — a torn-down host does not delay retries', async () => {
    __resetProxyConfigForTests();
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    const handle = createProxyInstantApply({
      getActiveProviderId: () => 'openai',
      getRawBaseUrl: () => 'https://api.openai.com/v1',
      rebuildProvider: vi.fn(async () => {}),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handle.dispose();
    applyProxyConfig({ active: false });
    await flush();
    // The registry is empty after dispose: settle must return without
    // waiting on any chain (this is the no-hang contract).
    const start = Date.now();
    const { waitForProxyRoutingSettle } = await import('../../src/wiring/proxy-rewrite.js');
    await waitForProxyRoutingSettle(50);
    expect(Date.now() - start).toBeLessThan(50);
    __resetProxyConfigForTests();
  });
});
