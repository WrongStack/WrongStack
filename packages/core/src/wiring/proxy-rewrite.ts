/**
 * Automatic proxy/trace rerouting for provider base URLs.
 *
 * Lives in `@wrongstack/core` so both `cli` and `runtime` packages can
 * import the same pure-logic rewriter without reaching across workspaces.
 * The CLI's `proxy-probe` (side-effectful, owns `setInterval`) lives in
 * `@wrongstack/cli` and pushes state into this module via `applyProxyConfig`.
 *
 * Example:
 *   original  = "https://api.openai.com/v1"
 *   proxyUrl  = "http://localhost:3444"
 *   output    = "http://localhost:3444/proxy/api.openai.com/v1"
 *
 * The host appears *without* a scheme in the path; the proxy terminates
 * TLS (or speaks plain HTTP for localhost) and forwards the original
 * scheme in the `X-Forwarded-Proto` header.
 */

const PROXY_PATH_PREFIX = '/proxy/';

/**
 * Providers whose base URLs MUST NOT be rewritten. openai-codex talks
 * directly to the ChatGPT backend over an OAuth-issued token, and the
 * `client_id` / audience in the token constrains the request origin —
 * routing it through a generic proxy breaks the auth check.
 */
export const PROXY_EXCLUDED_PROVIDERS: ReadonlySet<string> = new Set(['openai-codex']);

/**
 * Decide whether a provider id is eligible for proxy rerouting.
 *
 * - `openai-codex` is excluded by spec.
 * - Everything else (openai, anthropic, google, openai-compatible,
 *   custom saved-config aliases) flows through.
 */
export function isProxyEligible(providerId: string): boolean {
  if (!providerId) return false;
  if (PROXY_EXCLUDED_PROVIDERS.has(providerId)) return false;
  return true;
}

/**
 * Rewrite a provider base URL through the proxy.
 *
 * Returns the original input (passthrough) when the input is missing or
 * malformed — we never want the proxy rewriter to be the reason a request
 * fails when the proxy itself is misconfigured. The guards below are
 * deliberately permissive: a misconfigured proxy must NOT silently turn
 * into a hard error during provider construction.
 */
export function rewriteBaseUrl(
  originalBaseUrl: string | undefined,
  proxyUrl: string | undefined,
): string | undefined {
  if (!originalBaseUrl) return undefined;
  if (!proxyUrl) return originalBaseUrl;
  if (!isProxyEligibleForRewrite(originalBaseUrl, proxyUrl)) return originalBaseUrl;
  return composeRewrittenUrl(originalBaseUrl, proxyUrl);
}

function isProxyEligibleForRewrite(originalBaseUrl: string, proxyUrl: string): boolean {
  if (!originalBaseUrl.includes('://')) return false;
  if (!proxyUrl.includes('://')) return false;
  // Avoid double-wrap if the user already entered a proxy-mounted URL
  // (e.g. http://localhost:3444/proxy/api.openai.com/v1).
  const normalizedProxy = proxyUrl.replace(/\/+$/, '');
  if (originalBaseUrl.startsWith(`${normalizedProxy}${PROXY_PATH_PREFIX}`)) {
    return false;
  }
  // A base URL that already targets a local endpoint (localhost / loopback
  // with an explicit port) does not need a proxy hop — the daemon would just
  // forward to itself. Skip rewriting so a local model server (e.g. Ollama at
  // http://localhost:11434/v1) keeps talking to the local port directly.
  try {
    const parsed = new URL(originalBaseUrl);
    const isLoopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      // WHATWG URL serializes IPv6 hosts with brackets — `[::1]`, not `::1`.
      parsed.hostname === '[::1]';
    if (isLoopback && parsed.port !== '') return false;
  } catch {
    // Malformed original — fall through to the permissive passthrough below.
  }
  return true;
}

function composeRewrittenUrl(originalBaseUrl: string, proxyUrl: string): string {
  const parsedOriginal = new URL(originalBaseUrl);
  // Host + path; query and hash would be meaningless on the proxy root.
  const hostAndPath = `${parsedOriginal.host}${parsedOriginal.pathname}`;
  const trailingQuery = parsedOriginal.search || '';
  const trailingHash = parsedOriginal.hash || '';
  const proxyRoot = proxyUrl.replace(/\/+$/, '');
  return `${proxyRoot}${PROXY_PATH_PREFIX}${hostAndPath}${trailingQuery}${trailingHash}`;
}

