import {
  type Capabilities,
  type Provider,
  ProviderError,
  type Request,
  type Response,
  type StreamEvent,
} from '@wrongstack/contracts/types';
import type { ProviderQuotaSnapshot } from '@wrongstack/core/quota';
import { AnthropicProvider } from './anthropic.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import {
  miniMaxKeyAuthorizesAt,
  miniMaxQuotaResetInMs,
  reportMiniMaxQuota,
} from './minimax-quota.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { upstreamHost, upstreamUrl } from './proxy-upstream.js';

const INTERNATIONAL_ROOT = 'https://api.minimax.io';
const CHINA_ROOT = 'https://api.minimax.cn';
const DEFAULT_ROOT = INTERNATIONAL_ROOT;

/** Domains MiniMax serves its API from. `minimaxi.*` are the older China/intl names. */
const MINIMAX_DOMAINS = ['minimax.io', 'minimax.cn', 'minimaxi.com', 'minimaxi.chat'] as const;
const CHINA_DOMAINS = new Set(['minimax.cn', 'minimaxi.com']);

/**
 * Minimum gap between two post-turn quota reads. The read is an account
 * endpoint and spends no allowance, but an agent turn can be seconds long and
 * a plan's 5-hour window does not move meaningfully between two of them.
 */
const QUOTA_REFRESH_INTERVAL_MS = 60_000;

/** How long a failing request may wait on the quota read that explains it. */
const QUOTA_ON_ERROR_TIMEOUT_MS = 5_000;

export interface MiniMaxProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  id?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
  /**
   * Read the Token Plan quota (or pay-as-you-go balance) after completed turns
   * and on quota failures. Defaults to on for MiniMax's own hosts and off for
   * anything else — a proxy fronting the chat API need not serve the account
   * endpoints, and probing one with the user's key is not ours to decide.
   */
  quotaReporting?: boolean | undefined;
}

/**
 * The MiniMax domain `url` finally reaches — seen through the WrongProxy
 * rewrite (`<proxy>/proxy/api.minimax.io/…`), which would otherwise hide the
 * vendor behind `localhost` and switch the MiniMax transport off whenever
 * tracing is on.
 */
