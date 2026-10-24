/**
 * On-demand plan quota reads for the providers whose quota lives on an
 * account endpoint rather than on inference responses.
 *
 * The quota store is filled as a side effect of turns: Codex and Claude put
 * their windows in response headers, MiniMax and Z.AI are read after a turn
 * completes. A surface opened before any turn — the WebUI quota panel, a fresh
 * tab — would show nothing. For the two account-endpoint vendors that is not
 * the only option: their reads are account calls that spend none of the plan
 * they describe, so a surface may ask directly. ChatGPT/Codex has one too
 * (`/wham/usage`, the official client's `/status` read) but needs its OAuth
 * transport — token refresh and persistence — so it is read through a built
 * provider ({@link readProviderAccountQuota}). Claude has no such read and is
 * deliberately not covered — except through an OmniRoute gateway, whose own
 * cache of its pool accounts' limits is read with its management token.
 *
 * Prepaid balances (DeepSeek, Moonshot, SiliconFlow) and any endpoint the
 * user describes in `ProviderConfig.quotaEndpoint` go through the same path.
 *
 * Readings land in the shared store (`recordProviderQuota`), so every
 * `onProviderQuota` subscriber — the WebUI broadcast, the TUI chip — sees them
 * the same way it sees a post-turn reading.
 *
 * @module account-quota
 */

import type { Provider } from '@wrongstack/contracts/types';
import { balanceEndpoint, balanceVendorOfHost, reportBalanceQuota } from './balance-quota.js';
import { type QuotaEndpointConfig, reportCustomQuota } from './custom-quota.js';
import { KIMI_CODE_HOSTS, type KimiCodeHost, reportKimiCodeQuota } from './kimi-code-quota.js';
import { isMiniMaxHost, isMiniMaxProviderId, miniMaxAccountRoot } from './minimax.js';
import { reportMiniMaxQuota } from './minimax-quota.js';
import { omniRouteRoot, reportOmniRouteQuota } from './omniroute-quota.js';
import { OpenAICodexProvider } from './openai-codex.js';
import { reportOpenCodeQuota } from './opencode-quota.js';
import { reportOpenRouterQuota } from './openrouter-quota.js';
import { upstreamUrl } from './proxy-upstream.js';
import { SubscriptionOAuthProvider } from './subscription-oauth.js';
import { isZaiCodingPlanEndpoint, reportZaiQuota, zaiRegionOf } from './zai-account.js';

/** Vendors whose plan quota can be read on demand. */
export type AccountQuotaVendor =
  | 'minimax'
  | 'zai'
  | 'codex'
  | 'chatgpt'
  | 'kimi'
  | 'opencode'
  | 'openrouter'
  | 'omniroute'
  | 'deepseek'
  | 'moonshot'
  | 'siliconflow'
  | 'custom';

/**
 * The vendors whose transport does NOT read its own quota after a turn, so a
 * host-installed post-turn read ({@link attachAccountQuotaReporting}) is how
 * their readings stay current. MiniMax and Z.AI report from inside their own
 * transports; Codex from its response headers.
 */
const POST_TURN_VENDORS: ReadonlySet<AccountQuotaVendor> = new Set([
  'kimi',
  'opencode',
  'openrouter',
  'omniroute',
  'deepseek',
  'moonshot',
  'siliconflow',
  'custom',
]);

export interface AccountQuotaRefreshInput {
  /** The provider id the reading is recorded under (the config key). */
  providerId: string;
  /** The catalog type the provider is built from, when it differs from its id. */
  type?: string | undefined;
  /** The configured base URL; the catalog default for `type` when absent. */
  baseUrl?: string | undefined;
  /** The active inference key; empty for a keyless gateway. */
  apiKey: string;
  /** A gateway's management credential (OmniRoute `oma_…`). */
  managementToken?: string | undefined;
  /** A user-described account endpoint (`ProviderConfig.quotaEndpoint`). */
  quotaEndpoint?: QuotaEndpointConfig | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface AccountQuotaRefreshResult {
  vendor: AccountQuotaVendor;
  /** True when a reading was recorded. */
  ok: boolean;
}

/**
 * Catalog base URLs for the ids that are commonly saved without one. Only the
 * plan-backed Z.AI ids are listed: the pay-as-you-go `zai` / `zhipuai` never
 * draw on the plan, so they have no plan quota to read.
 */
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  minimax: 'https://api.minimax.io',
  'minimax-coding-plan': 'https://api.minimax.io',
  'minimax-cn': 'https://api.minimax.cn',
  'minimax-cn-coding-plan': 'https://api.minimax.cn',
  'zai-coding-plan': 'https://api.z.ai/api/coding/paas/v4',
  'zhipuai-coding-plan': 'https://open.bigmodel.cn/api/coding/paas/v4',
  'kimi-for-coding': 'https://api.kimi.com/coding/v1',
  'kimi-code-plan-cn': 'https://api.kimi.com/coding/v1',
  'kimi-code-plan-global': 'https://api.kimi.ai/coding/v1',
  omniroute: 'http://localhost:20128/v1',
  deepseek: 'https://api.deepseek.com',
  moonshotai: 'https://api.moonshot.ai/v1',
  'moonshotai-cn': 'https://api.moonshot.cn/v1',
  siliconflow: 'https://api.siliconflow.com/v1',
  'siliconflow-cn': 'https://api.siliconflow.cn/v1',
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** Host and path of a base URL, looking past a WrongProxy mount. */
function upstreamParts(url: string | undefined): { host: string; path: string } | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(upstreamUrl(url));
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname.toLowerCase() };
  } catch {
    return undefined;
  }
}

