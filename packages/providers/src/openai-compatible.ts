import type { Request } from '@wrongstack/core';
import type { Capabilities, ReasoningEffort } from '@wrongstack/core';
import { capabilitiesForFamily } from './family-capabilities.js';
import { OpenAIProvider } from './openai.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';

export interface CompatibilityQuirks {
  stripCacheControl?: boolean | undefined;
  systemAsMessage?: boolean | undefined;
  flattenContentToString?: boolean | undefined;
  preserveToolCallIds?: boolean | undefined;
  parallelToolsDisabled?: boolean | undefined;
  jsonArgumentsBuggy?: boolean | undefined;
  emptyToolCallContent?: 'null' | 'empty_string' | undefined;
  thinkingParam?: 'zai-glm' | 'kimi-toggle' | 'always-on' | undefined;
}

const VALID_QUIRK_KEYS = new Set<keyof CompatibilityQuirks>([
  'stripCacheControl',
  'systemAsMessage',
  'flattenContentToString',
  'preserveToolCallIds',
  'parallelToolsDisabled',
  'jsonArgumentsBuggy',
  'emptyToolCallContent',
  'thinkingParam',
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

  protected override buildBody(req: Request): Record<string, unknown> {
    const body = super.buildBody(req);
    applyThinkingParams(body, req, this.opts.quirks?.thinkingParam);
    // #14: the base builder only emits `reasoning_effort` for the values real
    // OpenAI accepts (none/low/medium/high); the broader internal levels —
    // `minimal`, `xhigh`, `max` — were silently dropped, so picking `max` on a
    // generic compatible model (MiniMax, DeepSeek, …) sent no effort at all.
    applyGenericReasoningEffort(body, req, this.opts.quirks?.thinkingParam);
    // Many OpenAI-compatible servers (Together, Fireworks, DeepSeek, etc.)
    // accept the `top_k` parameter even though real OpenAI rejects it.
    if (req.topK !== undefined) body['top_k'] = req.topK;
    return body;
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    return {
      ...super.buildHeaders(req),
      ...this.extraHeaders,
    };
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

function mapZaiReasoningEffort(effort: NonNullable<Request['reasoning']>['effort']): string | undefined {
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
