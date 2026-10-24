/**
 * Z.AI / BigModel (Zhipu) transport layer — what is specific to the vendor
 * beyond the wire, learned from the official ZCode client
 * (github.com/zai-org/ZCode):
 *
 * - **Plan quota.** The GLM Coding Plan's 5-hour / weekly windows and the
 *   monthly MCP tool-call pool are read from the account monitor API after
 *   completed turns (see zai-account.ts) and land in the neutral quota store,
 *   so the statusline chip, `/provider-quota` and the WebUI show them.
 * - **Business codes.** Z.AI reports the real cause in `error.code`; the HTTP
 *   status alone misfiles several of them. 1310 ("Weekly/Monthly Limit
 *   Exhausted") arrives as a 429 whose prose matches no quota wording, so it
 *   was retried as a burst rate limit. The table below is ZCode's
 *   (`failure-provider-business-codes.ts`, `chatErrorAttributionEvidence.ts`).
 * - **Reset time.** A plan-limit message says "Your limit will reset at
 *   2026-09-30 18:21:49" — platform time, UTC+8, with no zone. The generic
 *   parser can only guess between UTC and the machine's zone, which parks a
 *   model hours too long anywhere else. The quota endpoint's `nextResetTime`
 *   is exact; the stamp read as UTC+8 is the fallback.
 * - **Region-bound keys.** Z.AI (api.z.ai) and BigModel (open.bigmodel.cn) are
 *   separate accounts. A 401 is checked against the other one so the error
 *   can say where the key belongs.
 * - **Anthropic surface thinking.** On `/api/anthropic`, GLM takes ZCode's
 *   mapping (`config/provider/zcode-builtin.json`), not Anthropic's
 *   `budget_tokens` shape.
 *
 * @module zai
 */

