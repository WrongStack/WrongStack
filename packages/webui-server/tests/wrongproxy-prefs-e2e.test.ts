/**
 * End-to-end integration test for the WrongProxy Settings toggle.
 *
 * Unlike proxy-runtime.test.ts / start-webui-proxy-apply.test.ts (which
 * poke `applyProxyConfig` directly), this file drives the FULL pipeline
 * exactly as a browser Settings panel does:
 *
 *   prefs.update payload
 *     → handlePrefsUpdate (REAL validation via validatePrefsUpdatePayload,
 *        meta/persist/broadcast side effects, awaited applyWrongProxyPrefs)
 *     → applyWrongProxyPrefs (REAL standalone runtime fn from proxy-runtime.ts,
 *        same injection routes.ts:531 performs)
 *     → probeWrongProxyActive (REAL global fetch against a REAL local
 *        node:http daemon stub answering /api/health)
 *     → ProxyConfig singleton material change
 *     → createProxyInstantApply subscription
 *     → setupWebuiProxyInstantApply rebuild (REAL wiring; only the
 *        @wrongstack/providers factory is faked)
 *
 * The only mocks: the provider factory layer and — deliberately NOT —
 * fetch. The probe exercises the genuine network stack against a local
 * ephemeral daemon, so a "dead daemon" case is a real ECONNREFUSED.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Provider, ProviderConfig } from '@wrongstack/core/types';
import { __resetProxyConfigForTests, getProxyConfig } from '@wrongstack/core/wiring/proxy-rewrite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

vi.mock('@wrongstack/providers', () => ({
  makeProviderFromConfig: vi.fn(
    (id: string, cfg: ProviderConfig) => ({ id, capabilities: {}, cfg }) as unknown as Provider,
  ),
  withCatalogCapabilities: vi.fn(async (_m: unknown, _id: string, provider: Provider) => provider),
}));

import type { PendingConfirm } from '../src/server/pending-confirms.js';
import { handlePrefsUpdate } from '../src/server/prefs-handlers.js';
import { applyWrongProxyPrefs as applyWrongProxyPrefsRuntime } from '../src/server/proxy-runtime.js';
import type { WebuiDeps, WebuiMutableState } from '../src/server/routes.js';
import { setupWebuiProxyInstantApply } from '../src/server/start-webui-proxy-apply.js';

const providersMod = await import('@wrongstack/providers');
const makeProviderFromConfig = vi.mocked(providersMod.makeProviderFromConfig);

const RAW_URL = 'https://api.example.com/v1';
const ws = {} as WebSocket;

/** Real local daemon stub answering the WrongTrace /api/health contract. */
function startDaemonStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ repo: 'WrongTrace', status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

/**
 * Bind an ephemeral port, then close it — the returned URL is GUARANTEED
 * to have nothing listening, so the probe gets a real ECONNREFUSED
 * instead of colliding with an actually-running dev daemon.
 */
async function deadDaemonUrl(): Promise<string> {
  const stub = await startDaemonStub();
  const url = stub.url;
  await stub.close();
  return url;
}