function miniMaxDomainOf(url: string | undefined): string | undefined {
  const host = upstreamHost(url);
  if (host === undefined) return undefined;
  return MINIMAX_DOMAINS.find((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** True when `url` reaches one of MiniMax's own API hosts (either region), proxied or not. */
export function isMiniMaxHost(url: string | undefined): boolean {
  return miniMaxDomainOf(url) !== undefined;
}

/**
 * True for the catalog's MiniMax provider ids — `minimax`, `minimax-coding-plan`,
 * `minimax-cn`, `minimax-cn-coding-plan` — and any future `minimax-*` sibling.
 */
export function isMiniMaxProviderId(id: string | undefined): boolean {
  return id !== undefined && /^minimax(?:-|$)/i.test(id);
}

/**
 * The other region's root for a MiniMax root, or undefined for a non-MiniMax
 * host. MiniMax keys are region-bound, so this is where a key that was
 * rejected here would have worked.
 */
function alternateRegionRoot(root: string): string | undefined {
  const domain = miniMaxDomainOf(root);
  if (domain === undefined) return undefined;
  return CHINA_DOMAINS.has(domain) ? INTERNATIONAL_ROOT : CHINA_ROOT;
}

/**
 * Direct MiniMax transport. M-series models (M2.x, M3, M3.1 and any future
 * m{n} release) are routed through MiniMax's recommended Anthropic-compatible
 * interface so interleaved thinking/tool blocks retain their native structure
 * and prompt-cache usage (cache_read_input_tokens / cache_creation_input_tokens)
 * is reported on the `message_start` event. Models outside the M series keep
 * the OpenAI fallback.
 *
 * Beside the wire, this owns what is MiniMax-specific about the account: the
 * Token Plan quota (read after turns, and on a quota failure to learn the real
 * reset) and the region binding of keys (a 401 is checked against the other
 * region so the error can say which host the key belongs to).
 */
export class MiniMaxProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities = capabilitiesForFamily('openai-compatible', {
    reasoning: true,
    tools: true,
  });

  private readonly chat: OpenAICompatibleProvider;
  private readonly messages: MiniMaxMessagesProvider;
  private readonly apiKey: string;
  /**
   * The un-proxied MiniMax root for account reads (quota, region probe). Chat
   * traffic keeps the configured — possibly proxy-mounted — root; account
   * reads are not model traffic, so they skip the trace proxy and go straight
   * to the vendor.
   */
  private readonly accountRoot: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly quotaReporting: boolean;
  private quotaInFlight: Promise<ProviderQuotaSnapshot[]> | undefined;
  private lastQuotaReportAt = Number.NEGATIVE_INFINITY;

  constructor(opts: MiniMaxProviderOptions) {
    this.id = opts.id ?? 'minimax';
    const root = minimaxRoot(opts.baseUrl);
    this.apiKey = opts.apiKey;
    this.accountRoot = miniMaxAccountRoot(opts.baseUrl);
    this.fetchImpl = opts.fetchImpl;
    this.quotaReporting = (opts.quotaReporting ?? true) && isMiniMaxHost(this.accountRoot);
    this.chat = new OpenAICompatibleProvider({
      id: this.id,
      apiKey: opts.apiKey,
      baseUrl: `${root}/v1`,
      headers: opts.headers,
      fetchImpl: opts.fetchImpl,
      quirks: { stripThinkTags: true },
    });
    this.messages = new MiniMaxMessagesProvider({
      id: this.id,
      apiKey: opts.apiKey,
      baseUrl: `${root}/anthropic`,
      headers: opts.headers,
      fetchImpl: opts.fetchImpl,
    });
  }

  async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    const provider = isMiniMaxMessagesModel(req.model) ? this.messages : this.chat;
    this.syncCapabilities(provider);
    try {
      yield* provider.stream(req, opts);
    } catch (err) {
      throw await this.explainFailure(err);
    }
    this.scheduleQuotaReport();
  }

  async warm(model: string): Promise<void> {
    await (isMiniMaxMessagesModel(model) ? this.messages : this.chat).warm?.(model);
  }

  async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    const provider = isMiniMaxMessagesModel(req.model) ? this.messages : this.chat;
    this.syncCapabilities(provider);
    let res: Response;
    try {
      res = await provider.complete(req, opts);
    } catch (err) {
      throw await this.explainFailure(err);
    }
    this.scheduleQuotaReport();
    return res;
  }

  private syncCapabilities(provider: Provider): void {
    Object.defineProperty(provider, 'capabilities', {
      value: this.capabilities,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  /**
   * Read the plan quota after a completed turn.
   *
   * Detached and never awaited: the turn is already delivered, and a status
   * reading must not be able to delay or fail it.
   */
  private scheduleQuotaReport(): void {
    void this.refreshQuota(false);
  }

  private refreshQuota(force: boolean, timeoutMs?: number): Promise<ProviderQuotaSnapshot[]> {
    if (!this.quotaReporting) return Promise.resolve([]);
    if (this.quotaInFlight) return this.quotaInFlight;
    const now = Date.now();
    if (!force && now - this.lastQuotaReportAt < QUOTA_REFRESH_INTERVAL_MS) {
      return Promise.resolve([]);
    }
    this.lastQuotaReportAt = now;
    const pending = reportMiniMaxQuota(this.id, {
      apiKey: this.apiKey,
      root: this.accountRoot,
      fetchImpl: this.fetchImpl,
      timeoutMs,
    }).finally(() => {
      if (this.quotaInFlight === pending) this.quotaInFlight = undefined;
    });
    this.quotaInFlight = pending;
    return pending;
  }

  /**
   * Add what only MiniMax's account endpoints can tell us to a failure.
   *
   * - Plan exhausted: MiniMax's `usage limit exceeded (2056)` says only "wait
   *   for the next 5-hour window". The quota endpoint knows the exact reset,
   *   and a structured `retryAfterMs` is what lets the waiting room hold the
   *   model until then instead of probing it on the fixed default block.
   * - Key rejected: keys are bound to the region that issued them. When the
   *   other region accepts the same key, the error says so.
   *
   * Never throws and never replaces the provider's own hint; anything it
   * cannot learn leaves the error exactly as it was.
   */
  private async explainFailure(err: unknown): Promise<unknown> {
    if (!ProviderError.isProviderError(err)) return err;
    try {
      if (
        err.kind === 'quota_exhausted' &&
        !(err.body?.retryAfterMs && err.body.retryAfterMs > 0)
      ) {
        const snapshots = await this.refreshQuota(true, QUOTA_ON_ERROR_TIMEOUT_MS);
        const resetMs = miniMaxQuotaResetInMs(snapshots);
        if (resetMs !== undefined) return withBodyPatch(err, { retryAfterMs: resetMs });
        return err;
      }
      if (err.kind === 'auth' && (err.status === 401 || err.status === 403)) {
        const alternate = alternateRegionRoot(this.accountRoot);
        if (
          alternate !== undefined &&
          (await miniMaxKeyAuthorizesAt(alternate, this.apiKey, { fetchImpl: this.fetchImpl }))
        ) {
          const china = alternate === CHINA_ROOT;
          const hint =
            `This key belongs to MiniMax's ${china ? 'China' : 'international'} region: ` +
            `set the provider base URL to ${alternate}` +
            (china ? ' (or use the minimax-cn / minimax-cn-coding-plan provider).' : '.');
          const message = err.body?.message ? `${err.body.message} — ${hint}` : hint;
          return withBodyPatch(err, { message });
        }
      }
    } catch {
      // Explaining a failure must never replace it with a different one.
    }
    return err;
  }
}

/**
 * Patch a ProviderError's body in place when it is mutable, else rebuild the
 * error around a patched copy. In place keeps the original stack and subclass.
 */
function withBodyPatch(
  err: ProviderError,
  patch: { retryAfterMs?: number; message?: string },
): ProviderError {
  if (err.body && !Object.isFrozen(err.body)) {
    Object.assign(err.body, patch);
    return err;
  }
  return new ProviderError(err.message, err.status, err.retryable, err.providerId, {
    body: { ...err.body, ...patch },
    kind: err.kind,
    cause: err,
  });
}

class MiniMaxMessagesProvider extends AnthropicProvider {
  private readonly extraHeaders?: Record<string, string> | undefined;

  constructor(opts: MiniMaxProviderOptions & { baseUrl?: string }) {
    super({
      // Forward `id` so the Anthropic surface preserves the user-visible
      // provider id (e.g. 'minimax-coding-plan') instead of falling through
      // to anthropicWireFormat.id ('anthropic'). Without this, every error
      // attribution and `resolveMaxOutputTokens(ctx.providerId, req.model)`
      // catalog lookup on the messages path is misattributed to 'anthropic',
      // which silently misses the MiniMax catalog row.
      id: opts.id,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
    });
    this.extraHeaders = opts.headers;
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    // Forward caller-supplied headers (proxy auth, tenant ids, routing keys),
    // strip any caller keys whose lowercase form matches a protected Anthropic
    // header (auth / version / content-type / accept) — HTTP header names are
    // case-insensitive, so a literal `delete headers['x-api-key']` would miss
    // caller keys like `X-Api-Key` or `x-API-key`. Then write the
    // provider-controlled headers last so they win over any caller values.
    // This provider hardcodes `x-api-key` regardless of host, so the protected
    // set is broader than AnthropicProvider's host-conditional choice.
    //
    // M3 now travels this surface after the routing fix; without this merge
    // any custom headers passed via MiniMaxProviderOptions.headers would be
    // silently dropped on M3.
    const PROTECTED = new Set([
      'x-api-key',
      'authorization',
      'anthropic-version',
      'content-type',
      'accept',
    ]);
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.extraHeaders ?? {})) {
      if (!PROTECTED.has(key.toLowerCase())) filtered[key] = value;
    }
    return {
      ...filtered,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'x-api-key': this.apiKey,
    };
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    // Build without the canonical reasoning control: the Anthropic preset
    // would emit `thinking: { type: 'enabled', budget_tokens }`, a shape
    // MiniMax does not accept (its enum is `disabled | adaptive`). The
    // MiniMax-native mapping below replaces it.
    const body = super.buildBody({ ...req, reasoning: undefined }, ctx);
    applyMiniMaxReasoning(body, req.model, req.reasoning);
    stripCacheTtl(body);
    return body;
  }
}

/**
 * How a MiniMax model's thinking can be steered on the Anthropic surface
 * (platform.minimax.io — Messages API, `thinking` / `output_config`):
 *
 * - `tunable` (M3.1+): always thinks. `thinking.type` may only be `adaptive`
 *   (`disabled` is an HTTP 400); depth is `output_config.effort`
 *   (`low|medium|high|xhigh|max`, default `max`; `none` is an HTTP 400).
 * - `toggle` (M3): thinking is OFF unless `thinking: { type: 'adaptive' }` is
 *   sent. Effort is ignored.
 * - `fixed` (M2.x, and any model not documented above): thinks always and
 *   takes no control — nothing is sent.
 */
type MiniMaxThinkingControl = 'tunable' | 'toggle' | 'fixed';

function miniMaxThinkingControl(model: string): MiniMaxThinkingControl {
  const id = model.toLowerCase();
  if (/^minimax-m3\.[1-9]/.test(id)) return 'tunable';
  if (/^minimax-m3(?:$|-)/.test(id)) return 'toggle';
  return 'fixed';
}

const MINIMAX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Map the canonical reasoning request onto MiniMax's `thinking` / `output_config`. */
function applyMiniMaxReasoning(
  body: Record<string, unknown>,
  model: string,
  reasoning: Request['reasoning'],
): void {
  delete body['thinking'];
  delete body['output_config'];
  if (!reasoning) return;
  const control = miniMaxThinkingControl(model);
  if (control === 'toggle') {
    const off = reasoning.enabled === false || reasoning.effort === 'none';
    // An effort-only request means "think at this level" (the same reading the
    // Anthropic preset applies); M3 has no depth control, so it just turns on.
    if (!off && (reasoning.enabled === true || reasoning.effort !== undefined)) {
      body['thinking'] = { type: 'adaptive' };
    }
    return;
  }
  if (control === 'tunable') {
    // Thinking cannot be switched off and `none`/`minimal` are rejected, so a
    // request for less thinking lands on the shallowest level that exists.
    const effort =
      reasoning.enabled === false || reasoning.effort === 'none' || reasoning.effort === 'minimal'
        ? 'low'
        : reasoning.effort;
    if (effort !== undefined && MINIMAX_EFFORTS.has(effort)) {
      body['output_config'] = { effort };
    }
  }
}

function hasCacheTtl(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const cc = (value as Record<string, unknown>)['cache_control'];
  return typeof cc === 'object' && cc !== null && 'ttl' in cc;
}

function withoutTtl(block: Record<string, unknown>): Record<string, unknown> {
  return { ...block, cache_control: { type: 'ephemeral' } };
}

/**
 * MiniMax's cache entries live exactly 5 minutes (refreshed on every hit) and
 * its `cache_control` schema has no `ttl`. The configured `1h` TTL the
 * Anthropic preset stamps on the deepest breakpoint is dropped rather than
 * sent as a promise the server does not keep. Copies are made at array level —
 * wire blocks may share frozen objects with the conversation history.
 */
function stripCacheTtl(body: Record<string, unknown>): void {
  for (const key of ['system', 'tools'] as const) {
    const list = body[key];
    if (Array.isArray(list) && list.some(hasCacheTtl)) {
      body[key] = list.map((b) => (hasCacheTtl(b) ? withoutTtl(b) : b));
    }
  }
  const messages = body['messages'];
  if (!Array.isArray(messages)) return;
  body['messages'] = messages.map((m: unknown) => {
    if (typeof m !== 'object' || m === null) return m;
    const content = (m as Record<string, unknown>)['content'];
    if (!Array.isArray(content) || !content.some(hasCacheTtl)) return m;
    return {
      ...(m as Record<string, unknown>),
      content: content.map((b) => (hasCacheTtl(b) ? withoutTtl(b) : b)),
    };
  });
}

function isMiniMaxMessagesModel(model: string): boolean {
  // M-series (M2.x and M3, plus any future m{n} releases) go through
  // MiniMax's Anthropic-compatible surface. Models outside the m-series
  // family keep the OpenAI-compatible fallback.
  return /^minimax-m\d/i.test(model);
}

/**
 * The un-proxied MiniMax API root for account reads (quota, balance) of a
 * configured base URL — `…/anthropic/v1`, `…/v1` and a WrongProxy mount all
 * reduce to `https://api.minimax.{io,cn}`. Same root the transport reads from.
 */
export function miniMaxAccountRoot(baseUrl: string | undefined): string {
  return minimaxRoot(upstreamUrl(minimaxRoot(baseUrl)));
}

function minimaxRoot(baseUrl: string | undefined): string {
  const raw = (baseUrl?.trim() || DEFAULT_ROOT).replace(/\/+$/, '');
  return raw.replace(/\/(?:anthropic(?:\/v1)?|v1)$/i, '');
}