function kimiCodeHostOf(url: string | undefined): KimiCodeHost | undefined {
  const parts = upstreamParts(url);
  if (!parts?.path.startsWith('/coding')) return undefined;
  return (KIMI_CODE_HOSTS as readonly string[]).includes(parts.host)
    ? (parts.host as KimiCodeHost)
    : undefined;
}

/** Which on-demand vendor a provider belongs to, or undefined for any other. */
function accountQuotaVendorOf(input: {
  providerId: string;
  type?: string | undefined;
  baseUrl?: string | undefined;
  managementToken?: string | undefined;
  quotaEndpoint?: QuotaEndpointConfig | undefined;
}): AccountQuotaVendor | undefined {
  const url = resolveBaseUrl(input);
  // What the user spelled out wins over what the host suggests.
  if (input.quotaEndpoint) return 'custom';
  if ((input.type ?? input.providerId) === 'omniroute' && input.managementToken?.trim()) {
    return 'omniroute';
  }
  if (
    isMiniMaxHost(url) ||
    (url === undefined && isMiniMaxProviderId(input.type ?? input.providerId))
  ) {
    return 'minimax';
  }
  if (isZaiCodingPlanEndpoint(url)) return 'zai';
  if (kimiCodeHostOf(url)) return 'kimi';
  const parts = upstreamParts(url);
  if (parts?.host === 'opencode.ai' && parts.path.startsWith('/zen')) return 'opencode';
  if (parts?.host === 'openrouter.ai') return 'openrouter';
  return parts ? balanceVendorOfHost(parts.host) : undefined;
}

/** The credential a vendor's read needs: the gateway token, else the inference key. */
function credentialOf(vendor: AccountQuotaVendor, input: AccountQuotaRefreshInput): string {
  return (vendor === 'omniroute' ? input.managementToken : input.apiKey)?.trim() ?? '';
}

function resolveBaseUrl(input: {
  providerId: string;
  type?: string | undefined;
  baseUrl?: string | undefined;
}): string | undefined {
  const configured = input.baseUrl?.trim();
  if (configured) return configured;
  return DEFAULT_BASE_URLS[input.type ?? input.providerId] ?? DEFAULT_BASE_URLS[input.providerId];
}

/**
 * Read and record the plan quota of one provider, when it is an on-demand
 * vendor. Resolves to undefined for any other provider; never throws.
 */
export async function refreshProviderAccountQuota(
  input: AccountQuotaRefreshInput,
): Promise<AccountQuotaRefreshResult | undefined> {
  const vendor = accountQuotaVendorOf(input);
  if (vendor === undefined || !credentialOf(vendor, input)) return undefined;
  const url = resolveBaseUrl(input);
  try {
    if (vendor !== 'minimax' && vendor !== 'zai' && vendor !== 'codex' && vendor !== 'chatgpt') {
      const recorded = await readPostTurnVendor(vendor, input.providerId, url, input);
      return { vendor, ok: recorded > 0 };
    }
    if (vendor === 'minimax') {
      const snapshots = await reportMiniMaxQuota(input.providerId, {
        apiKey: input.apiKey,
        root: miniMaxAccountRoot(url),
        fetchImpl: input.fetchImpl,
        timeoutMs: input.timeoutMs,
      });
      return { vendor, ok: snapshots.length > 0 };
    }
    const region = zaiRegionOf(url);
    if (region === undefined) return undefined;
    const reading = await reportZaiQuota(input.providerId, {
      apiKey: input.apiKey,
      region,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
    });
    return { vendor, ok: reading !== undefined };
  } catch {
    return { vendor, ok: false };
  }
}

/**
 * Read and record the plan quota of an already-built provider, for vendors
 * whose read needs the live transport (ChatGPT/Codex: an OAuth token that may
 * need refreshing, and a refreshed token that must be persisted). Resolves to
 * undefined for any other provider; never throws.
 */
export async function readProviderAccountQuota(
  provider: Provider,
  opts: { signal?: AbortSignal | undefined; companions?: readonly Provider[] } = {},
): Promise<AccountQuotaRefreshResult | undefined> {
  if (provider instanceof SubscriptionOAuthProvider && provider.chatGPTQuotaClientId) {
    for (const companion of opts.companions ?? []) {
      if (!(companion instanceof OpenAICodexProvider)) continue;
      const snapshots = await companion.readChatGPTAccountQuota(
        provider.id,
        provider.chatGPTQuotaClientId,
        opts,
      );
      if (snapshots.length) return { vendor: 'chatgpt', ok: true };
    }
    return { vendor: 'chatgpt', ok: false };
  }
  if (!(provider instanceof OpenAICodexProvider)) return undefined;
  const snapshots = await provider.readAccountQuota({ signal: opts.signal });
  return { vendor: 'codex', ok: snapshots.length > 0 };
}