/**
 * Active proxy configuration consumed by `resolveProviderCfg`. Module-scoped
 * so the wiring layer can read it without threading state through every
 * call site; updates from `applyProxyConfig()` are atomic from the JS
 * perspective (a single assignment).
 */
export interface ProxyConfig {
  /** Master switch — when false, no rewrite happens regardless of url. */
  enabled: boolean;
  /** Where the proxy listens. Empty string = unset (treated as disabled). */
  url: string;
  /** Last-known reachability state from the periodic probe. */
  active: boolean;
}

const DEFAULT_PROXY_CONFIG: ProxyConfig = { enabled: false, url: '', active: false };

let currentConfig: ProxyConfig = { ...DEFAULT_PROXY_CONFIG };

/** Read the current proxy configuration. Safe to call from any layer. */
export function getProxyConfig(): ProxyConfig {
  return currentConfig;
}

/**
 * Listener notified by `applyProxyConfig` when the resulting config
 * MATERIALLY changed (`enabled` / `url` / `active`). The periodic probe
 * re-writes the same healthy values every tick, so a value-identical
 * write must NOT notify — subscribers (e.g. the instant-apply provider
 * rebuilder) would otherwise run every probe interval.
 */
export type ProxyConfigListener = (next: ProxyConfig, previous: ProxyConfig) => void;

const listeners = new Set<ProxyConfigListener>();

/**
 * Subscribe to material proxy-config changes. Returns an unsubscribe
 * function. A throwing listener is isolated: it cannot break the probe
 * loop or starve other subscribers.
 */
