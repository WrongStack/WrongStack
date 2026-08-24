/**
 * WrongProxy / WrongTrace runtime seeding for the standalone WebUI server.
 *
 * The CLI hosts WebUI in-process via `dispatch-webui.ts`, which injects
 * `applyWrongProxyPrefs` (from `@wrongstack/cli/wiring/proxy-wiring`) into
 * the WS prefs handler and shares the CLI's proxy singleton. But when the
 * WebUI server runs as its OWN process (`startWebUI`), no CLI is present to
 * seed the `ProxyConfig` singleton in `@wrongstack/core/wiring/proxy-rewrite`
 * — so all of the server's provider-build paths would construct providers
 * with the raw base URL and never traverse the proxy.
 *
 * webui ⇏ cli, so this module cannot import `@wrongstack/cli`'s probe. It
 * owns the same two concerns the CLI's `proxy-wiring` does, but dependency-
 * light and self-contained:
 *
 *   1. Seeding the shared `ProxyConfig` singleton (`enabled` / `url`) from
 *      `config.tools.wrongProxy` at boot.
 *   2. A one-shot `/api/health` reachability probe that flips `active` to
 *      true so `shouldRewriteFor()` returns true for subsequent provider
 *      builds. Unlike the CLI's periodic probe this runs once at seed time
 *      (the standalone server re-probes when the operator toggles the field
 *      via `applyWrongProxyPrefs`); a long-lived daemon is assumed stable.
 *
 * The rewrite itself (`shouldRewriteFor` / `rewriteBaseUrl`) is pure logic
 * in `@wrongstack/core` and is applied at each provider-build site in this
 * server (setup-screen, routes applyModelSwitchCore, embedded-message-router,
 * embedded-host-adapters, start-webui-credential-watcher).
 */

import type { Config } from '@wrongstack/core/types';
import {
  applyProxyConfig,
  getProxyConfig,
  rewriteBaseUrl,
  shouldRewriteFor,
} from '@wrongstack/core/wiring/proxy-rewrite';

const HEALTH_PATH = '/api/health';
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Seed the shared `ProxyConfig` singleton from the persisted
 * `config.tools.wrongProxy.{enabled,url}` block. Idempotent — safe to call
 * at every boot. A provider that is eligible and reachable with a
 * configured URL will then have its base URL rewritten through the proxy.
 */
export function seedWrongProxyFromConfig(config: Config): void {
  const wp = config.tools?.wrongProxy as
    | { enabled?: boolean | undefined; url?: string | undefined }
    | undefined;
  if (!wp) {
    // No persisted block → leave the singleton at its default (disabled).
    return;
  }
  applyProxyConfig({
    enabled: wp.enabled === true,
    url: typeof wp.url === 'string' ? wp.url : '',
  });
}

/**
 * Probe the configured proxy daemon once and flip `active` to true when it
 * answers a 2xx on `/api/health`. Mirrors the CLI's probe contract but
 * without owning a `setInterval` loop. Resolves with the new `active` value.
 * A non-2xx / timeout / ECONNREFUSED leaves `active` false so the rewriter
 * keeps base URLs unchanged.
 */
export async function probeWrongProxyActive(): Promise<boolean> {
  const cfg = getProxyConfig();
  if (!cfg.enabled || !cfg.url) {
    applyProxyConfig({ active: false });
    return false;
  }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  if (typeof (timeout as { unref?: () => void }).unref === 'function') {
    (timeout as { unref: () => void }).unref();
  }
  try {
    const healthUrl = `${cfg.url.replace(/\/+$/, '')}${HEALTH_PATH}`;
    const res = await fetch(healthUrl, {
      method: 'GET',
      signal: abort.signal,
      headers: { accept: 'application/json' },
    });
    const ok = res.ok && res.status >= 200 && res.status < 300;
    applyProxyConfig({ active: ok });
    return ok;
  } catch {
    applyProxyConfig({ active: false });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Apply the `wrongProxyEnabled` + `wrongProxyUrl` portion of a WS prefs
 * payload, then re-probe so the rewrite reflects the new state immediately
 * (the next provider build reads the freshly-probed `active`). Skips when the
 * payload carries neither key. Mirrors the CLI's `applyWrongProxyPrefs`.
 */
export async function applyWrongProxyPrefs(
  payload: Record<string, unknown>,
): Promise<void> {
  const patch: Partial<{ enabled: boolean; url: string }> = {};
  if (typeof payload['wrongProxyEnabled'] === 'boolean') {
    patch.enabled = payload['wrongProxyEnabled'];
  }
  if (typeof payload['wrongProxyUrl'] === 'string') {
    patch.url = payload['wrongProxyUrl'];
  }
  if (Object.keys(patch).length === 0) return;
  applyProxyConfig(patch);
  await probeWrongProxyActive();
}

/**
 * Seed the singleton from the persisted config and await the first probe so
 * `active` is correct BEFORE the server's provider is constructed. Without
 * the await, `setup-screen`'s `resolveSetupProvider` reads the singleton
 * (synchronously) while `active` is still false and bakes the raw base URL
 * into the initial provider. Mirrors the CLI's
 * `bootstrapWrongProxy` + `awaitFirstWrongProxyProbe` pair.
 */
export async function bootstrapWrongProxyFromConfig(config: Config): Promise<void> {
  seedWrongProxyFromConfig(config);
  await probeWrongProxyActive();
}

/**
 * Apply the WrongProxy / WrongTrace base-URL rewrite to ONE provider config
 * before it is handed to a provider factory. This is the single shared seam
 * for every WebUI-server provider-build path so the eligibility + compose
 * rules cannot drift between call sites:
 *
 *   - `routes.ts` `applyModelSwitchCore` (model.switch rebuild)
 *   - `setup-screen.ts` `resolveSetupProvider` (boot branches 1 + 2)
 *   - `embedded-message-router.ts` `buildProvider`
 *   - `embedded-host-adapters.ts` `applyEmbeddedModelSwitch`
 *   - `start-webui-credential-watcher.ts` (credential hot-reload)
 *
 * Returns a copy of `cfg` with `baseUrl` overridden to
 * `${proxyUrl}/proxy/<host><path>` when the toggle is on, the daemon is
 * reachable (`active`) and the provider is eligible (openai-codex excluded
 * by the rewriter). `fallbackBaseUrl` is used when `cfg` carries no explicit
 * baseUrl (the call site's top-level config baseUrl). When the proxy is off
 * or unreachable, the cfg is returned unchanged so factory construction
 * behaves exactly as before the proxy feature existed.
 */
export function routeProviderCfgThroughProxy<T extends object>(
  cfg: Readonly<T>,
  fallbackBaseUrl: string | undefined,
  providerId: string,
): T {
  const raw = cfg as Readonly<{ type?: unknown; baseUrl?: unknown }>;
  const cfgType = typeof raw.type === 'string' ? raw.type : undefined;
  const cfgBaseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined;
  const factoryType = cfgType ?? providerId;
  const rawBaseUrl = cfgBaseUrl ?? fallbackBaseUrl;
  // Proxy off / daemon unreachable / excluded provider → pass the cfg through
  // UNTOUCHED, so factory construction behaves exactly as before the proxy
  // feature existed (no fallback URL is injected when the toggle is off).
  if (!rawBaseUrl || !shouldRewriteFor(factoryType)) {
    return { ...cfg } as T;
  }
  const baseUrl = rewriteBaseUrl(rawBaseUrl, getProxyConfig().url);
  return {
    ...cfg,
    ...(baseUrl !== cfgBaseUrl ? { baseUrl } : {}),
  } as T;
}

