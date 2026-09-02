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
  let parsedOriginal: URL;
  try {
    parsedOriginal = new URL(originalBaseUrl);
  } catch {
    // Scheme'd but unparseable (e.g. "https://[::1", "http://exa mple.com").
    // isProxyEligibleForRewrite deliberately lets these through, so this is
    // the last line of defense for the module contract: the rewriter must
    // NEVER be the reason provider construction fails — pass through.
    return originalBaseUrl;
  }
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

// ─── Probe transition logging ──────────────────────────────────────────────
//
// Lives HERE (not in the CLI's proxy-probe.ts) for the same structural
// reason as instant-apply below: the CLI's esbuild bundle can copy
// proxy-probe.ts's module scope into MULTIPLE chunks (verified live
// 2026-08-25: setProxyProbeLogger landed in chunk-QTASZ2IS.js while
// startProxyProbe ran from chunk-GWVLRUVH.js), so a module-level logger
// variable there splits into per-chunk copies and the probe reads the one
// the host never set — silently silent logging. Core modules are
// externalized in the CLI build, so THIS module is structurally one
// instance everywhere; state here is shared by every bundled copy.

/**
 * Minimal structural logger for probe transitions. Deliberately not core's
 * full `Logger` so any host (CLI logger, subcommand, test stub) can pass a
 * plain object.
 */
export interface ProxyTransitionLogger {
  info(message: string): void;
  warn(message: string): void;
}

let proxyTransitionLogger: ProxyTransitionLogger | undefined;

/**
 * Install (or replace) the probe's transition logger. Affects the running
 * probe immediately (the flip path reads this variable at log time).
 * Passing undefined silences transition logging again.
 */
export function setProxyTransitionLogger(logger: ProxyTransitionLogger | undefined): void {
  proxyTransitionLogger = logger;
}

/**
 * Redact a URL for logging: keep scheme://host[:port]/path, drop query and
 * fragment. Provider/proxy URLs may embed credentials there (`?key=...`);
 * a log line must never persist them.
 */
