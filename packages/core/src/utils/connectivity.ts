/**
 * Lightweight outbound internet connectivity check.
 *
 * Probes a reliable public endpoint to determine if the current machine
 * has working outbound internet access. Used during provider-error handling
 * to distinguish "the provider's API is down" from "our internet is down" —
 * the two need different remediation (wait vs. fix local network).
 *
 * The result is cached for a short TTL so rapid successive checks don't
 * hammer the probe target.
 */

const DEFAULT_PROBE_URL = 'https://1.1.1.1';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 30_000;

interface ConnectivityCache {
  ok: boolean;
  at: number;
}

let cached: ConnectivityCache | undefined;

/**
 * Returns `true` when the probe endpoint responds successfully (any HTTP
 * status that isn't a server-side failure), `false` on network error or
 * timeout. The result is cached for `ttlMs` (default 30 s).
 *
 * Probing `1.1.1.1` (Cloudflare DNS) is intentional: it's a CDN-backed
 * static page served from virtually every PoP, so a failure almost certainly
 * means the local network is down rather than the probe target being
 * unreachable.
 */
export async function checkConnectivity(opts?: {
  /** Probe URL. Default: https://1.1.1.1 */
  probeUrl?: string;
  /** Per-request timeout in ms. Default: 5000 (5 s). */
  timeoutMs?: number;
  /** Cache TTL in ms. Default: 30000 (30 s). Set 0 to force a fresh probe. */
  ttlMs?: number;
}): Promise<boolean> {
  const url = opts?.probeUrl ?? DEFAULT_PROBE_URL;
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;

  // Respect a non-expired cache entry
  if (cached && ttl > 0 && Date.now() - cached.at < ttl) {
    return cached.ok;
  }

  cached = { ok: await probe(url, timeout), at: Date.now() };
  return cached.ok;
}

async function probe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    // The response body is irrelevant; any HTTP response (including
    // 4xx/5xx from the probe target) means the network path works —
    // the server reached us back.
    await fetch(url, { method: 'HEAD', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reset the cached connectivity result so the next call performs a fresh
 * probe. Useful during error recovery when the network state may have
 * changed.
 */
export function resetConnectivityCache(): void {
  cached = undefined;
}