async function readPostTurnVendor(
  vendor: Exclude<AccountQuotaVendor, 'minimax' | 'zai' | 'codex' | 'chatgpt'>,
  providerId: string,
  url: string | undefined,
  input: AccountQuotaRefreshInput,
): Promise<number> {
  const common = { apiKey: input.apiKey, fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs };
  switch (vendor) {
    case 'kimi':
      return (await reportKimiCodeQuota(providerId, { ...common, host: kimiCodeHostOf(url) }))
        .length;
    case 'opencode':
      return (await reportOpenCodeQuota(providerId, common)).length;
    case 'openrouter':
      return (await reportOpenRouterQuota(providerId, common)).length;
    case 'omniroute': {
      const root = url ? omniRouteRoot(url) : undefined;
      if (!root || !input.managementToken) return 0;
      const read = await reportOmniRouteQuota(providerId, {
        managementToken: input.managementToken,
        root,
        fetchImpl: input.fetchImpl,
        timeoutMs: input.timeoutMs,
      });
      return read.length;
    }
    case 'custom':
      if (!input.quotaEndpoint) return 0;
      return (await reportCustomQuota(providerId, input.quotaEndpoint, { ...common, baseUrl: url }))
        .length;
    default: {
      const host = upstreamParts(url)?.host;
      const endpoint = host ? balanceEndpoint(vendor, host) : undefined;
      if (!endpoint) return 0;
      return (await reportBalanceQuota(providerId, endpoint, common)).length;
    }
  }
}

// ── Post-turn reads ─────────────────────────────────────────────────────────

/** An account is read at most this often after turns; a status call, but not free of latency. */
const POST_TURN_MIN_INTERVAL_MS = 60_000;

let postTurnReportingEnabled = false;
let chatGPTQuotaReporter: ((provider: Provider) => Promise<unknown>) | undefined;

export function setChatGPTQuotaReporter(
  reporter: ((provider: Provider) => Promise<unknown>) | undefined,
): void {
  chatGPTQuotaReporter = reporter;
}

/**
 * Turn on post-turn account reads for providers built from now on. Off by
 * default so a library consumer — or a test that builds a provider against a
 * fake transport — never makes an account call it did not ask for; hosts
 * (the CLI, the WebUI server) enable it when they install their persisters.
 */
export function setAccountQuotaReporting(enabled: boolean): void {
  postTurnReportingEnabled = enabled;
}

/**
 * After every completed call, read and record the plan quota or balance of a
 * provider whose transport cannot report it itself (Kimi Code, OpenCode Go,
 * OpenRouter, an OmniRoute pool, the prepaid balances, a configured
 * `quotaEndpoint`) — so the statusline chip and the quota panel stay current
 * the way they already do for Codex, MiniMax and Z.AI.
 *
 * The read is detached (a turn is never delayed or failed by it), throttled
 * per provider, and deduplicated while one is in flight. The provider object
 * is instrumented in place rather than wrapped: hosts overlay capabilities
 * onto the very object they were handed and some callers branch on
 * `instanceof`, both of which a wrapper would break. Returns the provider
 * unchanged for every other vendor, when reporting is off, or without the
 * credential its read needs.
 */
export function attachAccountQuotaReporting<P extends Provider>(
  provider: P,
  input: AccountQuotaRefreshInput,
): P {
  if (!postTurnReportingEnabled) return provider;
  const direct = provider instanceof SubscriptionOAuthProvider && !!provider.chatGPTQuotaClientId;
  const vendor = accountQuotaVendorOf(input);
  if (!direct && (vendor === undefined || !POST_TURN_VENDORS.has(vendor))) return provider;
  if (!direct && vendor !== undefined && !credentialOf(vendor, input)) return provider;

  let lastReadAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<unknown> | undefined;
  const schedule = (): void => {
    const now = Date.now();
    if (inFlight || now - lastReadAt < POST_TURN_MIN_INTERVAL_MS) return;
    lastReadAt = now;
    inFlight = (
      direct
        ? (chatGPTQuotaReporter?.(provider) ?? Promise.resolve())
        : refreshProviderAccountQuota(input)
    )
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
      });
  };

  const stream = provider.stream.bind(provider);
  const complete = provider.complete.bind(provider);
  // `finally`: a call refused for quota is exactly when a fresh reading matters.
  provider.stream = async function* (req, opts) {
    try {
      yield* stream(req, opts);
    } finally {
      schedule();
    }
  };
  provider.complete = async (req, opts) => {
    try {
      return await complete(req, opts);
    } finally {
      schedule();
    }
  };
  return provider;
}
