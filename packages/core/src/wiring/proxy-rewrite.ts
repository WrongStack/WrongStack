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
 *   proxyUrl  = "http://localhost:8000"
 *   output    = "http://localhost:8000/proxy/api.openai.com/v1"
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
  // (e.g. http://localhost:8000/proxy/api.openai.com/v1).
  const normalizedProxy = proxyUrl.replace(/\/+$/, '');
  if (originalBaseUrl.startsWith(`${normalizedProxy}${PROXY_PATH_PREFIX}`)) {
    return false;
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
 * Apply a new proxy configuration. Returns the previous config so callers
 * (notably the probe) can decide whether the change requires an immediate
 * probe vs. waiting for the next tick.
 */
export function applyProxyConfig(next: Partial<ProxyConfig>): ProxyConfig {
  const previous = currentConfig;
  currentConfig = {
    enabled: next.enabled ?? previous.enabled,
    url: next.url ?? previous.url,
    active: next.active ?? previous.active,
  };
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
 * (the singleton lives for the lifetime of the process).
 */
export function __resetProxyConfigForTests(): void {
  currentConfig = { ...DEFAULT_PROXY_CONFIG };
}