export function sanitizeUrlForLog(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Unparseable — keep only the portion before any query, fragment, or
    // control character. A malformed string that smuggles `#secret` or a
    // CR/LF would otherwise land in the log verbatim.
    const cut = raw.search(/[?#\x00-\x1f\x7f]/);
    return cut >= 0 ? raw.slice(0, cut) : raw;
  }
}

/**
 * Emit one probe-transition line. Called ONLY when `active` actually flips
 * (never on verdict-identical probes) — every flip is a routing change for
 * every subsequent provider build. Fully isolated: a throwing logger must
 * never alter probe control flow.
 */
export function logProxyTransition(next: boolean, reason: string): void {
  const log = proxyTransitionLogger;
  if (!log) return;
  // The reason string deliberately carries NO URL — the sanitized proxy=
  // field does, so raw URLs never ride into the log via the reason.
  const url = sanitizeUrlForLog(currentConfig.url) || '<unset>';
  const line = next
    ? `WrongProxy active=true (${reason}) — base-URL rewrites ON, proxy=${url}`
    : `WrongProxy active=false (${reason}) — base-URL rewrites OFF, proxy=${url}`;
  try {
    if (next) log.info(line);
    else log.warn(line);
  } catch {
    // Observability failure must not corrupt probe state or verdicts.
  }
}

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
 * Automatically deactivate the proxy if a connection failure occurs while
 * the proxy was marked active. Triggers instant-apply provider rebuilds to
 * fallback immediately to direct provider communication without failing the turn.
 */
export function deactivateProxyOnConnectionFailure(err: unknown): boolean {
  const cfg = currentConfig;
  if (!cfg.enabled || !cfg.active) return false;

  const msg = (
    err instanceof Error
      ? `${err.name} ${err.message} ${(err as { code?: string }).code ?? ''}`
      : String(err)
  ).toLowerCase();

  let isProxyFail = false;
  if (cfg.url) {
    try {
      const parsed = new URL(cfg.url);
      if (msg.includes(parsed.host.toLowerCase())) isProxyFail = true;
    } catch {}
  }

  if (
    !isProxyFail &&
    (msg.includes('econnrefused') ||
      msg.includes('ehostunreach') ||
      msg.includes('enetunreach') ||
      msg.includes('fetch failed') ||
      msg.includes('failed to fetch') ||
      msg.includes('connect error') ||
      msg.includes('proxy error') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504'))
  ) {
    isProxyFail = true;
  }

  if (isProxyFail) {
    applyProxyConfig({ active: false });
    return true;
  }
  return false;
}

/**
 * Reset to defaults. Intended for tests; do NOT call from production code
 * (the singleton lives for the lifetime of the process). Also drops all
 * change listeners so tests never observe each other's notifications.
 */
export function __resetProxyConfigForTests(): void {
  currentConfig = { ...DEFAULT_PROXY_CONFIG };
  proxyTransitionLogger = undefined;
  listeners.clear();
  // A previous test's instant-apply handles must not leak their (possibly
  // never-settling) rebuild chains into the next test's settle waits.
  instantApplyChains.clear();
}

// ─── Routing-settle barrier ────────────────────────────────────────────────
//
// Deactivation (deactivateProxyOnConnectionFailure) flips the config flag
// and notifies listeners synchronously, but each instant-apply provider
// rebuild runs on an async chain. A retry loop that re-reads ctx.provider
// before the rebuild lands would spend its remaining attempts on the dead
// proxy URL — the exact outage the deactivation was routing around. This
// barrier lets the retry path wait (bounded) for every live instant-apply
// chain to drain before scheduling the next attempt.

/** Upper bound for {@link waitForProxyRoutingSettle}. Local provider builds
 *  settle in single-digit milliseconds; anything slower means the host is
 *  doing network work inside rebuildProvider, and a retrying turn must not
 *  hang on it. Resolves on timeout — the barrier delays, never fails. */
export const PROXY_ROUTING_SETTLE_CAP_MS = 2_000;

/** Live rebuild-chain getters, one per non-disposed instant-apply handle. */
const instantApplyChains = new Set<() => Promise<void>>();

/**
 * Wait until every registered instant-apply rebuild triggered by the current
 * proxy-config change has settled, the cap elapses, or `signal` aborts.
 * Resolves in all three cases — a settle timeout must not fail the turn,
 * only stop delaying it.
 */
export async function waitForProxyRoutingSettle(
  timeoutMs: number = PROXY_ROUTING_SETTLE_CAP_MS,
  signal?: AbortSignal | undefined,
): Promise<void> {
  // A pre-aborted signal must resolve immediately — `addEventListener` on an
  // already-aborted signal never fires, so without this check an aborted
  // turn would sit out the full cap before its catch path ran.
  if (signal?.aborted) return;
  // Snapshot the CURRENT chain promise from each handle. Listener bodies run
  // synchronously up to the rebuild scheduling, so by the time a caller that
  // just deactivated the proxy awaits this, the pending chain is registered.
  const chains = [...instantApplyChains].map((get) => get());
  if (chains.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      Promise.allSettled(chains),
      new Promise<void>((resolve) => {
        onAbort = () => resolve();
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
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
 * Compute the base URL the active provider SHOULD be using under a given
 * proxy config. `undefined` means "provider carries no base URL" (pure
 * catalog provider) — two `undefined` verdicts are not a routing change.
 */
function effectiveBaseUrlFor(
  cfg: ProxyConfig,
  providerId: string,
  rawBaseUrl: string | undefined,
): string | undefined {
  if (!rawBaseUrl) return undefined;
  const active = cfg.enabled && cfg.active && !!cfg.url && isProxyEligible(providerId);
  return active ? rewriteBaseUrl(rawBaseUrl, cfg.url) : rawBaseUrl;
}

function effectiveBaseUrl(providerId: string, rawBaseUrl: string | undefined): string | undefined {
  return effectiveBaseUrlFor(currentConfig, providerId, rawBaseUrl);
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
 *   - a provider/model switch between notifications re-baselines against
 *     the PREVIOUS config — the config the switch actually built under —
 *     and then falls through to the verdict comparison. Seeding from the
 *     new config instead would swallow a needed rebuild: a provider that
 *     switched in while the proxy was on (built rewritten) must rebuild
 *     direct when the very next change deactivates the proxy.
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
  // Publish the chain so waitForProxyRoutingSettle can observe pending
  // rebuilds. Registered for the handle's lifetime; removed on dispose so a
  // torn-down host (standalone WebUI shutdown) stops delaying retries.
  const chainGetter = (): Promise<void> => rebuildChain;
  instantApplyChains.add(chainGetter);
  const unsubscribe = subscribeToProxyConfig((next, previous) => {
    if (disposed) return;
    const providerId = getActiveProviderId();
    const raw = getRawBaseUrl(providerId);
    const nextUrl = effectiveBaseUrlFor(next, providerId, raw);
    // If the active provider moved since the last notification, the
    // switch-installed provider was built under the PREVIOUS config —
    // that is the honest baseline, not `nextUrl`.
    const baselineUrl =
      providerId === lastProviderId
        ? lastEffectiveUrl
        : effectiveBaseUrlFor(previous, providerId, raw);
    lastProviderId = providerId;
    lastEffectiveUrl = nextUrl;
    if (nextUrl === baselineUrl) return;
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
      instantApplyChains.delete(chainGetter);
      unsubscribe();
    },
  };
}
