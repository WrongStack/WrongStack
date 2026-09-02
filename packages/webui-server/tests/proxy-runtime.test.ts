/**
 * Unit tests for the standalone WebUI WrongProxy runtime module
 * (`packages/webui-server/src/server/proxy-runtime.ts`).
 *
 * Mocking strategy per contract:
 *   - `@wrongstack/core/wiring/proxy-rewrite` `applyProxyConfig` is replaced
 *     with a vi.fn spy that DELEGATES to the real implementation, so the
 *     singleton state stays real (getProxyConfig / shouldRewriteFor /
 *     rewriteBaseUrl read it) while tests can assert what was applied.
 *   - global `fetch` is mocked so the `/api/health` probe never hits the
 *     network.
 *
 * The helper `routeProviderCfgThroughProxy` is the shared seam that
 * `routes.ts applyModelSwitchCore` / `setup-screen.ts resolveSetupProvider` /
 * `embedded-host-adapters.ts applyEmbeddedModelSwitch` all delegate to, so its
 * active=true/false gate coverage is the unit-level proxy of those sites.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProxyConfig,
  getProxyConfig,
  __resetProxyConfigForTests,
} from '@wrongstack/core/wiring/proxy-rewrite';
import type { Config } from '@wrongstack/core/types';

vi.mock('@wrongstack/core/wiring/proxy-rewrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/wiring/proxy-rewrite')>();
  return {
    ...actual,
    // Spy that records calls AND keeps the real singleton state in sync so
    // real shouldRewriteFor / getProxyConfig / rewriteBaseUrl observe it.
    applyProxyConfig: vi.fn((next: Parameters<typeof applyProxyConfig>[0]) =>
      actual.applyProxyConfig(next),
    ),
  };
});

const fetchMock = vi.fn();

import {
  applyWrongProxyPrefs,
  bootstrapWrongProxyFromConfig,
  probeWrongProxyActive,
  routeProviderCfgThroughProxy,
  seedWrongProxyFromConfig,
} from '../src/server/proxy-runtime.js';

function wrongProxyConfig(enabled: boolean, url: string): Config {
  return {
    version: 1,
    provider: 'openai',
    model: 'gpt-4o',
    tools: { wrongProxy: { enabled, url } },
  } as unknown as Config;
}

function enableProxy(url = 'http://localhost:3444', active = true): void {
  applyProxyConfig({ enabled: true, url, active });
}

beforeEach(() => {
  __resetProxyConfigForTests();
  vi.mocked(applyProxyConfig).mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  __resetProxyConfigForTests();
  vi.unstubAllGlobals();
});

describe('seedWrongProxyFromConfig', () => {
  it('applies enabled + url from config.tools.wrongProxy', () => {
    seedWrongProxyFromConfig(wrongProxyConfig(true, 'http://localhost:3444'));
    expect(applyProxyConfig).toHaveBeenCalledWith({
      enabled: true,
      url: 'http://localhost:3444',
    });
  });

  it('applies enabled:false when the toggle is off but url is present', () => {
    seedWrongProxyFromConfig(wrongProxyConfig(false, 'http://localhost:3444'));
    expect(applyProxyConfig).toHaveBeenCalledWith({ enabled: false, url: 'http://localhost:3444' });
  });

  it('normalizes a non-string url to empty', () => {
    const config = {
      version: 1,
      provider: 'openai',
      model: 'gpt-4o',
      tools: { wrongProxy: { enabled: true, url: 12345 } },
    } as unknown as Config;
    seedWrongProxyFromConfig(config);
    expect(applyProxyConfig).toHaveBeenCalledWith({ enabled: true, url: '' });
  });

  it('is a no-op when config has no wrongProxy block', () => {
    seedWrongProxyFromConfig({ version: 1, provider: 'openai', model: 'gpt-4o' } as Config);
    expect(applyProxyConfig).not.toHaveBeenCalled();
  });
});

describe('probeWrongProxyActive', () => {
  it('marks the proxy active on a 2xx /api/health response', async () => {
    enableProxy('http://localhost:3444');
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await expect(probeWrongProxyActive()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3444/api/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(applyProxyConfig).toHaveBeenCalledWith({ active: true });
  });

  it('marks inactive on a non-2xx response', async () => {
    enableProxy('http://localhost:3444');
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(probeWrongProxyActive()).resolves.toBe(false);
    expect(applyProxyConfig).toHaveBeenCalledWith({ active: false });
  });

  it('marks inactive when fetch rejects (ECONNREFUSED)', async () => {
    enableProxy('http://localhost:3444');
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(probeWrongProxyActive()).resolves.toBe(false);
    expect(applyProxyConfig).toHaveBeenCalledWith({ active: false });
  });

  it('does not probe when the toggle is off', async () => {
    // The early-return guard is `!enabled || !url` — toggle OFF means
    // enabled:false; active:false alone still probes (daemon-unreachable case).
    applyProxyConfig({ enabled: false, url: 'http://localhost:3444', active: false });
    await expect(probeWrongProxyActive()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyProxyConfig).toHaveBeenCalledWith({ active: false });
  });

  it('normalizes a trailing slash on the URL before probing', async () => {
    enableProxy('http://localhost:3444/');
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await probeWrongProxyActive();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3444/api/health', expect.anything());
  });
});

describe('bootstrapWrongProxyFromConfig', () => {
  it('seeds from config then activates when the daemon is reachable', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await bootstrapWrongProxyFromConfig(wrongProxyConfig(true, 'http://localhost:3444'));
    expect(applyProxyConfig).toHaveBeenCalledWith({
      enabled: true,
      url: 'http://localhost:3444',
    });
    expect(applyProxyConfig).toHaveBeenCalledWith({ active: true });
    expect(getProxyConfig().active).toBe(true);
  });

  it('seeds but leaves inactive when the daemon is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('ECONNREFUSED'));
    await bootstrapWrongProxyFromConfig(wrongProxyConfig(true, 'http://localhost:3444'));
    expect(applyProxyConfig).toHaveBeenCalledWith({ active: false });
    expect(getProxyConfig().active).toBe(false);
  });

  it('leaves the singleton disabled when config has no wrongProxy block', async () => {
    await bootstrapWrongProxyFromConfig({
      version: 1,
      provider: 'openai',
      model: 'gpt-4o',
    } as Config);
    expect(getProxyConfig().enabled).toBe(false);
    expect(getProxyConfig().active).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('applyWrongProxyPrefs', () => {
  it('applies enable + url from a prefs payload and re-probes', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await applyWrongProxyPrefs({
      wrongProxyEnabled: true,
      wrongProxyUrl: 'http://localhost:3444',
    });
    expect(applyProxyConfig).toHaveBeenCalledWith({
      enabled: true,
      url: 'http://localhost:3444',
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(applyProxyConfig).toHaveBeenCalledWith({ active: true });
  });

  it('is a no-op when the payload carries neither key', async () => {
    await applyWrongProxyPrefs({ someOther: 'pref' });
    expect(applyProxyConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('routeProviderCfgThroughProxy (shared rewrite seam)', () => {
  it('rewrites an eligible baseUrl through the proxy when active', () => {
    enableProxy('http://localhost:3444', true);
    const out = routeProviderCfgThroughProxy(
      { type: 'openai', baseUrl: 'https://api.openai.com/v1' },
      undefined,
      'openai',
    );
    expect(out.baseUrl).toBe('http://localhost:3444/proxy/api.openai.com/v1');
  });

  it('leaves the config untouched when active=false', () => {
    enableProxy('http://localhost:3444', false);
    const cfg = { type: 'openai', baseUrl: 'https://api.openai.com/v1' };
    const out = routeProviderCfgThroughProxy(cfg, undefined, 'openai');
    expect(out.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('leaves the config untouched when the proxy is never enabled', () => {
    const cfg = { type: 'openai', baseUrl: 'https://api.openai.com/v1' };
    const out = routeProviderCfgThroughProxy(cfg, undefined, 'openai');
    expect(out.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('uses the fallback baseUrl when the cfg carries no explicit one (applyModelSwitchCore path)', () => {
    enableProxy('http://localhost:3444', true);
    const cfg: { type: string; baseUrl?: string } = { type: 'openai' };
    const out = routeProviderCfgThroughProxy(cfg, 'https://api.openai.com/v1', 'openai');
    expect(out.baseUrl).toBe('http://localhost:3444/proxy/api.openai.com/v1');
  });

  it('never injects the fallback when the proxy is off', () => {
    const cfg: { type: string; baseUrl?: string } = { type: 'openai' };
    const out = routeProviderCfgThroughProxy(cfg, 'https://api.openai.com/v1', 'openai');
    expect(out).toEqual(cfg);
    expect(out.baseUrl).toBeUndefined();
  });

  it('excludes openai-codex (and its aliases via factory type)', () => {
    enableProxy('http://localhost:3444', true);
    const out = routeProviderCfgThroughProxy(
      { type: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api/v1' },
      undefined,
      'openai-codex',
    );
    expect(out.baseUrl).toBe('https://chatgpt.com/backend-api/v1');
  });

  it('does not proxy a base URL that already targets loopback with a port', () => {
    enableProxy('http://localhost:3444', true);
    const out = routeProviderCfgThroughProxy(
      { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
      undefined,
      'openai-compatible',
    );
    expect(out.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('preserves a non-baseUrl field on the routed config', () => {
    enableProxy('http://localhost:3444', true);
    const out = routeProviderCfgThroughProxy(
      { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
      undefined,
      'openai',
    );
    expect(out.baseUrl).toBe('http://localhost:3444/proxy/api.openai.com/v1');
    expect(out.apiKey).toBe('sk-test');
  });
});
