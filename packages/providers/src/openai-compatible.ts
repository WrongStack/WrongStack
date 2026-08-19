import type { Capabilities, ReasoningEffort, Request } from '@wrongstack/core/types';
import type { CompatibilityQuirks } from './compatibility-quirks.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { OpenAIProvider } from './openai.js';
import { applyOpenAICompatiblePolicy } from './openai-compatible-policy.js';
import { resolveProviderDefinition } from './provider-definitions.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';

export type { CompatibilityQuirks } from './compatibility-quirks.js';

const VALID_QUIRK_KEYS = new Set<keyof CompatibilityQuirks>([
  'stripCacheControl',
  'systemAsMessage',
  'flattenContentToString',
  'preserveToolCallIds',
  'parallelToolsDisabled',
  'emptyToolCallContent',
  'thinkingParam',
  'stripThinkTags',
  'maxTools',
  'tolerateMissingTerminalMarker',
]);

export function isCompatibilityQuirks(value: unknown): value is CompatibilityQuirks {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const obj = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(obj)) {
    if (!VALID_QUIRK_KEYS.has(key as keyof CompatibilityQuirks)) return false;
    if (key === 'emptyToolCallContent') {
      if (v !== 'null' && v !== 'empty_string') return false;
    } else if (key === 'thinkingParam') {
      if (v !== 'zai-glm' && v !== 'kimi-toggle' && v !== 'always-on') return false;
    } else if (key === 'maxTools') {
      if (typeof v !== 'number' || v < 1 || !Number.isInteger(v)) return false;
    } else if (typeof v !== 'boolean') {
      return false;
    }
  }
  return true;
}

export interface OpenAICompatibleOptions {
  id: string;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
  quirks?: CompatibilityQuirks | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  fetchImpl?: typeof fetch | undefined;
  /**
   * Optional override for URL construction. Receives the base URL and request,
   * returns the full URL to use. Allows custom providers with non-standard
   * URL structures (e.g. Google with model-in-path, Anthropic with /v1/messages).
   */
  urlOverride?: ((baseUrl: string, req: Request) => string) | undefined;
  /** Raw stream debugging and hang-detection options. */
  streamOpts?: WireAdapterStreamOptions | undefined;
}

export class OpenAICompatibleProvider extends OpenAIProvider {
  private readonly extraHeaders?: Record<string, string> | undefined;
  private readonly urlOverride?: ((baseUrl: string, req: Request) => string) | undefined;

  constructor(opts: OpenAICompatibleOptions) {
    super({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      id: opts.id,
      capabilities: capabilitiesForFamily('openai-compatible', {
        parallelTools: !opts.quirks?.parallelToolsDisabled,
        systemPrompt: !opts.quirks?.systemAsMessage,
        ...opts.capabilities,
      }),
      quirks: opts.quirks,
      streamOpts: opts.streamOpts,
    });
    this.extraHeaders = opts.headers;
    this.urlOverride = opts.urlOverride;
  }

  protected override buildUrl(req: Request): string {
    if (this.urlOverride) {
      return this.urlOverride(this.baseUrl, req);
    }
    return super.buildUrl(req);
  }

  /**
   * Compatible endpoints (Groq, Together, Mistral, local servers, …) follow the
   * classic Chat Completions contract and accept `max_tokens`; many reject
   * OpenAI's newer `max_completion_tokens`. Keep the legacy field here. See #10.
   */
  protected override tokenLimitParam(): string {
    return 'max_tokens';
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    const body = super.buildBody(req, ctx);
    applyThinkingParams(body, req, this.opts.quirks?.thinkingParam);
    // #14: the base builder only emits `reasoning_effort` for the values real
    // OpenAI accepts (none/low/medium/high); the broader internal levels —
    // `minimal`, `xhigh`, `max` — were silently dropped, so picking `max` on a
    // generic compatible model (MiniMax, DeepSeek, …) sent no effort at all.
    applyGenericReasoningEffort(body, req, this.opts.quirks?.thinkingParam);
    // Many OpenAI-compatible servers (Together, Fireworks, DeepSeek, etc.)
    // accept the `top_k` parameter even though real OpenAI rejects it.
    if (req.topK !== undefined) body['top_k'] = req.topK;
    applyOpenAICompatiblePolicy(body, req, this.id);
    // Conservative gateway guard, applied AFTER the generic fill so it
    // suppresses uniformly (see suppressEffortForGatewayTools). Providers with
    // a requestPolicy own their effort contract, and the zai-glm quirk writes
    // a deliberate mapping — both are exempt.
    suppressEffortForGatewayTools(body, req, this.id, this.opts.quirks?.thinkingParam);
    return body;
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    // Forward caller-supplied headers (proxy auth, tenant ids, routing keys),
    // strip any caller keys whose lowercase form matches a protected OpenAI
    // header (`authorization`, `content-type`, `accept`) — HTTP header names
    // are case-insensitive, so a literal spread order would let caller
    // `Authorization` / `Content-Type` / `Accept` override the provider's.
    // Then spread `super.buildHeaders(req)` last so the provider's headers
    // always win.
    const PROTECTED = new Set(['authorization', 'content-type', 'accept']);
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.extraHeaders ?? {})) {
      if (!PROTECTED.has(key.toLowerCase())) filtered[key] = value;
    }
    return { ...filtered, ...super.buildHeaders(req) };
  }
}

