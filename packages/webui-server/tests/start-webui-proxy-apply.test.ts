/**
 * Unit tests for the standalone WebUI server's WrongProxy instant-apply
 * wiring (`packages/webui-server/src/server/start-webui-proxy-apply.ts`).
 *
 * Mocking strategy mirrors proxy-runtime.test.ts: the core proxy singleton
 * is REAL (state changes go through the genuine applyProxyConfig →
 * subscribeToProxyConfig pipeline), while the provider factory layer
 * (`@wrongstack/providers`) is faked so no network-adjacent construction
 * happens. These tests pin the swap contract the standalone server adds:
 *
 *   - proxy activation rebuilds the live provider with the ROUTED cfg
 *     (rewritten baseUrl) through the transition gate;
 *   - value-identical probe ticks never rebuild;
 *   - a superseded rebuild (provider moved before the rebuild ran) never
 *     overwrites the newer provider;
 *   - dispose stops rebuilds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProxyConfig,
  __resetProxyConfigForTests,
} from '@wrongstack/core/wiring/proxy-rewrite';
import type { Provider, ProviderConfig } from '@wrongstack/core/types';

vi.mock('@wrongstack/providers', () => ({
  makeProviderFromConfig: vi.fn(
    (id: string, cfg: ProviderConfig) => ({ id, capabilities: {}, cfg }) as unknown as Provider,
  ),
  withCatalogCapabilities: vi.fn(async (_m: unknown, _id: string, provider: Provider) => provider),
}));

import { setupWebuiProxyInstantApply } from '../src/server/start-webui-proxy-apply.js';
import type { WebuiDeps, WebuiMutableState } from '../src/server/routes.js';

const RAW_URL = 'https://api.example.com/v1';
const PROXY_URL = 'http://localhost:3444';

function fakeProvider(id: string): Provider {
  return { id, capabilities: {} as never, complete: vi.fn(), stream: vi.fn() } as Provider;
}

/** Drain the serialized rebuild chain (microtask flush). */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeSetup() {
  const context = {
    provider: fakeProvider('openai'),
    model: 'gpt-4o',
    runModelTransition: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  };
  let config: Record<string, unknown> = {
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: RAW_URL,
    providers: { openai: { type: 'openai' } },
  };
  const state = {
    getConfig: () => config,
    setConfig: (next: Record<string, unknown>) => {
      config = next;
    },
  } as unknown as WebuiMutableState;
  const deps = {
    context,
    providerRegistry: { has: vi.fn(() => false) },
    modelsRegistry: undefined,
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as WebuiDeps;
  const updateAutoCompactionMaxContext = vi.fn(async () => {});
  const dispose = setupWebuiProxyInstantApply({ state, deps, updateAutoCompactionMaxContext });
  return { context, deps, state, dispose, updateAutoCompactionMaxContext };
}

beforeEach(() => {
  __resetProxyConfigForTests();
  // Clear call history on the module-scope @wrongstack/providers mock —
  // without this, makeProviderFromConfig counts accumulate across tests.
  vi.clearAllMocks();
});
afterEach(() => __resetProxyConfigForTests());

describe('setupWebuiProxyInstantApply', () => {
  it('rebuilds the live provider with the routed (rewritten) baseUrl on activation', async () => {
    const { context, deps, dispose } = makeSetup();
    applyProxyConfig({ enabled: true, url: PROXY_URL, active: true });
    await flushAsync();

    expect(context.runModelTransition).toHaveBeenCalled();
    // The live provider object was swapped…
    expect(context.provider).not.toBe(null);
    expect(context.provider?.id).toBe('openai');
    // …and the build received the ROUTED cfg (rewritten baseUrl).
    const { makeProviderFromConfig } = await import('@wrongstack/providers');
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ baseUrl: `${PROXY_URL}/proxy/api.example.com/v1` }),
    );
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining('live provider rebuilt'));
    dispose();
  });

  it('rebuilds back to the RAW baseUrl when the proxy deactivates', async () => {
    const s = makeSetup();
    // Boot proxy-on (rebuild #1: raw → rewritten)…
    applyProxyConfig({ enabled: true, url: PROXY_URL, active: true });
    await flushAsync();
    // …then the probe deactivates (rebuild #2: rewritten → direct).
    applyProxyConfig({ active: false });
    await flushAsync();

    const { makeProviderFromConfig } = await import('@wrongstack/providers');
    expect(vi.mocked(makeProviderFromConfig)).toHaveBeenCalledTimes(2);
    // Proxy-off passthrough contract (routeProviderCfgThroughProxy): the
    // cfg returns UNCHANGED — the top-level fallbackBaseUrl only feeds the
    // rewrite, so the saved cfg (no explicit baseUrl) reaches the factory
    // bare and the provider uses its family default. Same semantics as
    // applyModelSwitchCore and the credential watcher.
    expect(vi.mocked(makeProviderFromConfig)).toHaveBeenLastCalledWith(
      'openai',
      expect.objectContaining({ type: 'openai' }),
    );
    expect(vi.mocked(makeProviderFromConfig)).toHaveBeenLastCalledWith(
      'openai',
      expect.not.objectContaining({ baseUrl: `${PROXY_URL}/proxy/api.example.com/v1` }),
    );
    s.dispose();
  });

  it('does NOT rebuild on value-identical probe ticks', async () => {
    const s = makeSetup();
    applyProxyConfig({ enabled: true, url: PROXY_URL, active: true });
    await flushAsync();
    applyProxyConfig({ active: true }); // identical tick
    await flushAsync();

    const { makeProviderFromConfig } = await import('@wrongstack/providers');
    expect(vi.mocked(makeProviderFromConfig)).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('never overwrites a provider that moved before the rebuild ran (superseded)', async () => {
    const s = makeSetup();
    applyProxyConfig({ enabled: true, url: PROXY_URL, active: true });
    // A /model switch lands before the queued rebuild executes.
    s.context.provider = fakeProvider('anthropic');
    await flushAsync();

    expect(s.context.provider.id).toBe('anthropic'); // newer switch wins
    s.dispose();
  });

  it('stops rebuilding after dispose', async () => {
    const s = makeSetup();
    s.dispose();
    applyProxyConfig({ enabled: true, url: PROXY_URL, active: true });
    await flushAsync();

    const { makeProviderFromConfig } = await import('@wrongstack/providers');
    expect(makeProviderFromConfig).not.toHaveBeenCalled();
  });
});
