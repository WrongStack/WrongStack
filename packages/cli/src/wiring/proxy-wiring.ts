/**
 * Bridge between the WS prefs pipeline and the proxy-rewrite runtime.
 *
 * Lives in `@wrongstack/cli/wiring/proxy-wiring.ts` because it owns the
 * side-effectful boot of the probe loop — `proxy-rewrite` is pure logic
 * and `proxy-probe` is the periodic side-effect loop, but neither knows
 * about WS prefs. This module is the single owner of:
 *
 *   - the singleton probe runner
 *   - pushing user prefs into the proxy-rewrite config
 *   - kicking off the periodic /api/health probe when the toggle goes on
 *
 * Re-exported so `handlePrefsUpdate` in `@wrongstack/webui-server` can
 * call `applyWrongProxyPrefs(payload)` without taking a direct dependency
 * on `proxy-probe` (the WS server is intentionally provider-agnostic).
 */

import {
  applyProxyConfig,
  type ProxyConfig,
} from '@wrongstack/core/wiring/proxy-rewrite';
import { startProxyProbe, type ProbeRunner } from './proxy-probe.js';

let probeRunner: ProbeRunner | undefined;

/**
 * Apply the `wrongProxyEnabled` + `wrongProxyUrl` portion of a prefs
 * payload. Idempotent — safe to call on every `prefs.update`. Boots the
 * probe on first call so the rewrite can be marked active before the
 * next request hits the provider factory.
 */
export function applyWrongProxyPrefs(payload: Record<string, unknown>): void {
  const patch: Partial<ProxyConfig> = {};
  if (typeof payload['wrongProxyEnabled'] === 'boolean') {
    patch.enabled = payload['wrongProxyEnabled'];
  }
  if (typeof payload['wrongProxyUrl'] === 'string') {
    patch.url = payload['wrongProxyUrl'];
  }
  if (Object.keys(patch).length === 0) return;
  applyProxyConfig(patch);

  // Boot the probe lazily — startProxyProbe() is idempotent and a no-op
  // when the toggle is off (the loop's first tick flips `active` to false).
  if (!probeRunner) {
    probeRunner = startProxyProbe();
  } else {
    // Toggle or URL changed while the probe was already running — force an
    // immediate re-probe so the rewrite reflects the new state without
    // waiting up to 30s for the next tick.
    void probeRunner.poke();
  }
}

/**
 * Await one probe pass so the `ProxyConfig` singleton's `active` flag is
 * settled before the caller reads it. Returns immediately when no probe
 * runner exists (toggle never enabled). Each call triggers a fresh
 * `runOnce()` probe — there is no memoization — so call it once per
 * decision point, not per request.
 *
 * This closes the cli-main boot race: `bootstrapWrongProxy()` seeds
 * `enabled` / `url` synchronously, but `startProxyProbe()` only schedules
 * a 30 s `setInterval` and the first `poke()` resolves on the next
 * macrotask. `setupProviderRuntime()` runs synchronously on the very
 * next line, so without this gate providers are constructed with the raw
 * base URL even when the toggle is on.
 */
export async function awaitFirstWrongProxyProbe(): Promise<void> {
  if (!probeRunner) return; // no runner booted → toggle off, nothing to await
  await probeRunner.poke();
}

/**
 * Apply the initial prefs snapshot at boot. Same as `applyWrongProxyPrefs`
 * but explicitly named for the boot site so future readers can find it.
 *
 * Accepts the canonical persisted shape (`config.tools.wrongProxy` —
 * `{ enabled?, url? }`) directly. The `enabled` / `url` keys are mapped
 * to the flat `wrongProxyEnabled` / `wrongProxyUrl` keys the proxy
 * rewriter reads; any other keys in the snapshot are ignored. Callers
 * that hold a `WrongProxyToolConfig` (the typed schema in
 * `@wrongstack/core/types/config/tools.ts`) can pass it through without
 * casting — the function never reads anything beyond `enabled` / `url`.
 */
export function bootstrapWrongProxy(
  snapshot:
    | {
        enabled?: boolean | undefined;
        url?: string | undefined;
      }
    | Record<string, unknown>
    | undefined,
): void {
  if (!snapshot) {
    applyWrongProxyPrefs({});
    return;
  }
  // Re-key to the flat `wrongProxyEnabled` / `wrongProxyUrl` keys the
  // runtime probe reads. Booleans, strings, and `undefined` pass
  // through unchanged; any other shape falls back to the raw record
  // path so legacy callers (WS prefs pipeline payloads) still work.
  const enabled = (snapshot as { enabled?: boolean }).enabled;
  const url = (snapshot as { url?: string }).url;
  if (typeof enabled === 'boolean' || typeof url === 'string') {
    const payload: Record<string, unknown> = {};
    if (typeof enabled === 'boolean') payload['wrongProxyEnabled'] = enabled;
    if (typeof url === 'string') payload['wrongProxyUrl'] = url;
    applyWrongProxyPrefs(payload);
    return;
  }
  applyWrongProxyPrefs(snapshot as Record<string, unknown>);
}

/**
 * Stop the probe. Intended for graceful shutdown / test cleanup.
 */
export function shutdownWrongProxy(): void {
  if (probeRunner) probeRunner.stop();
  probeRunner = undefined;
  applyProxyConfig({ enabled: false, url: '', active: false });
}