import type {
  Capabilities,
  ImageGenerationRequest,
  ImageGenerationResult,
  Provider,
  ProviderContextLimit,
  ProviderErrorKind,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/contracts/types';
import { ProviderError } from '@wrongstack/contracts/types';
import { recordProviderQuota } from '@wrongstack/core/quota';
import { AnthropicProvider } from './anthropic.js';
import type { CompatibilityQuirks } from './compatibility-quirks.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { resolveProviderDefinition } from './provider-definitions.js';
import {
  fetchZaiPlanReport,
  isZaiCodingPlanEndpoint,
  reportZaiQuota,
  type ZaiPlanReport,
  type ZaiQuotaReading,
  type ZaiRegion,
  zaiKeyAuthorizesIn,
  zaiQuotaResetInMs,
  zaiQuotaSnapshots,
  zaiRegionOf,
} from './zai-account.js';

// The account shapes `/zai-plan` renders, re-exported so the package index
// names one Z.AI module.
export type { ZaiPlanReport, ZaiServiceHealth } from './zai-account.js';
export { zaiQuotaSnapshots } from './zai-account.js';

/** True when `url` reaches a Z.AI or BigModel host (proxied or not). */
export function isZaiHost(url: string | undefined): boolean {
  return zaiRegionOf(url) !== undefined;
}

/**
 * The OpenAI-compatible wire contract for a provider on a Z.AI / BigModel
 * host. Only the `zai*` presets carried the GLM request policy (GLM-5.3's
 * always-on thinking + `reasoning_effort` low|high|max, the 5.2 vocabulary,
 * the thinking toggle), so BigModel's catalog ids (`zhipuai`,
 * `zhipuai-coding-plan`) and hand-written aliases sent the generic effort
 * fill to the same GLM models. Both deployments serve one GLM API; a
 * provider whose definition brings its own policy keeps it.
 */
export function zaiWireContract(
  baseUrl: string | undefined,
  definitionId: string,
): { definitionId: string; quirks: CompatibilityQuirks } | undefined {
  if (!isZaiHost(baseUrl)) return undefined;
  if (resolveProviderDefinition(definitionId)?.requestPolicy !== undefined) return undefined;
  return { definitionId: 'zai', quirks: { thinkingParam: 'zai-glm' } };
}

/**
 * Minimum gap between two post-turn quota reads. The read is an account
 * endpoint and spends nothing, but an agent turn can be seconds long and a
 * 5-hour window does not move meaningfully between two of them.
 */
const QUOTA_REFRESH_INTERVAL_MS = 60_000;

/** How long a failing request may wait on the quota read that explains it. */
const QUOTA_ON_ERROR_TIMEOUT_MS = 5_000;

/** Z.AI's platform clock: the monitor API reports `timezone: Asia/Shanghai`. */
const PLATFORM_UTC_OFFSET = '+08:00';

const SUBSCRIPTION_PAGE: Record<ZaiRegion, string> = {
  zai: 'https://z.ai/manage-apikey/subscription',
  bigmodel: 'https://bigmodel.cn/coding-plan/personal/overview',
};

// ── Business codes ──────────────────────────────────────────────────────────

interface CodeRule {
  kind: ProviderErrorKind;
  retryable: boolean;
}

/**
 * Z.AI business codes whose meaning the HTTP status does not carry. Codes not
 * listed keep the status-based classification.
 */
const BUSINESS_CODES: Readonly<Record<string, CodeRule>> = {
  // Plan windows and caps: the route is spent until the window resets.
  '1304': { kind: 'quota_exhausted', retryable: false }, // daily call limit
  '1308': { kind: 'quota_exhausted', retryable: false }, // 5-hour window
  '1310': { kind: 'quota_exhausted', retryable: false }, // weekly / monthly window
  '1313': { kind: 'quota_exhausted', retryable: false }, // fair-use limit
  '1309': { kind: 'quota_exhausted', retryable: false }, // plan expired
  '1113': { kind: 'quota_exhausted', retryable: false }, // balance empty (metered)
  // Transient.
  '1302': { kind: 'rate_limit', retryable: true },
  '1303': { kind: 'rate_limit', retryable: true },
  '1305': { kind: 'rate_limit', retryable: true },
  '1312': { kind: 'overloaded', retryable: true },
  // Request-shaped.
  '1261': { kind: 'context_overflow', retryable: false },
};

/** Codes that spend a plan window — the ones the quota read can date. */
const WINDOW_CODES = new Set(['1304', '1308', '1310', '1313']);

/**
 * The business code of a Z.AI failure: `error.code` (parsed into `body.type`),
 * else the `[1308]…` bracket prefix Z.AI's SSE error chunks use.
 */
function zaiBusinessCode(err: ProviderError): string | undefined {
  const type = err.body?.type;
  if (type !== undefined && /^\d{4}$/.test(type)) return type;
  const text = err.body?.message ?? err.message;
  return /^\s*\[(\d{4})\]/.exec(text)?.[1];
}

/**
 * Milliseconds until the "reset at YYYY-MM-DD HH:mm:ss" stamp in a Z.AI
 * message, read in platform time (UTC+8). Undefined when there is no stamp or
 * it is already past.
 */
function zaiResetStampInMs(
  message: string | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!message) return undefined;
  const match =
    /reset(?:s)?\s+(?:at|on)\s+(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/i.exec(
      message,
    );
  if (!match) return undefined;
  const pad = (part: string | undefined) => (part ?? '0').padStart(2, '0');
  const iso = `${match[1]}-${pad(match[2])}-${pad(match[3])}T${pad(match[4])}:${match[5]}:${pad(match[6])}${PLATFORM_UTC_OFFSET}`;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const ms = at - now;
  return ms > 0 ? ms : undefined;
}

/** Model ids a 1311 "plan does not include this model" body lists as allowed. */
function allowedModelsFrom(err: ProviderError): string[] {
  const raw = err.body?.raw;
  if (!raw) return [];
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const error = (json['error'] ?? {}) as Record<string, unknown>;
    const list = json['allowed_models'] ?? error['allowed_models'];
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Rebuild `err` with a different classification and/or a patched body. Kept
 * in place (same object) when only the body changes and it is mutable, so the
 * original stack and subclass survive.
 */
function reshape(
  err: ProviderError,
  change: {
    kind?: CodeRule | undefined;
    retryAfterMs?: number | undefined;
    hint?: string | undefined;
  },
): ProviderError {
  const patch: { retryAfterMs?: number; message?: string } = {};
  if (change.retryAfterMs !== undefined) patch.retryAfterMs = change.retryAfterMs;
  if (change.hint !== undefined) {
    const base = err.body?.message;
    patch.message = base ? `${base} — ${change.hint}` : change.hint;
  }
  const rule = change.kind;
  if (rule === undefined || (rule.kind === err.kind && rule.retryable === err.retryable)) {
    if (Object.keys(patch).length === 0) return err;
    if (err.body && !Object.isFrozen(err.body)) {
      Object.assign(err.body, patch);
      return err;
    }
  }
  return new ProviderError(
    err.message,
    err.status,
    rule?.retryable ?? err.retryable,
    err.providerId,
    {
      body: { ...err.body, ...patch },
      kind: rule?.kind ?? err.kind,
      cause: err,
    },
  );
}

// ── Transport decorator ─────────────────────────────────────────────────────

export interface ZaiAccountPlaneOptions {
  apiKey: string;
  /** The configured base URL — possibly WrongProxy-mounted. */
  baseUrl: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /**
   * Read the plan quota after completed turns and on window failures. Defaults
   * to on for Coding Plan endpoints and off for the metered `/api/paas/v4`,
   * whose calls never draw on the plan.
   */
  quotaReporting?: boolean | undefined;
}

/** A live Z.AI / BigModel provider that can report its account. */
export interface ZaiAccountHandle {
  providerId: string;
  region: ZaiRegion;
  /** True when the endpoint draws on the Coding Plan (quota windows apply). */
  codingPlan: boolean;
  fetchReport(opts?: { days?: number | undefined }): Promise<ZaiPlanReport>;
}

/**
 * Providers built this process, by id — what `/zai-plan` reports on. The last
 * build of an id wins; a rebuilt provider carries the same key or a newer one.
 */
const liveAccounts = new Map<string, ZaiAccountHandle>();

/** Every Z.AI / BigModel provider built in this process. */
export function listZaiAccounts(): readonly ZaiAccountHandle[] {
  return [...liveAccounts.values()];
}

/**
 * Wraps any transport that talks to Z.AI or BigModel — the OpenAI-compatible
 * Coding Plan endpoint, the Anthropic-compatible one, a custom alias — with
 * the account plane. The wire itself is untouched.
 */
export class ZaiAccountProvider implements Provider {
  readonly id: string;
  capabilities: Capabilities;
  readonly refreshContextLimit?: NonNullable<Provider['refreshContextLimit']>;
  readonly warm?: NonNullable<Provider['warm']>;
  readonly generateImage?: NonNullable<Provider['generateImage']>;

  private readonly region: ZaiRegion;
  private readonly quotaReporting: boolean;
  private quotaInFlight: Promise<ZaiQuotaReading | undefined> | undefined;
  private lastQuotaReportAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly inner: Provider,
    region: ZaiRegion,
    private readonly opts: ZaiAccountPlaneOptions,
  ) {
    this.id = inner.id;
    this.capabilities = inner.capabilities;
    this.region = region;
    const codingPlan = isZaiCodingPlanEndpoint(opts.baseUrl);
    this.quotaReporting = (opts.quotaReporting ?? true) && codingPlan;
    // Optional members stay optional: their presence is how callers detect
    // the capability (an image API, a live context probe).
    if (inner.refreshContextLimit) {
      this.refreshContextLimit = (model: string, o: { signal: AbortSignal }) => {
        this.syncCapabilities();
        return inner.refreshContextLimit?.(model, o) as Promise<ProviderContextLimit | undefined>;
      };
    }
    if (inner.warm) this.warm = (model: string) => inner.warm?.(model) ?? Promise.resolve();
    if (inner.generateImage) {
      this.generateImage = (req: ImageGenerationRequest, o: { signal: AbortSignal }) =>
        inner.generateImage?.(req, o) as Promise<ImageGenerationResult>;
    }
    liveAccounts.set(this.id, {
      providerId: this.id,
      region,
      codingPlan,
      fetchReport: async (o) => {
        const report = await fetchZaiPlanReport({
          apiKey: opts.apiKey,
          region,
          fetchImpl: opts.fetchImpl,
          days: o?.days,
        });
        // A report is a fresh reading too: the chip should not lag behind it.
        if (codingPlan && report.quota) {
          recordProviderQuota(this.id, zaiQuotaSnapshots(this.id, report.quota));
        }
        return report;
      },
    });
  }

  async *stream(req: Request, o: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    this.syncCapabilities();
    try {
      yield* this.inner.stream(req, o);
    } catch (err) {
      throw await this.explainFailure(err);
    }
    void this.refreshQuota(false);
  }

  async complete(req: Request, o: { signal: AbortSignal }): Promise<Response> {
    this.syncCapabilities();
    let res: Response;
    try {
      res = await this.inner.complete(req, o);
    } catch (err) {
      throw await this.explainFailure(err);
    }
    void this.refreshQuota(false);
    return res;
  }

  /**
   * The host overlays catalog capabilities (context window, output cap) onto
   * the object it was handed — this one. The inner transport builds bodies
   * from ITS capabilities, so the overlay is carried down before every call.
   */
  private syncCapabilities(): void {
    if (this.inner.capabilities === this.capabilities) return;
    Object.defineProperty(this.inner, 'capabilities', {
      value: this.capabilities,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  private refreshQuota(force: boolean, timeoutMs?: number): Promise<ZaiQuotaReading | undefined> {
    if (!this.quotaReporting) return Promise.resolve(undefined);
    if (this.quotaInFlight) return this.quotaInFlight;
    const now = Date.now();
    if (!force && now - this.lastQuotaReportAt < QUOTA_REFRESH_INTERVAL_MS) {
      return Promise.resolve(undefined);
    }
    this.lastQuotaReportAt = now;
    const pending = reportZaiQuota(this.id, {
      apiKey: this.opts.apiKey,
      region: this.region,
      fetchImpl: this.opts.fetchImpl,
      timeoutMs,
    }).finally(() => {
      if (this.quotaInFlight === pending) this.quotaInFlight = undefined;
    });
    this.quotaInFlight = pending;
    return pending;
  }

  /**
   * Add what only Z.AI's codes and account API can tell us to a failure.
   * Never throws and never loses the provider's own message; anything it
   * cannot learn leaves the error as it was.
   */
  private async explainFailure(err: unknown): Promise<unknown> {
    if (!ProviderError.isProviderError(err)) return err;
    try {
      const code = zaiBusinessCode(err);
      const rule = code !== undefined ? BUSINESS_CODES[code] : undefined;

      if (code !== undefined && WINDOW_CODES.has(code)) {
        // The generic parser already turned the prose stamp into a guess;
        // replace it with the exact reset, or the stamp read in platform time.
        const reading = await this.refreshQuota(true, QUOTA_ON_ERROR_TIMEOUT_MS);
        const retryAfterMs =
          zaiQuotaResetInMs(reading) ?? zaiResetStampInMs(err.body?.message ?? err.message);
        return reshape(err, { kind: rule, retryAfterMs });
      }
      if (code === '1309') {
        return reshape(err, {
          kind: rule,
          hint: `the Coding Plan has expired; renew it at ${SUBSCRIPTION_PAGE[this.region]}`,
        });
      }
      if (code === '1311') {
        const allowed = allowedModelsFrom(err);
        return reshape(err, {
          hint:
            allowed.length > 0
              ? `this plan includes: ${allowed.join(', ')}`
              : `this model is not part of the current plan (${SUBSCRIPTION_PAGE[this.region]})`,
        });
      }
      if (rule !== undefined) return reshape(err, { kind: rule });

      if (err.kind === 'auth' && err.status === 401) {
        const other: ZaiRegion = this.region === 'zai' ? 'bigmodel' : 'zai';
        if (await zaiKeyAuthorizesIn(other, this.opts.apiKey, { fetchImpl: this.opts.fetchImpl })) {
          const hint =
            other === 'bigmodel'
              ? 'this key belongs to BigModel (open.bigmodel.cn): use the zhipuai / zhipuai-coding-plan provider or that base URL'
              : 'this key belongs to Z.AI (api.z.ai): use the zai / zai-coding-plan provider or that base URL';
          return reshape(err, { hint });
        }
      }
    } catch {
      // Explaining a failure must never replace it with a different one.
    }
    return err;
  }
}

/**
 * `provider` wrapped with the Z.AI account plane when `baseUrl` reaches a
 * Z.AI / BigModel host; `provider` itself otherwise.
 */
export function withZaiAccountPlane(provider: Provider, opts: ZaiAccountPlaneOptions): Provider {
  const region = zaiRegionOf(opts.baseUrl);
  if (region === undefined) return provider;
  return new ZaiAccountProvider(provider, region, opts);
}

// ── Anthropic surface ───────────────────────────────────────────────────────

type ZaiThinkingControl = 'effort' | 'toggle-effort' | 'toggle';

/**
 * How a GLM model's thinking is steered on Z.AI's Anthropic-compatible
 * endpoint (ZCode `zcode-builtin.json`, `modelApiRules` for
 * `anthropic-messages`):
 *
 * - `effort` (GLM-5.3, -Flash): always thinks; `thinking: {type: 'enabled'}`
 *   plus `output_config.effort` ∈ low | high | max. No "off".
 * - `toggle-effort` (GLM-5.2): `disabled`, or `enabled` + effort high | max.
 * - `toggle` (GLM-5.x, 5-Turbo, 4.7, …): `enabled` | `disabled`, no depth.
 */
function zaiThinkingControl(model: string): ZaiThinkingControl {
  const id = model.toLowerCase();
  if (/glm-5\.3/.test(id)) return 'effort';
  if (/glm-5\.2/.test(id)) return 'toggle-effort';
  return 'toggle';
}

function applyZaiAnthropicReasoning(
  body: Record<string, unknown>,
  model: string,
  reasoning: Request['reasoning'],
): void {
  delete body['thinking'];
  delete body['output_config'];
  if (!reasoning) return;
  const off = reasoning.enabled === false || reasoning.effort === 'none';
  const effort = reasoning.effort;
  switch (zaiThinkingControl(model)) {
    case 'effort': {
      // Cannot be switched off: "less thinking" lands on the shallowest level.
      const level =
        off || effort === 'minimal' || effort === 'low'
          ? 'low'
          : effort === 'medium' || effort === 'high'
            ? 'high'
            : 'max';
      body['thinking'] = { type: 'enabled' };
      body['output_config'] = { effort: level };
      return;
    }
    case 'toggle-effort':
      if (off) {
        body['thinking'] = { type: 'disabled' };
        return;
      }
      body['thinking'] = { type: 'enabled' };
      body['output_config'] = { effort: effort === 'xhigh' || effort === 'max' ? 'max' : 'high' };
      return;
    case 'toggle':
      if (off) body['thinking'] = { type: 'disabled' };
      else if (reasoning.enabled === true || effort !== undefined)
        body['thinking'] = { type: 'enabled' };
      return;
  }
}

/** Anthropic-compatible transport for Z.AI / BigModel `/api/anthropic`. */
export class ZaiMessagesProvider extends AnthropicProvider {
  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    // Build without the canonical reasoning control: the Anthropic preset
    // emits `thinking: {type: 'enabled', budget_tokens}` and strips sampling
    // params for it — neither is Z.AI's contract.
    const body = super.buildBody({ ...req, reasoning: undefined }, ctx);
    applyZaiAnthropicReasoning(body, req.model, req.reasoning);
    return body;
  }
}