function applyThinkingParams(
  body: Record<string, unknown>,
  req: Request,
  mode: CompatibilityQuirks['thinkingParam'],
): void {
  if (!mode || !req.reasoning) return;
  if (mode === 'always-on') {
    // Models such as kimi-k2.7-code reject explicit disabled thinking.
    return;
  }
  if (req.reasoning.enabled === false) {
    body['thinking'] = { type: 'disabled' };
    return;
  }
  if (mode === 'kimi-toggle' && req.reasoning.enabled === true) {
    body['thinking'] = { type: 'enabled' };
  }
  if (mode === 'zai-glm' && req.reasoning.effort) {
    body['reasoning_effort'] = mapZaiReasoningEffort(req.reasoning.effort);
  }
}

function mapZaiReasoningEffort(
  effort: NonNullable<Request['reasoning']>['effort'],
): string | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
      return 'none';
    case 'low':
    case 'medium':
      return 'high';
    case 'xhigh':
      return 'max';
    default:
      return effort;
  }
}

/**
 * Fill in the reasoning effort levels the base OpenAI body builder drops (#14).
 * It emits `reasoning_effort` only for none/low/medium/high; `minimal`, `xhigh`,
 * and `max` fall through and never reach the wire. Map those onto the accepted
 * `low | high` extremes and set them — but never override a value the base or a
 * more specific quirk (`zai-glm`) already wrote, and never when reasoning was
 * explicitly disabled.
 *
 * No policy-ownership skip: request policies run AFTER this fill and each
 * begins by deleting the field, so a provider whose policy handles effort only
 * for SOME models (DeepSeek: v4 only; everything else keeps the generic
 * contract) still gets the generic fill for the rest.
 *
 * No tools gate: the base builder no longer suppresses effort when tools are
 * present, so the mapping is uniform for tool-carrying and tool-free requests
 * alike. The old behavior was inverted under tools — low/medium/high/none were
 * dropped while minimal/xhigh/max survived as mapped extremes — exactly
 * backwards from user intent.
 */
function applyGenericReasoningEffort(
  body: Record<string, unknown>,
  req: Request,
  mode: CompatibilityQuirks['thinkingParam'],
): void {
  if (mode === 'zai-glm') return; // already mapped effort → reasoning_effort
  const effort = req.reasoning?.effort;
  if (!effort) return;
  if (req.reasoning?.enabled === false) return;
  if (body['reasoning_effort'] !== undefined) return;
  const mapped = mapGenericReasoningEffort(effort);
  if (mapped) body['reasoning_effort'] = mapped;
}

/**
 * Collapse the internal levels the base builder rejects onto the values OpenAI's
 * `reasoning_effort` accepts. none/low/medium/high are already handled upstream,
 * so they return undefined here (no double-write).
 */
function mapGenericReasoningEffort(effort: ReasoningEffort): 'low' | 'high' | undefined {
  switch (effort) {
    case 'minimal':
      return 'low';
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

/**
 * Conservative gateway guard for GENERIC openai-compatible endpoints only.
 *
 * Observed behavior of a subset of Chat Completions gateways (some LiteLLM /
 * omniroute deployments): they reject `reasoning_effort` whenever function
 * tools are present, regardless of value — presence itself is validated
 * before the value. OpenAI's first-party endpoint has no such restriction
 * (effort works with tool use per its docs), which is why this guard lives
 * here and not in the shared base builder.
 *
 * Runs AFTER `applyGenericReasoningEffort` and AFTER the request policy so
 * suppression is uniform: with tools present, EVERY effort level is dropped —
 * not just the ones the base builder emits (the old behavior was inverted:
 * low/medium/high/none were dropped while minimal/xhigh/max survived as
 * mapped `low`/`high` extremes). Providers with a `requestPolicy` own their
 * effort contract and are exempt; the policy either deleted the field
 * already or wrote a value their public API accepts. The `zai-glm` quirk is
 * exempt too: `applyThinkingParams` wrote a deliberate Z.AI-contract mapping
 * that this guard must not undo.
 */
function suppressEffortForGatewayTools(
  body: Record<string, unknown>,
  req: Request,
  providerId: string,
  thinkingParam: CompatibilityQuirks['thinkingParam'],
): void {
  if (!req.tools || req.tools.length === 0) return;
  if (thinkingParam === 'zai-glm') return;
  if (resolveProviderDefinition(providerId)?.requestPolicy) return;
  delete body['reasoning_effort'];
}
