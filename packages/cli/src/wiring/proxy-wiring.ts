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
 * Apply the initial prefs snapshot at boot. Same as `applyWrongProxyPrefs`
 * but explicitly named for the boot site so future readers can find it.
 */
export function bootstrapWrongProxy(
  snapshot: Record<string, unknown> | undefined,
): void {
  applyWrongProxyPrefs(snapshot ?? {});
}

/**
 * Stop the probe. Intended for graceful shutdown / test cleanup.
 */
export function shutdownWrongProxy(): void {
  if (probeRunner) probeRunner.stop();
  probeRunner = undefined;
  applyProxyConfig({ enabled: false, url: '', active: false });
}