export function subscribeToProxyConfig(listener: ProxyConfigListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Apply a new proxy configuration. Returns the previous config so callers
 * (notably the probe) can decide whether the change requires an immediate
 * probe vs. waiting for the next tick. Notifies subscribers only when the
 * merged result actually differs from the previous state.
 */
export function applyProxyConfig(next: Partial<ProxyConfig>): ProxyConfig {
  const previous = currentConfig;
  currentConfig = {
    enabled: next.enabled ?? previous.enabled,
    url: next.url ?? previous.url,
    active: next.active ?? previous.active,
  };
  const materialChange =
    currentConfig.enabled !== previous.enabled ||
    currentConfig.url !== previous.url ||
    currentConfig.active !== previous.active;
  if (materialChange) {
    for (const listener of listeners) {
      try {
        listener(currentConfig, previous);
      } catch {
        // A misbehaving subscriber must never break the probe loop or
        // prevent the remaining subscribers from being notified.
      }
    }
  }
  return previous;
}

/**
 * Convenience: should the rewriter run for a given provider id given the
 * current configuration? Centralizes the "is proxy on AND active AND not
 * excluded" rule so future call sites can't accidentally skip a check.
 */
export function shouldRewriteFor(providerId: string): boolean {
  const cfg = currentConfig;
  if (!cfg.enabled || !cfg.active || !cfg.url) return false;
  return isProxyEligible(providerId);
}

/**
 * Reset to defaults. Intended for tests; do NOT call from production code
 * (the singleton lives for the lifetime of the process). Also drops all
 * change listeners so tests never observe each other's notifications.
 */
export function __resetProxyConfigForTests(): void {
  currentConfig = { ...DEFAULT_PROXY_CONFIG };
  listeners.clear();
}

// ─── Instant-apply: rebuild live providers on routing changes ─────────────
//
// Everything above is the pure rewrite logic + the config singleton; the
// block below consumes BOTH to close the construction-time gap: providers
// bake their (possibly proxy-rewritten) base URL at build time, so a
// mid-session toggle or probe deactivation would otherwise leave the LIVE
// provider pinned to a stale URL until some other code path happened to
// build a new one.
//
// Lives IN this module (not a sibling `proxy-instant-apply.ts`) because
// the build bundles each core entry independently: a sibling importing
// `./proxy-rewrite.js` relatively gets INLINED, duplicating this module
// and splitting the singleton + subscriber set into two instances. Same
// module = structurally one instance, in every consumer.

/** Minimal structural logger — keeps this module dependency-free. */
export interface ProxyInstantApplyLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface ProxyInstantApplyDeps {
  /** Current active provider id — the provider whose URL is baked in. */
  getActiveProviderId: () => string;
  /**
   * Raw (pre-rewrite) base URL for a provider id, exactly as
   * `resolveProviderCfg` reads it: `savedCfg?.baseUrl ?? config.baseUrl`.
   * The singleton holds no provider configs, so the caller — who owns the
   * live Config — must inject this reader.
   */
  getRawBaseUrl: (providerId: string) => string | undefined;
  /**
   * Rebuild the live provider for `providerId` and swap it into the live
   * context. Callers inject their existing path — e.g.
   * `buildProviderForModel(providerId, model)` — which re-resolves
   * proxy-aware config via `shouldRewriteFor` on every build. Should
   * serialize the swap through the host's model-transition gate and
   * re-check the live provider id inside it (superseded guard).
   */
  rebuildProvider: (providerId: string) => Promise<void>;
  /** Structured logger for the rebuild decisions. */
  logger: ProxyInstantApplyLogger;
}

export interface ProxyInstantApplyHandle {
  /** Detach the subscription. Safe to call more than once. */
  dispose: () => void;
}

/**
 * Compute the base URL the active provider SHOULD be using right now.
 * `undefined` means "provider carries no base URL" (pure catalog
 * provider) — two `undefined` verdicts are not a routing change.
 */
function effectiveBaseUrl(
  providerId: string,
  rawBaseUrl: string | undefined,
): string | undefined {
  if (!rawBaseUrl) return undefined;
  return shouldRewriteFor(providerId)
    ? rewriteBaseUrl(rawBaseUrl, currentConfig.url)
    : rawBaseUrl;
}

/**
 * Subscribe to material proxy-config changes and rebuild the live
 * provider when the routing verdict for the ACTIVE provider changes.
 *
 * Comparison is on the effective base URL, so:
 *   - probe ticks that rewrite identical values never rebuild;
 *   - a proxy URL change while enabled+active rebuilds (new target);
 *   - deactivation rebuilds (proxy-rewritten → raw);
 *   - toggling off while already direct does NOT rebuild;
 *   - a provider/model switch through another path re-baselines instead
 *     of rebuilding (that path built its provider through the
 *     proxy-aware builder already).
 *
 * Rebuilds are SERIALIZED: a toggle-off immediately followed by a probe
 * verdict must not race two async rebuilds against each other — the
 * slower, stale build could overwrite the fresh provider swap. Each
 * rebuild re-reads proxy state at build time, so the chain converges on
 * the latest verdict.
 */
export function createProxyInstantApply(deps: ProxyInstantApplyDeps): ProxyInstantApplyHandle {
  const { getActiveProviderId, getRawBaseUrl, rebuildProvider, logger } = deps;

  let lastProviderId = getActiveProviderId();
  let lastEffectiveUrl = effectiveBaseUrl(lastProviderId, getRawBaseUrl(lastProviderId));
  let disposed = false;
  let rebuildChain: Promise<void> = Promise.resolve();
  const unsubscribe = subscribeToProxyConfig(() => {
    if (disposed) return;
    const providerId = getActiveProviderId();
    const raw = getRawBaseUrl(providerId);
    const next = effectiveBaseUrl(providerId, raw);
    if (providerId !== lastProviderId) {
      lastProviderId = providerId;
      lastEffectiveUrl = next;
      return;
    }
    if (next === lastEffectiveUrl) return;
    lastEffectiveUrl = next;
    rebuildChain = rebuildChain
      .then(() => rebuildProvider(providerId))
      .then(() => {
        if (!disposed) {
          logger.info(`WrongProxy routing changed — live provider rebuilt (${providerId})`);
        }
      })
      .catch((err: unknown) => {
        if (!disposed) {
          logger.warn(
            `WrongProxy instant-apply: provider rebuild failed for ${providerId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });
  });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}