/** Drain the serialized rebuild chain. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function fakeProvider(id: string): Provider {
  return { id, capabilities: {} as never, complete: vi.fn(), stream: vi.fn() } as Provider;
}

/** Real instant-apply wiring + fake host state (same shape as production). */
function makeSession() {
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

/** Real prefs-handler context; applyWrongProxyPrefs is the REAL runtime fn. */
function makePrefsCtx() {
  const meta: Record<string, unknown> = {};
  return {
    meta,
    // Mirrors the real host: the snapshot IS the meta bag. The handler now
    // skips an echo with nothing in it, so a stub that always answers `{}`
    // would report no broadcast at all.
    snapshot: () => ({ ...meta }),
    persist: vi.fn(async () => {}),
    pendingConfirms: new Map<string, PendingConfirm>(),
    // Identical injection to routes.ts:531 in the standalone server.
    applyWrongProxyPrefs: applyWrongProxyPrefsRuntime,
    send: vi.fn(),
    broadcast: vi.fn(),
  };
}

const openDaemons: { close: () => Promise<void> }[] = [];

beforeEach(() => {
  __resetProxyConfigForTests();
  vi.clearAllMocks();
});

afterEach(async () => {
  __resetProxyConfigForTests();
  while (openDaemons.length > 0) {
    const daemon = openDaemons.pop();
    if (daemon) await daemon.close();
  }
});

describe('WrongProxy Settings toggle — e2e through the real prefs pipeline', () => {
  it('rejects a malformed toggle before any runtime effect (real validator active)', async () => {
    const ctx = makePrefsCtx();
    await handlePrefsUpdate(ctx, ws, { wrongProxyEnabled: 'yes-not-a-boolean' });
    expect(ctx.send).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ type: 'key.operation_result' }),
    );
    expect(makeProviderFromConfig).not.toHaveBeenCalled();
  });

  it('toggle ON with healthy daemon: probe flips active, live provider rebuilt routed', async () => {
    const daemon = await startDaemonStub();
    openDaemons.push(daemon);
    const s = makeSession();
    const ctx = makePrefsCtx();

    await handlePrefsUpdate(ctx, ws, { wrongProxyEnabled: true, wrongProxyUrl: daemon.url });
    await flushAsync();

    // Handler side effects: meta mirrors the toggle, prefs.updated broadcast.
    expect(ctx.meta['wrongProxyEnabled']).toBe(true);
    expect(ctx.meta['wrongProxyUrl']).toBe(daemon.url);
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'prefs.updated' }));
    // The probe really reached the daemon stub and flipped active.
    expect(getProxyConfig()).toEqual({ enabled: true, url: daemon.url, active: true });
    // The rebuild ran through the transition gate with the ROUTED URL.
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ baseUrl: `${daemon.url}/proxy/api.example.com/v1` }),
    );
    expect(s.context.runModelTransition).toHaveBeenCalled();
    expect(s.context.provider?.id).toBe('openai');
    s.dispose();
  });

  it('toggle OFF after healthy: live provider rebuilt back to direct (unrouted cfg)', async () => {
    const daemon = await startDaemonStub();
    openDaemons.push(daemon);
    const s = makeSession();
    const ctx = makePrefsCtx();

    // Full on → off cycle through the prefs pipeline only.
    await handlePrefsUpdate(ctx, ws, { wrongProxyEnabled: true, wrongProxyUrl: daemon.url });
    await flushAsync();
    expect(makeProviderFromConfig).toHaveBeenCalledTimes(1);

    await handlePrefsUpdate(ctx, ws, { wrongProxyEnabled: false });
    await flushAsync();

    // Second rebuild built DIRECT: no proxy-prefixed baseUrl anywhere.
    expect(makeProviderFromConfig).toHaveBeenCalledTimes(2);
    expect(makeProviderFromConfig).toHaveBeenLastCalledWith(
      'openai',
      expect.not.objectContaining({ baseUrl: expect.stringContaining('/proxy/') }),
    );
    // Probe's post-toggle-off active:false is a no-op (enabled already off).
    expect(getProxyConfig()).toEqual({ enabled: false, url: daemon.url, active: false });
    expect(s.context.provider?.id).toBe('openai');
    s.dispose();
  });

  it('toggle ON with DEAD daemon: no crash, provider stays direct (graceful fallback)', async () => {
    const deadUrl = await deadDaemonUrl();
    const s = makeSession();
    const ctx = makePrefsCtx();
    const providerBefore = s.context.provider;

    // The original complaint: proxy on but unreachable must not blow up.
    await expect(
      handlePrefsUpdate(ctx, ws, { wrongProxyEnabled: true, wrongProxyUrl: deadUrl }),
    ).resolves.toBeUndefined();
    await flushAsync();

    // Probe failed against the real closed port: active stays false.
    expect(getProxyConfig()).toEqual({ enabled: true, url: deadUrl, active: false });
    // No rebuild, no routed URL — the live provider keeps routing direct.
    expect(makeProviderFromConfig).not.toHaveBeenCalled();
    expect(s.context.provider).toBe(providerBefore);
    s.dispose();
  });
});
